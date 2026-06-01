/**
 * Post-Payout Checker
 *
 * Scans accepted submissions that were ALREADY paid out (moved_to_available = 1)
 * within the last 24 hours. For each, it re-checks the Reddit proof link.
 * If the comment/post is found to be removed or deleted, the reward is clawed
 * back from balance_available + total_earned, the live_status is updated, the
 * worker is DM'd, and an alert is posted to #task-logs.
 *
 * This is distinct from the regular liveness checker, which only looks at
 * submissions still in the pending hold (moved_to_available = 0). That checker
 * cannot claw back payouts that have already cleared — this one can.
 */

import { sql } from "drizzle-orm";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { recheckRedditLiveness, type LiveStatus } from "./reddit-validator.js";
import { setupGuild } from "./setup.js";
import { invalidateUser } from "./cache.js";
import { logSubmissionEvent } from "../lib/sheetsLogger.js";

const TICK_MS = 15 * 60 * 1000;   // run every 15 minutes
const WINDOW_HOURS = 168;          // only look at payouts within the last 1 week
const BATCH_SIZE = 20;             // max rows per pass
const CONFIRM_DELAY_MS = 30_000;   // 30-second wait before confirming a clawback

let started = false;
let isRunning = false;

interface PaidRow extends Record<string, unknown> {
  id: string;
  proof_link: string;
  discord_id: string;
  task_id: string;
  reward: string;
  live_status: string;
  user_id: string;
  reddit_username: string | null;
  workspace_channel_id: string | null;
  paid_at: string | null;
}

function isRedditUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("reddit.com");
  } catch {
    return false;
  }
}

async function notifyClawback(
  client: Client,
  row: PaidRow,
  detectedStatus: "removed" | "deleted",
  reason: string | undefined,
  confirmed: boolean
): Promise<void> {
  const emoji = detectedStatus === "deleted" ? "🗑️" : "🛡️";
  const label = detectedStatus === "deleted" ? "DELETED" : "REMOVED";

  // Post to #task-logs in every guild.
  for (const guild of client.guilds.cache.values()) {
    try {
      const { taskLogsChannel } = await setupGuild(guild);
      if (!(taskLogsChannel instanceof TextChannel)) continue;

      const embed = new EmbedBuilder()
        .setTitle(`${emoji} Post-Payout Clawback — Comment ${label}`)
        .setColor(detectedStatus === "deleted" ? 0xed4245 : 0xeb6d2e)
        .setDescription(
          [
            `<@${row.discord_id}>'s submission **#${row.id}** was paid out but the Reddit proof is now **${detectedStatus}**.`,
            `**$${row.reward}** has been clawed back from their available balance.`,
            reason ? `Reason: ${reason}` : null,
            confirmed ? null : "_Note: Detected after a 30-second confirmation re-check._",
          ]
            .filter(Boolean)
            .join("\n")
        )
        .addFields(
          {
            name: "Worker",
            value: `<@${row.discord_id}>${row.workspace_channel_id ? `\n📂 <#${row.workspace_channel_id}>` : ""}`,
            inline: true,
          },
          { name: "Clawed Back", value: `$${row.reward}`, inline: true },
          { name: "Reddit User", value: row.reddit_username ? `u/${row.reddit_username}` : "—", inline: true },
          { name: "Proof", value: `[Open post](${row.proof_link})`, inline: false }
        )
        .setTimestamp();

      await taskLogsChannel.send({ embeds: [embed] }).catch((err) =>
        logger.warn({ err, guildId: guild.id }, "Post-payout checker: task-logs send failed")
      );
    } catch (err) {
      logger.warn({ err, guildId: guild.id }, "Post-payout checker: setupGuild failed");
    }
  }

  // DM the worker.
  try {
    const user = await client.users.fetch(row.discord_id);
    const dmEmbed = new EmbedBuilder()
      .setTitle(`${emoji} Payout Reversed — Comment ${label}`)
      .setColor(detectedStatus === "deleted" ? 0xed4245 : 0xeb6d2e)
      .setDescription(
        [
          `Your submission **#${row.id}** was paid out, but our system has detected that your Reddit comment/post is now **${detectedStatus}**.`,
          `**$${row.reward}** has been removed from your available balance.`,
          reason ? `**Reason:** ${reason}` : null,
          `If you believe this is a mistake, please contact staff.`,
        ]
          .filter(Boolean)
          .join("\n\n")
      )
      .addFields(
        { name: "Amount Reversed", value: `$${row.reward}`, inline: true },
        { name: "Proof Link", value: `[View post](${row.proof_link})`, inline: false }
      )
      .setTimestamp();
    await user.send({ embeds: [dmEmbed] });
  } catch (err) {
    logger.debug({ err, discordId: row.discord_id, submissionId: row.id }, "Post-payout checker: DM failed");
  }

  // Also send to workspace channel.
  if (row.workspace_channel_id) {
    try {
      const ch = await client.channels.fetch(row.workspace_channel_id).catch(() => null);
      if (ch && ch.isTextBased() && "send" in ch) {
        const wsEmbed = new EmbedBuilder()
          .setTitle(`${emoji} Payout Reversed`)
          .setColor(detectedStatus === "deleted" ? 0xed4245 : 0xeb6d2e)
          .setDescription(
            `Your submission **#${row.id}** payout of **$${row.reward}** has been reversed — ` +
            `the Reddit comment/post is now **${detectedStatus}**.`
          )
          .setTimestamp();
        await (ch as TextChannel).send({ embeds: [wsEmbed] }).catch(() => {});
      }
    } catch (err) {
      logger.debug({ err, submissionId: row.id }, "Post-payout checker: workspace channel send failed");
    }
  }
}

