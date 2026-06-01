import { sql } from "drizzle-orm";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { validateRedditProof } from "./reddit-validator.js";
import { setupGuild } from "./setup.js";
import { logSubmissionEvent } from "../lib/sheetsLogger.js";
import { tryCompleteReferral } from "./db.js";

// Sweep every 30 min. We only act on rows older than AUTO_DECIDE_AFTER_MS,
// so the cadence just controls how soon after the 24h mark we make the call.
const TICK_MS = 30 * 60 * 1000;
const AUTO_DECIDE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h pending → re-check + decide
const STOP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;    // safety: never auto-touch rows older than 7d
const BATCH_SIZE = 100;
// Slow sweep: small batch + long delay between submissions so proxies don't get
// hammered and Reddit doesn't rate-limit mid-sweep. Safe for backlog clearance.
const SLOW_BATCH_SIZE = 5;
const SLOW_DELAY_MS = 3_000; // 3s between each submission check
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
  /** The target subreddit/post URL from the task (for full validation). */
  task_reddit_link: string;
  /** Task creation timestamp (for freshness check). */
  task_created_at: Date | null;
  /** Primary Reddit username for the user. */
  user_reddit_username: string | null;
  /** Task type (comment / post / upvote / etc.) — passed to validateRedditProof. */
  task_type: string;
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
  // Enforce 10-minute minimum hold so the early liveness check always fires
  // before the pending processor can release funds.
  const MIN_HOLD_MS = 10 * 60 * 1000;
  const availableAt = new Date(Math.max(
    Date.now() + row.pending_delay_hours * 60 * 60 * 1000,
    Date.now() + MIN_HOLD_MS
  ));
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

