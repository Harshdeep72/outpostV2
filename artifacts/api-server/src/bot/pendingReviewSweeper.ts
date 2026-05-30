import { sql } from "drizzle-orm";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { recheckRedditLiveness } from "./reddit-validator.js";
import { setupGuild } from "./setup.js";
import { logSubmissionEvent } from "../lib/sheetsLogger.js";
import { tryCompleteReferral } from "./db.js";

// Sweep every 30 min. We only act on rows older than AUTO_DECIDE_AFTER_MS,
// so the cadence just controls how soon after the 24h mark we make the call.
const TICK_MS = 30 * 60 * 1000;
const AUTO_DECIDE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h pending → re-check + decide
const STOP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;    // safety: never auto-touch rows older than 7d
const BATCH_SIZE = 25;
const AUTO_REVIEWER_SENTINEL = "auto-sweeper";

let started = false;
let isRunning = false;
let cachedClient: Client | null = null;

interface PendingRow extends Record<string, unknown> {
  id: string;
  claim_id: string;
  task_id: string;
  discord_id: string;
  proof_link: string;
  reward: string;
  log_message_id: string | null;
  pending_delay_hours: number;
  task_title: string;
  task_channel_message_id: string | null;
  task_status: string;
  task_slots_filled: number;
  task_max_slots: number;
  user_id: string;
  workspace_channel_id: string | null;
}

function isRedditUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("reddit.com");
  } catch {
    return false;
  }
}

async function editLogMessage(
  client: Client,
  logMessageId: string | null,
  recolor: (e: EmbedBuilder) => EmbedBuilder,
): Promise<void> {
  if (!logMessageId) return;
  for (const guild of client.guilds.cache.values()) {
    try {
      const { taskLogsChannel } = await setupGuild(guild);
      if (!(taskLogsChannel instanceof TextChannel)) continue;
      const msg = await taskLogsChannel.messages.fetch(logMessageId).catch(() => null);
      if (!msg || !msg.embeds[0]) continue;
      const updated = recolor(EmbedBuilder.from(msg.embeds[0]));
      await msg.edit({ embeds: [updated], components: [] });
      return; // found it in this guild, done
    } catch { /* try next guild */ }
  }
}

async function dmUser(client: Client, discordId: string, embed: EmbedBuilder) {
  try {
    const u = await client.users.fetch(discordId);
    await u.send({ embeds: [embed] });
  } catch (err) {
    logger.debug({ err, discordId }, "pending-sweeper: DM failed (DMs closed?)");
  }
}

function fmtMoney(n: string | number): string {
  const v = typeof n === "string" ? parseFloat(n) : n;
  return `$${v.toFixed(2)}`;
}