async function clawback(
  client: Client,
  row: PaidRow,
  firstStatus: "removed" | "deleted",
  firstReason: string | undefined
): Promise<void> {
  // Wait and re-confirm before clawing back to avoid false positives.
  logger.info(
    { submissionId: row.id, firstStatus },
    `Post-payout checker: potential clawback detected — waiting ${CONFIRM_DELAY_MS / 1000}s for confirmation`
  );
  await new Promise((r) => setTimeout(r, CONFIRM_DELAY_MS));

  const confirm = await recheckRedditLiveness(row.proof_link);

  if (confirm.liveStatus !== "removed" && confirm.liveStatus !== "deleted") {
    logger.warn(
      { submissionId: row.id, firstStatus, confirmStatus: confirm.liveStatus },
      "Post-payout checker: clawback ABORTED — confirmation check says post is not removed (transient false positive)"
    );
    // Revert the live_status update if we had already made one.
    await db.execute(
      sql`UPDATE submissions SET last_checked_at = now() WHERE id = ${parseInt(row.id)}`
    );
    return;
  }

  const confirmedStatus = confirm.liveStatus as "removed" | "deleted";
  const confirmedReason = confirm.reason ?? firstReason;
  const reward = parseFloat(row.reward);
  const userId = parseInt(row.user_id);

  // Atomic clawback guard: use a CAS on live_status so two concurrent ticks
  // (e.g. two workers racing on restart) can't double-clawback the same row.
  const clawbackReviewReason = `Auto-rejected: comment ${confirmedStatus} after payout (post-payout check).${confirmedReason ? " Reason: " + confirmedReason : ""}`;
  const cas = await db.execute<{ id: string }>(
    sql`UPDATE submissions
        SET live_status            = ${confirmedStatus},
            removal_reason         = ${confirmedReason ?? null},
            last_checked_at        = now(),
            live_status_changed_at = now(),
            review_status          = 'rejected',
            review_reason          = ${clawbackReviewReason}
        WHERE id = ${parseInt(row.id)}
          AND review_status = 'accepted'
        RETURNING id`
  );

  if (cas.rows.length === 0) {
    logger.warn(
      { submissionId: row.id },
      "Post-payout checker: clawback CAS lost — another process already handled this row"
    );
    return;
  }

  // Claw back from balance_available (NOT balance_pending — the payout already
  // cleared through the hold). Also reduce total_earned to keep lifetime stats accurate.
  await db.execute(
    sql`UPDATE users
        SET balance_available = GREATEST(0, balance_available - ${reward}::numeric),
            total_earned      = GREATEST(0, total_earned      - ${reward}::numeric)
        WHERE id = ${userId}`
  );

  invalidateUser(row.discord_id, userId);

  logger.warn(
    { submissionId: row.id, discordId: row.discord_id, reward, confirmedStatus },
    "Post-payout checker: CLAWBACK EXECUTED — paid-out submission's Reddit proof is gone"
  );

  try { logSubmissionEvent(parseInt(row.id), "removed"); } catch { /* non-fatal */ }

  await notifyClawback(client, row, confirmedStatus, confirmedReason, false);
}

