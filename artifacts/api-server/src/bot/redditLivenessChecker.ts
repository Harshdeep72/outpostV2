import { sql } from "drizzle-orm";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { recheckRedditLiveness, type LiveStatus } from "./reddit-validator.js";
import { setupGuild } from "./setup.js";
import { logSubmissionEvent } from "../lib/sheetsLogger.js";

const TICK_MS = 12 * 60 * 60 * 1000;      // run every 12 hours
const RECHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // re-check each row no more than once per 12 hr
const MAX_AGE_DAYS = 14;                   // stop checking after 14 days
const BATCH_SIZE = 30;                     // max rows per pass

let started = false;
let isRunning = false;

interface SubmissionRow extends Record<string, unknown> {
  id: string;
  proof_link: string;
  discord_id: string;
  task_id: string;
  reward: string;
  live_status: LiveStatus;
  reddit_username: string | null;
  workspace_channel_id: string | null;
}

function isRedditUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("reddit.com");
  } catch {
    return false;
  }
}

function colorFor(status: LiveStatus): number {
  switch (status) {
    case "live": return 0x57f287;     // green
    case "removed": return 0xeb6d2e;  // orange
    case "deleted": return 0xed4245;  // red
    default: return 0x99aab5;          // grey
  }
}

function emojiFor(status: LiveStatus): string {
  switch (status) {
    case "live": return "✅";
    case "removed": return "🛡️";
    case "deleted": return "🗑️";
    default: return "❔";
  }
}

function titleFor(oldStatus: LiveStatus, newStatus: LiveStatus): string {
  if (newStatus === "live") {
    if (oldStatus === "unknown") return "✅ Submission APPROVED";
    return "✅ Submission RESTORED (back to live)";
  }
  if (newStatus === "removed") return "🛡️ Submission REMOVED";
  if (newStatus === "deleted") return "🗑️ Submission DELETED";
  return `${emojiFor(newStatus)} Submission ${newStatus.toUpperCase()}`;
}