async function autoAccept(client: Client, row: PendingRow): Promise<boolean> {
  const availableAt = new Date(Date.now() + row.pending_delay_hours * 60 * 60 * 1000);
  // Atomic CAS — admin clicking Accept/Reject in Discord at the same instant
  // must win-or-lose cleanly without double-payout. WHERE review_status='pending'
  // gate ensures only one writer succeeds.
  const cas = await db.execute<{ id: number }>(
    sql`UPDATE submissions SET
            review_status = 'accepted',
            reviewer_discord_id = ${AUTO_REVIEWER_SENTINEL},
            review_reason = 'Auto-accepted by 24h sweeper: post is live on Reddit',
            reviewed_at = NOW(),
            available_at = ${availableAt},
            live_status = 'live',
            last_checked_at = NOW(),
            live_status_changed_at = NOW()
          WHERE id = ${parseInt(row.id)} AND review_status = 'pending'
          RETURNING id`,
  );
  if (cas.rows.length === 0) {
    logger.info({ subId: row.id }, "pending-sweeper: row already reviewed, skipping accept");
    return false;
  }

  // Credit pending balance + trust +2 (same as manual accept).
  await db.execute(
    sql`UPDATE claims SET status = 'accepted' WHERE id = ${parseInt(row.claim_id)}`,
  );
  await db.execute(
    sql`UPDATE users SET balance_pending = balance_pending + ${row.reward}::numeric,
                          last_task_completed_at = NOW()
          WHERE id = ${parseInt(row.user_id)}`,
  );
  await db.execute(
    sql`UPDATE users SET trust_score = GREATEST(0, trust_score + 2)
          WHERE id = ${parseInt(row.user_id)}`,
  );
  await db.execute(
    sql`INSERT INTO trust_logs (user_id, discord_id, delta, reason, related_submission_id, created_at)
          VALUES (${parseInt(row.user_id)}, ${row.discord_id}, 2,
                  'submission auto-accepted (24h sweeper)', ${parseInt(row.id)}, NOW())`,
  ).catch(() => { /* trust log is non-fatal */ });

  const unixAvail = Math.floor(availableAt.getTime() / 1000);
  await editLogMessage(client, row.log_message_id, (e) =>
    e.setColor(0x57f287).setFooter({
      text: `Auto-accepted by bot (24h re-check passed) — available in ${row.pending_delay_hours}h`,
    }),
  );
  await dmUser(
    client,
    row.discord_id,
    new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle("✅ Task Auto-Accepted (24h re-check)")
      .setDescription(
        `Your submission for **${row.task_title}** was re-checked after 24h and is live on Reddit — auto-accepted.\n\n` +
        `**${fmtMoney(row.reward)}** added to pending balance. Available <t:${unixAvail}:R>.`,
      ),
  );

  try { logSubmissionEvent(parseInt(row.id), "accepted"); } catch { /* swallowed */ }

  // Referral payout — if this is the user's first accepted task and they
  // were referred, credit $0.40 to the referrer + DM them. Manual accept
  // does this via handleReferralAndLeaderboard; without it here, auto-
  // accepted first tasks would silently rob referrers of their bonus.
  try {
    const ref = await tryCompleteReferral(row.discord_id, parseInt(row.user_id));
    if (ref.completed && ref.referrerDiscordId) {
      await dmUser(
        client,
        ref.referrerDiscordId,
        new EmbedBuilder()
          .setColor(0x57f287)
          .setTitle("🎉 Referral Completed!")
          .setDescription(
            "One of your referrals just completed their first task! " +
            "**+$0.40** has been added to your available balance.",
          ),
      );
    }
  } catch (err) {
    logger.warn({ err, subId: row.id }, "pending-sweeper: referral completion failed (non-fatal)");
  }

  logger.info({ subId: row.id, discordId: row.discord_id }, "pending-sweeper: auto-accepted");
  return true;
}

async function autoReject(client: Client, row: PendingRow, reason: string): Promise<boolean> {
  // Atomic CAS — see autoAccept for rationale.
  const cas = await db.execute<{ id: number }>(
    sql`UPDATE submissions SET
            review_status = 'rejected',
            reviewer_discord_id = ${AUTO_REVIEWER_SENTINEL},
            review_reason = ${'Auto-rejected by 24h sweeper: ' + reason},
            reviewed_at = NOW(),
            last_checked_at = NOW()
          WHERE id = ${parseInt(row.id)} AND review_status = 'pending'
          RETURNING id`,
  );
  if (cas.rows.length === 0) {
    logger.info({ subId: row.id }, "pending-sweeper: row already reviewed, skipping reject");
    return false;
  }

  await db.execute(
    sql`UPDATE claims SET status = 'rejected' WHERE id = ${parseInt(row.claim_id)}`,
  );
  // Free the slot — same as manual reject. NO trust penalty here: the worker
  // submitted in good faith and the post got filtered/removed by mod/automod;
  // we don't punish for that. Manual reject still applies admin's judgement.
  await db.execute(
    sql`UPDATE tasks SET slots_filled = GREATEST(0, slots_filled - 1) WHERE id = ${parseInt(row.task_id)}`,
  );

  // Refresh merge-mode campaign summary if this task is part of one.
  try {
    const cRow = await db.execute<{ campaign_id: number | null }>(
      sql`SELECT campaign_id FROM tasks WHERE id = ${parseInt(row.task_id)} LIMIT 1`
    );
    const cid = (cRow as any).rows?.[0]?.campaign_id;
    if (cid) {
      const { refreshCampaignSummary } = await import("./task-creation.js");
      void refreshCampaignSummary(Number(cid));
    }
  } catch { /* swallow */ }

  await editLogMessage(client, row.log_message_id, (e) =>
    e.setColor(0xed4245).setFooter({
      text: `Auto-rejected by bot (24h re-check) — ${reason}`,
    }),
  );
  await dmUser(
    client,
    row.discord_id,
    new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle("❌ Submission Auto-Rejected (24h re-check)")
      .setDescription(
        `Your submission for **${row.task_title}** was re-checked after 24h and the post is still not live on Reddit.\n\n` +
        `**Reason:** ${reason}\n\n` +
        `No trust penalty was applied. If the post comes back live, ask an admin to review manually.`,
      ),
  );

  try { logSubmissionEvent(parseInt(row.id), "rejected"); } catch { /* swallowed */ }
  logger.info({ subId: row.id, discordId: row.discord_id, reason }, "pending-sweeper: auto-rejected");
  return true;
}