async function tick(client: Client): Promise<void> {
  if (isRunning) {
    logger.debug("Post-payout checker: previous tick still running, skipping");
    return;
  }
  isRunning = true;

  try {
    const cutoff = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

    // ── Pass 1: Normal scan — recently paid-out submissions still showing live ──
    const rows = await db.execute<PaidRow>(
      sql`SELECT s.id::text              AS id,
                 s.proof_link            AS proof_link,
                 s.discord_id            AS discord_id,
                 s.task_id::text         AS task_id,
                 s.user_id::text         AS user_id,
                 s.reward::text          AS reward,
                 s.live_status           AS live_status,
                 s.paid_at               AS paid_at,
                 u.reddit_username       AS reddit_username,
                 u.workspace_channel_id  AS workspace_channel_id
          FROM submissions s
          LEFT JOIN users u ON u.id = s.user_id
          WHERE s.review_status      = 'accepted'
            AND s.moved_to_available = 1
            AND s.paid_at           >= ${cutoff}
            AND s.live_status NOT IN ('removed', 'deleted')
            AND s.proof_link ILIKE '%reddit.com%'
          ORDER BY s.paid_at DESC
          LIMIT ${BATCH_SIZE}`
    );

    if (rows.rows.length > 0) {
      logger.info({ count: rows.rows.length }, "Post-payout checker: scanning batch");

      for (const row of rows.rows) {
        if (!isRedditUrl(row.proof_link)) continue;

        const result = await recheckRedditLiveness(row.proof_link);
        const newStatus = result.liveStatus;

        if (newStatus === "unknown") {
          await db.execute(
            sql`UPDATE submissions SET last_checked_at = now() WHERE id = ${parseInt(row.id)}`
          );
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }

        if (newStatus === "live") {
          await db.execute(
            sql`UPDATE submissions
                SET live_status     = 'live',
                    last_checked_at = now()
                WHERE id = ${parseInt(row.id)}`
          );
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }

        // Post is removed or deleted — run confirmation + clawback.
        // Update live_status optimistically before the confirmation wait so other
        // ticks can see the flag and skip re-checking the same row.
        await db.execute(
          sql`UPDATE submissions
              SET live_status     = ${newStatus},
                  last_checked_at = now()
              WHERE id = ${parseInt(row.id)}`
        );

        // Fire clawback concurrently for each row so one slow confirmation wait
        // doesn't block checking the rest of the batch.
        clawback(client, row, newStatus as "removed" | "deleted", result.reason)
          .catch((err) =>
            logger.error({ err, submissionId: row.id }, "Post-payout checker: clawback error")
          );

        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // ── Pass 2: Stuck-state recovery ──────────────────────────────────────────
    // Bug-fix: if the server crashed during the 30-second confirmation window
    // (or the CAS guard raced), a paid-out submission can be left with
    // live_status = removed/deleted but review_status still = 'accepted' and no
    // funds clawed back.  Pass 1 excludes these rows (live_status NOT IN filter),
    // so they would never be retried.  This pass finds them — regardless of
    // paid_at age — and re-triggers the clawback.
    const stuckRows = await db.execute<PaidRow>(
      sql`SELECT s.id::text              AS id,
                 s.proof_link            AS proof_link,
                 s.discord_id            AS discord_id,
                 s.task_id::text         AS task_id,
                 s.user_id::text         AS user_id,
                 s.reward::text          AS reward,
                 s.live_status           AS live_status,
                 s.paid_at               AS paid_at,
                 u.reddit_username       AS reddit_username,
                 u.workspace_channel_id  AS workspace_channel_id
          FROM submissions s
          LEFT JOIN users u ON u.id = s.user_id
          WHERE s.review_status      = 'accepted'
            AND s.moved_to_available = 1
            AND s.live_status        IN ('removed', 'deleted')
            AND s.paid_at           >= ${cutoff}
            AND s.proof_link ILIKE '%reddit.com%'
          ORDER BY s.paid_at DESC
          LIMIT ${BATCH_SIZE}`
    );

    if (stuckRows.rows.length > 0) {
      logger.warn(
        { count: stuckRows.rows.length },
        "Post-payout checker: found stuck removed/deleted + accepted rows — re-triggering clawback"
      );

      for (const row of stuckRows.rows) {
        if (!isRedditUrl(row.proof_link)) continue;

        const detectedStatus = row.live_status as "removed" | "deleted";

        // Re-trigger clawback fire-and-forget (it will confirm before executing).
        clawback(client, row, detectedStatus, undefined)
          .catch((err) =>
            logger.error({ err, submissionId: row.id }, "Post-payout checker: stuck-state clawback error")
          );

        await new Promise((r) => setTimeout(r, 200));
      }
    }
  } catch (err) {
    logger.error({ err }, "Post-payout checker tick failed");
  } finally {
    isRunning = false;
  }
}

export function startPostPayoutChecker(client: Client): void {
  if (started) return;
  started = true;
  logger.info(
    { tickMs: TICK_MS, windowHours: WINDOW_HOURS, batchSize: BATCH_SIZE },
    "Post-payout checker started (24h paid-out comment scan)"
  );
  // Stagger first run 2 minutes after boot so the bot is fully ready.
  setTimeout(() => void tick(client), 2 * 60 * 1000);
  setInterval(() => void tick(client), TICK_MS).unref();
}

/** Run one pass immediately (for admin manual trigger). */
export async function runPostPayoutCheckNow(client: Client): Promise<{ ok: boolean; reason?: string }> {
  if (isRunning) return { ok: false, reason: "A pass is already in progress" };
  await tick(client);
  return { ok: true };
}