async function tick(client: Client, batchSize = BATCH_SIZE, delayMs = 500) {
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
                 t.reddit_link                       AS task_reddit_link,
                 t.created_at                        AS task_created_at,
                 t.type                              AS task_type,
                 u.workspace_channel_id              AS workspace_channel_id,
                 u.reddit_username                   AS user_reddit_username
            FROM submissions s
            JOIN tasks t ON t.id = s.task_id
            LEFT JOIN users u ON u.id = s.user_id
           WHERE s.review_status = 'pending'
             AND s.submitted_at <= ${decideCutoff}
             AND s.submitted_at >= ${stopCutoff}
           ORDER BY s.submitted_at ASC
           LIMIT ${batchSize}`,
    );

    if (rows.rows.length === 0) return;
    logger.info({ count: rows.rows.length }, "pending-sweeper: re-checking batch");

    for (const row of rows.rows) {
      if (!isRedditUrl(row.proof_link)) {
        // Twitter / Quora / other — we can't auto-verify. Leave for manual review.
        logger.debug({ subId: row.id }, "pending-sweeper: non-reddit URL, leaving for manual");
        continue;
      }

      // Build list of all Reddit usernames this Discord user has linked.
      // We check both the primary users.reddit_username and the reddit_accounts table.
      let expectedAuthors: string[] = [];
      if (row.user_reddit_username) {
        expectedAuthors.push(row.user_reddit_username.toLowerCase());
      }
      try {
        const extraAccounts = await db.execute<{ reddit_username: string }>(
          sql`SELECT reddit_username FROM reddit_accounts WHERE discord_id = ${row.discord_id}`
        );
        for (const acct of extraAccounts.rows) {
          const name = (acct.reddit_username ?? "").toLowerCase().trim();
          if (name && !expectedAuthors.includes(name)) expectedAuthors.push(name);
        }
      } catch (err) {
        logger.warn({ err, subId: row.id }, "pending-sweeper: failed to fetch reddit_accounts");
      }

      // Run full validation (author + subreddit + post + liveness).
      // This is the same check run at submission time — ensures backlog tasks
      // are verified with the same rigour as live submissions.
      const result = await validateRedditProof(
        row.proof_link,
        expectedAuthors,
        row.task_reddit_link ?? "",
        {
          taskCreatedAt: row.task_created_at ? new Date(row.task_created_at as any) : undefined,
          taskType: row.task_type,
        },
      ).catch((err) => {
        logger.warn({ err, subId: row.id }, "pending-sweeper: validateRedditProof threw");
        return null;
      });

      if (!result) {
        // Unexpected error — skip and retry next tick.
        logger.info({ subId: row.id }, "pending-sweeper: validation errored, will retry");
      } else if (result.status === "api_unreachable") {
        // Transient network failure — don't decide yet.
        logger.info({ subId: row.id }, "pending-sweeper: API unreachable (proxy blocked?), will retry");
      } else if (result.passed) {
        await autoAccept(client, row);
      } else {
        // Permanent failure — reject with the first failure message.
        const reason = result.failures[0] ?? result.statusLabel ?? `post ${result.status}`;
        await autoReject(client, row, reason);
      }

      // Polite gap between Reddit calls — configurable so slow sweep can use longer delay.
      await new Promise((r) => setTimeout(r, delayMs));
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

/** Run a single fast pass on demand (100 submissions, 500ms gap). */
export async function runPendingSweepNow(): Promise<{ ok: boolean; reason?: string }> {
  if (!cachedClient) return { ok: false, reason: "Pending-review sweeper not started yet" };
  await tick(cachedClient, BATCH_SIZE, 500);
  return { ok: true };
}

/**
 * Slow sweep — processes a small batch (5) with a 3-second delay between each
 * submission. Safe to call repeatedly to drain a backlog without hammering
 * Reddit and triggering proxy rate-limits.
 *
 * @param forceBacklog - if true, bypasses the 7-day STOP_AFTER_MS safety cutoff
 *   so very old stuck submissions are also processed. Use when clearing a backlog
 *   where some entries have been stuck for more than 7 days.
 *
 * Returns how many submissions were decided (accepted + rejected) in this pass,
 * plus diagnostic info for the UI.
 */
export async function runPendingSlowSweepNow(forceBacklog = false): Promise<{
  ok: boolean;
  decided: number;
  skipped: number;
  pendingTotal: number;
  pendingOutsideWindow: number;
  reason?: string;
}> {
  if (!cachedClient) return { ok: false, decided: 0, skipped: 0, pendingTotal: 0, pendingOutsideWindow: 0, reason: "Pending-review sweeper not started yet" };
  if (isRunning) return { ok: false, decided: 0, skipped: 0, pendingTotal: 0, pendingOutsideWindow: 0, reason: "A sweep is already running — wait a moment and try again" };
  isRunning = true;
  let decided = 0;
  let skipped = 0;
  try {
    const decideCutoff = new Date(Date.now() - AUTO_DECIDE_AFTER_MS);
    const stopCutoff   = forceBacklog ? new Date(0) : new Date(Date.now() - STOP_AFTER_MS);

    // Diagnostic: how many pending exist, and how many are outside this window?
    const diagResult = await db.execute<{ total: string; outside: string }>(
      sql`SELECT
            COUNT(*) FILTER (WHERE review_status = 'pending')::text AS total,
            COUNT(*) FILTER (
              WHERE review_status = 'pending'
                AND (submitted_at > ${decideCutoff} OR submitted_at < ${new Date(Date.now() - STOP_AFTER_MS)})
            )::text AS outside
          FROM submissions`
    );
    const pendingTotal = parseInt(diagResult.rows[0]?.total ?? "0");
    const pendingOutsideWindow = parseInt(diagResult.rows[0]?.outside ?? "0");

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
                 t.reddit_link                       AS task_reddit_link,
                 t.created_at                        AS task_created_at,
                 t.type                              AS task_type,
                 u.workspace_channel_id              AS workspace_channel_id,
                 u.reddit_username                   AS user_reddit_username
            FROM submissions s
            JOIN tasks t ON t.id = s.task_id
            LEFT JOIN users u ON u.id = s.user_id
           WHERE s.review_status = 'pending'
             AND s.submitted_at <= ${decideCutoff}
             AND s.submitted_at >= ${stopCutoff}
           ORDER BY s.submitted_at ASC
           LIMIT ${SLOW_BATCH_SIZE}`,
    );
    if (rows.rows.length === 0) return { ok: true, decided: 0, skipped: 0, pendingTotal, pendingOutsideWindow };
    logger.info({ count: rows.rows.length, forceBacklog }, "pending-sweeper(slow): processing batch");

    for (const row of rows.rows) {
      if (!isRedditUrl(row.proof_link)) {
        skipped++;
        continue;
      }
      let expectedAuthors: string[] = [];
      if (row.user_reddit_username) expectedAuthors.push(row.user_reddit_username.toLowerCase());
      try {
        const extra = await db.execute<{ reddit_username: string }>(
          sql`SELECT reddit_username FROM reddit_accounts WHERE discord_id = ${row.discord_id}`
        );
        for (const acct of extra.rows) {
          const n = (acct.reddit_username ?? "").toLowerCase().trim();
          if (n && !expectedAuthors.includes(n)) expectedAuthors.push(n);
        }
      } catch { /* non-fatal */ }

      const result = await validateRedditProof(
        row.proof_link,
        expectedAuthors,
        row.task_reddit_link ?? "",
        {
          taskCreatedAt: row.task_created_at ? new Date(row.task_created_at as any) : undefined,
          taskType: row.task_type,
        },
      ).catch((err) => {
        logger.warn({ err, subId: row.id }, "pending-sweeper(slow): validateRedditProof threw");
        return null;
      });

      if (!result || result.status === "api_unreachable") {
        skipped++;
        logger.info({ subId: row.id }, "pending-sweeper(slow): inconclusive, skipped");
      } else if (result.passed) {
        await autoAccept(cachedClient!, row);
        decided++;
      } else {
        const reason = result.failures[0] ?? result.statusLabel ?? `post ${result.status}`;
        await autoReject(cachedClient!, row, reason);
        decided++;
      }

      // Long gap — lets proxies cool down before hitting Reddit again.
      await new Promise((r) => setTimeout(r, SLOW_DELAY_MS));
    }
    return { ok: true, decided, skipped, pendingTotal, pendingOutsideWindow };
  } catch (err) {
    logger.error({ err }, "pending-sweeper(slow): failed");
    return { ok: false, decided, skipped, pendingTotal: 0, pendingOutsideWindow: 0, reason: String(err) };
  } finally {
    isRunning = false;
  }
}