async function notifyStatusChange(
  client: Client,
  row: SubmissionRow,
  oldStatus: LiveStatus,
  newStatus: LiveStatus,
  reason: string | undefined
) {
  // Only skip truly redundant same-status pings — all real transitions notify.

  for (const guild of client.guilds.cache.values()) {
    try {
      const { taskLogsChannel } = await setupGuild(guild);
      if (!(taskLogsChannel instanceof TextChannel)) continue;

      const embed = new EmbedBuilder()
        .setTitle(titleFor(oldStatus, newStatus))
        .setColor(colorFor(newStatus))
        .setDescription(
          [
            `<@${row.discord_id}>'s submission #${row.id} changed from **${oldStatus}** → **${newStatus}**.`,
            reason ? `Reason: ${reason}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        )
        .addFields(
          // Direct profile URL so the operator can always reach the
          // worker (DM, contact) even if the @mention above renders
          // as a raw ID and refuses to open on mobile.
          { name: "Worker", value: `<@${row.discord_id}>\n[💬 Open Profile / DM](https://discord.com/users/${row.discord_id})${row.workspace_channel_id ? `\n📂 Workspace: <#${row.workspace_channel_id}>` : ""}`, inline: true },
          { name: "Reward", value: `$${row.reward}`, inline: true },
          { name: "Reddit user", value: row.reddit_username ? `u/${row.reddit_username}` : "—", inline: true },
          { name: "Proof", value: `[Open post](${row.proof_link})`, inline: false }
        )
        .setTimestamp(new Date());

      await taskLogsChannel.send({ embeds: [embed] }).catch((err) => {
        logger.warn({ err, guildId: guild.id }, "Liveness checker: failed to post task-logs notification");
      });
    } catch (err) {
      logger.warn({ err, guildId: guild.id }, "Liveness checker: setupGuild failed");
    }
  }

  // DM the submitter when their post goes removed/deleted so they know what
  // happened to their submission. Embedded for readability. Wrapped in
  // try/catch so a closed-DM user never breaks the checker loop.
  try {
    const user = await client.users.fetch(row.discord_id);
    let dmTitle: string;
    let dmDesc: string[];
    if (newStatus === "live" && oldStatus === "unknown") {
      dmTitle = "✅ Submission Confirmed Live";
      dmDesc = [
        `Your submission **#${row.id}** has been verified as live on Reddit.`,
        `Your reward of **$${row.reward}** is on its way.`,
      ];
    } else if (newStatus === "live") {
      dmTitle = "✅ Submission Restored to Live";
      dmDesc = [
        `Good news — your submission **#${row.id}** is back live on Reddit after being ${oldStatus}.`,
        `Your reward of **$${row.reward}** is processing.`,
      ];
    } else {
      dmTitle = `${emojiFor(newStatus)} Your submission was ${newStatus}`;
      dmDesc = [
        `Your submission **#${row.id}** is no longer live on Reddit.`,
        reason ? `**Reason:** ${reason}` : null,
        `If this was unexpected, check the post on Reddit or reach out to staff.`,
      ].filter(Boolean) as string[];
    }
    const dmEmbed = new EmbedBuilder()
      .setTitle(dmTitle)
      .setColor(colorFor(newStatus))
      .setDescription(dmDesc.join("\n\n"))
      .addFields(
        { name: "Reward", value: `$${row.reward}`, inline: true },
        { name: "Reddit user", value: row.reddit_username ? `u/${row.reddit_username}` : "—", inline: true },
        { name: "Proof", value: `[Open post](${row.proof_link})`, inline: false }
      )
      .setTimestamp(new Date());
    await user.send({ embeds: [dmEmbed] });
  } catch (err) {
    logger.debug({ err, discordId: row.discord_id, submissionId: row.id }, "Liveness checker: DM to user failed (DMs closed?)");
  }
}

async function tick(client: Client) {
  if (isRunning) {
    logger.info("Reddit liveness: previous tick still running, skipping");
    return;
  }
  isRunning = true;
  try {
    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    const recheckCutoff = new Date(Date.now() - RECHECK_INTERVAL_MS);

    const rows = await db.execute<SubmissionRow>(
      sql`SELECT s.id::text          AS id,
                 s.proof_link        AS proof_link,
                 s.discord_id        AS discord_id,
                 s.task_id::text     AS task_id,
                 s.reward::text      AS reward,
                 s.live_status       AS live_status,
                 u.reddit_username   AS reddit_username,
                 u.workspace_channel_id AS workspace_channel_id
          FROM submissions s
          LEFT JOIN users u ON u.id = s.user_id
          WHERE s.review_status = 'accepted'
            AND s.moved_to_available = 0
            AND s.submitted_at >= ${cutoff}
            AND (s.last_checked_at IS NULL OR s.last_checked_at < ${recheckCutoff})
          ORDER BY s.last_checked_at ASC NULLS FIRST
          LIMIT ${BATCH_SIZE}`
    );

    if (rows.rows.length === 0) return;
    logger.info({ count: rows.rows.length }, "Reddit liveness: checking batch");

    for (const row of rows.rows) {
      if (!isRedditUrl(row.proof_link)) {
        // Mark as checked so we don't keep selecting it.
        await db.execute(
          sql`UPDATE submissions
              SET last_checked_at = now()
              WHERE id = ${parseInt(row.id)}`
        );
        continue;
      }

      const result = await recheckRedditLiveness(row.proof_link);
      const oldStatus = row.live_status as LiveStatus;
      const newStatus = result.liveStatus;

      if (newStatus === "unknown") {
        // Transient — only update last_checked so we'll try again later, don't flip status.
        await db.execute(
          sql`UPDATE submissions
              SET last_checked_at = now()
              WHERE id = ${parseInt(row.id)}`
        );
        continue;
      }

      if (newStatus === oldStatus) {
        await db.execute(
          sql`UPDATE submissions
              SET last_checked_at = now()
              WHERE id = ${parseInt(row.id)}`
        );
        continue;
      }

      // Status changed.
      await db.execute(
        sql`UPDATE submissions
            SET live_status = ${newStatus},
                last_checked_at = now(),
                live_status_changed_at = now(),
                removal_reason = ${result.reason ?? null}
            WHERE id = ${parseInt(row.id)}`
      );

      logger.info(
        {
          submissionId: row.id,
          discordId: row.discord_id,
          oldStatus,
          newStatus,
          reason: result.reason,
        },
        "Reddit liveness: status changed"
      );

      // Mirror live-status flips (especially live → removed/deleted) to the
      // accountant's Google Sheet so they can see exactly when a proof went
      // dark. Fire-and-forget — never blocks the liveness loop.
      if (newStatus === "removed" || newStatus === "deleted") {
        try { logSubmissionEvent(parseInt(row.id), "removed"); } catch { /* swallowed */ }
      }

      // PAYOUT REVERSAL: if the post was killed BEFORE the verify hold cleared
      // (i.e. before moved_to_available flipped to 1), claw the reward back
      // from balance_pending and ding trust score. The SELECT above already
      // filters out submissions where moved_to_available=1, so we know any row
      // we're processing is still pending and reversible.
      // total_earned is NOT decremented here because it's only credited when
      // funds move to available (which by definition hasn't happened yet for
      // the rows this checker selects). This keeps "Lifetime Earnings"
      // monotonically non-decreasing.
      //
      // ── False-positive guard ──────────────────────────────────────────────
      // Before clawing back money, wait 45 s then run one confirmation check.
      // A single bad proxy response, CAPTCHA interception, or transient Reddit
      // error must never trigger an irreversible financial action. We only
      // proceed if the second independent check agrees with the first.
      if ((newStatus === "removed" || newStatus === "deleted") && oldStatus === "live") {
        logger.info(
          { submissionId: row.id, newStatus },
          "Reddit liveness: potential reversal — waiting 45s for confirmation check"
        );
        await new Promise((r) => setTimeout(r, 45_000));
        const confirm = await recheckRedditLiveness(row.proof_link);
        if (confirm.liveStatus !== newStatus) {
          logger.warn(
            {
              submissionId: row.id,
              firstStatus: newStatus,
              confirmStatus: confirm.liveStatus,
            },
            "Reddit liveness: payout reversal ABORTED — confirmation check disagrees with first observation (likely transient false positive)"
          );
          // Update status to the confirmed result (or keep live if inconclusive).
          const safeStatus: typeof newStatus =
            confirm.liveStatus === "removed" || confirm.liveStatus === "deleted"
              ? confirm.liveStatus
              : newStatus; // keep newStatus only if confirm says same removal type
          // If confirmation says live or unknown, revert the DB status update too.
          if (confirm.liveStatus === "live" || confirm.liveStatus === "unknown") {
            await db.execute(
              sql`UPDATE submissions
                  SET live_status = ${oldStatus},
                      last_checked_at = now(),
                      removal_reason = NULL
                  WHERE id = ${parseInt(row.id)}`
            );
            logger.info({ submissionId: row.id, revertedTo: oldStatus }, "Reddit liveness: reverted status after false-positive detection");
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }
          // Both removal types differ (removed vs deleted) — use confirmation result.
          await db.execute(
            sql`UPDATE submissions
                SET live_status = ${safeStatus},
                    last_checked_at = now(),
                    removal_reason = ${confirm.reason ?? null}
                WHERE id = ${parseInt(row.id)}`
          );
        }
        const reward = parseFloat(row.reward);
        await db.execute(
          sql`UPDATE users
              SET balance_pending = GREATEST(0, balance_pending - ${reward}),
                  trust_score = GREATEST(0, trust_score - 0.05)
              WHERE discord_id = ${row.discord_id}`
        );
        // Mark the submission so the pending processor never releases it to
        // available, and so we stop checking it from now on.
        await db.execute(
          sql`UPDATE submissions
              SET moved_to_available = 1,
                  available_at = now()
              WHERE id = ${parseInt(row.id)}`
        );
        // trust_logs.delta is INTEGER NOT NULL and the table requires user_id.
        // The actual trust_score deduction (-0.05) is applied to the users row
        // above; the audit row records 0 with the precise loss in the reason
        // text so we never blow up on a type mismatch.
        const userIdRow = await db.execute<{ id: string }>(
          sql`SELECT id::text AS id FROM users WHERE discord_id = ${row.discord_id} LIMIT 1`
        );
        const userIdNum = userIdRow.rows[0]?.id ? parseInt(userIdRow.rows[0].id) : null;
        if (userIdNum != null) {
          await db.execute(
            sql`INSERT INTO trust_logs (user_id, discord_id, delta, reason, related_submission_id, created_at)
                VALUES (${userIdNum}, ${row.discord_id}, 0,
                        ${'Payout reversed (-0.05 trust): post ' + newStatus + ' before verify cleared'},
                        ${parseInt(row.id)}, now())`
          ).catch((err) => {
            logger.warn({ err, submissionId: row.id }, "Reddit liveness: trust_logs insert failed (non-fatal)");
          });
        }
        logger.warn(
          { submissionId: row.id, discordId: row.discord_id, reward, newStatus },
          "Reddit liveness: PAYOUT REVERSED (post killed before verify hold cleared)"
        );
      }

      await notifyStatusChange(client, row, oldStatus, newStatus, result.reason);

      // Brief pause between Reddit calls to be polite.
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (err) {
    logger.error({ err }, "Reddit liveness checker tick failed");
  } finally {
    isRunning = false;
  }
}

export function startRedditLivenessChecker(client: Client) {
  if (started) return;
  started = true;
  cachedClient = client;
  logger.info({ tickMs: TICK_MS, recheckMs: RECHECK_INTERVAL_MS }, "Reddit liveness checker started");

  // Stagger the first run so we don't pile on right after boot.
  setTimeout(() => void tick(client), 30_000);
  setInterval(() => void tick(client), TICK_MS).unref();
}

let cachedClient: Client | null = null;

/** Run a single liveness pass on demand. Used by the admin debug endpoint. */
export async function runLivenessTickNow(): Promise<{ ok: boolean; reason?: string }> {
  if (!cachedClient) return { ok: false, reason: "Liveness checker not started yet" };
  await tick(cachedClient);
  return { ok: true };
}