async function tick(client: Client) {
  if (isRunning) {
    logger.info("pending-sweeper: previous tick still running, skipping");
    return;
  }
  isRunning = true;
  try {
    const decideCutoff = new Date(Date.now() - AUTO_DECIDE_AFTER_MS);
    const stopCutoff = new Date(Date.now() - STOP_AFTER_MS);

    const rows = await db.execute<PendingRow>(
      sql`SELECT s.id::text                          AS id,
                 s.claim_id::text                    AS claim_id,
                 s.task_id::text                     AS task_id,
                 s.discord_id                        AS discord_id,
                 s.proof_link                        AS proof_link,
                 s.reward::text                      AS reward,
                 s.log_message_id                    AS log_message_id,
                 s.user_id::text                     AS user_id,
                 t.pending_delay_hours               AS pending_delay_hours,
                 t.title                             AS task_title,
                 t.channel_message_id                AS task_channel_message_id,
                 t.status                            AS task_status,
                 t.slots_filled                      AS task_slots_filled,
                 t.max_slots                         AS task_max_slots,
                 u.workspace_channel_id              AS workspace_channel_id
            FROM submissions s
            JOIN tasks t ON t.id = s.task_id
            LEFT JOIN users u ON u.id = s.user_id
           WHERE s.review_status = 'pending'
             AND s.submitted_at <= ${decideCutoff}
             AND s.submitted_at >= ${stopCutoff}
           ORDER BY s.submitted_at ASC
           LIMIT ${BATCH_SIZE}`,
    );

    if (rows.rows.length === 0) return;
    logger.info({ count: rows.rows.length }, "pending-sweeper: re-checking batch");

    for (const row of rows.rows) {
      if (!isRedditUrl(row.proof_link)) {
        // Twitter / Quora / other — we can't auto-verify. Leave for manual review.
        logger.debug({ subId: row.id }, "pending-sweeper: non-reddit URL, leaving for manual");
        continue;
      }

      const result = await recheckRedditLiveness(row.proof_link).catch((err) => {
        logger.warn({ err, subId: row.id }, "pending-sweeper: recheck threw");
        return { liveStatus: "unknown" as const, reason: undefined };
      });

      if (result.liveStatus === "unknown") {
        // Transient — try again next tick. Don't decide on inconclusive data.
        logger.info({ subId: row.id }, "pending-sweeper: recheck inconclusive, will retry");
        continue;
      }

      if (result.liveStatus === "live") {
        await autoAccept(client, row);
      } else {
        // removed / deleted
        const reason = result.reason
          ? `${result.liveStatus} — ${result.reason}`
          : `post ${result.liveStatus} on Reddit`;
        await autoReject(client, row, reason);
      }

      // Polite gap between Reddit calls.
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    logger.error({ err }, "pending-sweeper: tick failed");
  } finally {
    isRunning = false;
  }
}

export function startPendingReviewSweeper(client: Client) {
  if (started) return;
  started = true;
  cachedClient = client;
  logger.info(
    { tickMs: TICK_MS, autoDecideAfterMs: AUTO_DECIDE_AFTER_MS, stopAfterMs: STOP_AFTER_MS },
    "Pending-review sweeper started (24h auto-decide)",
  );
  // Stagger first run so we don't pile on right after boot.
  setTimeout(() => void tick(client), 90_000);
  setInterval(() => void tick(client), TICK_MS).unref();
}

/** Run a single pass on demand (admin debug endpoint). */
export async function runPendingSweepNow(): Promise<{ ok: boolean; reason?: string }> {
  if (!cachedClient) return { ok: false, reason: "Pending-review sweeper not started yet" };
  await tick(cachedClient);
  return { ok: true };
}
