import { sql } from "drizzle-orm";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { recheckRedditLiveness, parseRedditProofUrl, type LiveStatus } from "./reddit-validator.js";
import { setupGuild } from "./setup.js";
import { logSubmissionEvent } from "../lib/sheetsLogger.js";

const TICK_MS = 5 * 60 * 1000;            // run every 5 minutes
const RECHECK_INTERVAL_MS = 30 * 60 * 1000; // re-check each row no more than once per 30 min
const MAX_AGE_DAYS = 14;                   // stop checking after 14 days
const BATCH_SIZE = 30;                     // max rows per pass

/** How long to wait before running the early post-approval check. */
const EARLY_CHECK_DELAY_MS = 5 * 60 * 1000; // 5 minutes

let started = false;
let isRunning = false;

interface SubmissionRow extends Record<string, unknown> {
  id: string;
  proof_link: string;
  discord_id: string;
  task_id: string;
  reward: string;
  live_status: LiveStatus;
  moved_to_available?: number | string;
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

function titleFor(oldStatus: LiveStatus, newStatus: LiveStatus, isEarlyCheck = false): string {
  const prefix = isEarlyCheck ? "⚡ Early Check — " : "";
  if (newStatus === "live") {
    if (oldStatus === "unknown") return `${prefix}✅ Submission APPROVED`;
    return `${prefix}✅ Submission RESTORED (back to live)`;
  }
  if (newStatus === "removed") return `${prefix}🛡️ Submission REMOVED`;
  if (newStatus === "deleted") return `${prefix}🗑️ Submission DELETED`;
  return `${prefix}${emojiFor(newStatus)} Submission ${newStatus.toUpperCase()}`;
}

async function notifyStatusChange(
  client: Client,
  row: SubmissionRow,
  oldStatus: LiveStatus,
  newStatus: LiveStatus,
  reason: string | undefined,
  isEarlyCheck = false
) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const { taskLogsChannel } = await setupGuild(guild);
      if (!(taskLogsChannel instanceof TextChannel)) continue;

      const embed = new EmbedBuilder()
        .setTitle(titleFor(oldStatus, newStatus, isEarlyCheck))
        .setColor(colorFor(newStatus))
        .setDescription(
          [
            `<@${row.discord_id}>'s submission #${row.id} changed from **${oldStatus}** → **${newStatus}**.`,
            isEarlyCheck ? `_Detected by 5-minute early liveness check._` : null,
            reason ? `Reason: ${reason}` : null,
          ]
            .filter(Boolean)
            .join("\n")
        )
        .addFields(
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
        isEarlyCheck ? `This was detected shortly after your submission was approved.` : null,
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

// ---------------------------------------------------------------------------
// Shared reversal logic — used by both the 12-hour tick and the 5-min early
// check.  Waits 45 s then runs a confirmation check before clawing back money.
// Returns true if the reversal was executed, false if aborted (false positive).
// ---------------------------------------------------------------------------
async function performReversalWithConfirmation(
  client: Client,
  row: SubmissionRow,
  oldStatus: LiveStatus,
  firstDetectedStatus: "removed" | "deleted",
  firstReason: string | undefined,
  isEarlyCheck: boolean
): Promise<boolean> {
  logger.info(
    { submissionId: row.id, firstDetectedStatus, isEarlyCheck },
    "Reddit liveness: potential reversal — waiting 45s for confirmation check"
  );
  await new Promise((r) => setTimeout(r, 45_000));

  const confirm = await recheckRedditLiveness(row.proof_link);

  if (confirm.liveStatus !== firstDetectedStatus) {
    logger.warn(
      {
        submissionId: row.id,
        firstStatus: firstDetectedStatus,
        confirmStatus: confirm.liveStatus,
        isEarlyCheck,
      },
      "Reddit liveness: payout reversal ABORTED — confirmation check disagrees with first observation (likely transient false positive)"
    );

    const safeStatus: LiveStatus =
      confirm.liveStatus === "removed" || confirm.liveStatus === "deleted"
        ? confirm.liveStatus
        : firstDetectedStatus;

    if (confirm.liveStatus === "live" || confirm.liveStatus === "unknown") {
      await db.execute(
        sql`UPDATE submissions
            SET live_status = ${oldStatus},
                last_checked_at = now(),
                removal_reason = NULL
            WHERE id = ${parseInt(row.id)}`
      );
      logger.info({ submissionId: row.id, revertedTo: oldStatus }, "Reddit liveness: reverted status after false-positive detection");
      return false;
    }

    await db.execute(
      sql`UPDATE submissions
          SET live_status = ${safeStatus},
              last_checked_at = now(),
              removal_reason = ${confirm.reason ?? null}
          WHERE id = ${parseInt(row.id)}`
    );
  }

  // Confirmed removed/deleted — execute reversal.
  // Deduct from balance_pending first.  If the pending processor already moved
  // the reward to balance_available before this reversal ran, the overflow is
  // taken from balance_available (and total_earned is reduced to match).
  const reward = parseFloat(row.reward);
  await db.execute(
    sql`UPDATE users
        SET balance_pending   = GREATEST(0, balance_pending   - ${reward}::numeric),
            balance_available = GREATEST(0, balance_available - GREATEST(0, ${reward}::numeric - balance_pending)),
            total_earned      = GREATEST(0, total_earned      - GREATEST(0, ${reward}::numeric - balance_pending)),
            trust_score       = GREATEST(0, trust_score - 0.05)
        WHERE discord_id = ${row.discord_id}`
  );
  const removalReason = (firstReason ?? confirm.reason) ?? null;
  const reviewReason = `Auto-rejected: comment ${firstDetectedStatus}${isEarlyCheck ? " (detected by early 5-min check)" : ""}.${removalReason ? " Reason: " + removalReason : ""}`;
  await db.execute(
    sql`UPDATE submissions
        SET moved_to_available = 1,
            available_at       = COALESCE(available_at, now()),
            live_status        = ${firstDetectedStatus},
            removal_reason     = ${removalReason},
            review_status      = 'rejected',
            review_reason      = ${reviewReason}
        WHERE id = ${parseInt(row.id)}`
  );

  const userIdRow = await db.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM users WHERE discord_id = ${row.discord_id} LIMIT 1`
  );
  const userIdNum = userIdRow.rows[0]?.id ? parseInt(userIdRow.rows[0].id) : null;
  if (userIdNum != null) {
    await db.execute(
      sql`INSERT INTO trust_logs (user_id, discord_id, delta, reason, related_submission_id, created_at)
          VALUES (${userIdNum}, ${row.discord_id}, 0,
                  ${'Payout reversed (-0.05 trust): post ' + firstDetectedStatus + (isEarlyCheck ? ' (early check)' : '') + ' before verify cleared'},
                  ${parseInt(row.id)}, now())`
    ).catch((err) => {
      logger.warn({ err, submissionId: row.id }, "Reddit liveness: trust_logs insert failed (non-fatal)");
    });
  }

  logger.warn(
    { submissionId: row.id, discordId: row.discord_id, reward, firstDetectedStatus, isEarlyCheck },
    "Reddit liveness: PAYOUT REVERSED (post killed before verify hold cleared)"
  );

  try { logSubmissionEvent(parseInt(row.id), "removed"); } catch { /* swallowed */ }

  await notifyStatusChange(client, row, oldStatus, firstDetectedStatus, firstReason ?? confirm.reason, isEarlyCheck);

  return true;
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

      // Status changed — update DB.
      await db.execute(
        sql`UPDATE submissions
            SET live_status = ${newStatus},
                last_checked_at = now(),
                live_status_changed_at = now(),
                removal_reason = ${result.reason ?? null}
            WHERE id = ${parseInt(row.id)}`
      );

      logger.info(
        { submissionId: row.id, discordId: row.discord_id, oldStatus, newStatus, reason: result.reason },
        "Reddit liveness: status changed"
      );

      if (newStatus === "removed" || newStatus === "deleted") {
        try { logSubmissionEvent(parseInt(row.id), "removed"); } catch { /* swallowed */ }
      }

      if ((newStatus === "removed" || newStatus === "deleted") && oldStatus === "live") {
        await performReversalWithConfirmation(client, row, oldStatus, newStatus, result.reason, false);
      } else {
        await notifyStatusChange(client, row, oldStatus, newStatus, result.reason, false);
      }

      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (err) {
    logger.error({ err }, "Reddit liveness checker tick failed");
  } finally {
    isRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Early liveness check — scheduled immediately after auto-approval.
// Fires once after EARLY_CHECK_DELAY_MS (5 min) to catch workers who delete
// their comment right after getting auto-validated.
// ---------------------------------------------------------------------------

export interface EarlyCheckArgs {
  submissionId: number;
  proofLink: string;
  discordId: string;
  reward: string;
  redditUsername: string | null;
  workspaceChannelId: string | null;
  taskId: string;
}

async function runEarlyCheck(client: Client, args: EarlyCheckArgs): Promise<void> {
  logger.info({ submissionId: args.submissionId }, "Early liveness check: starting 5-min post-approval check");

  // Re-fetch submission to confirm it's still in a reversible state.
  // (The 12-hour checker or a manual action may have already processed it.)
  const fresh = await db.execute<{ review_status: string; moved_to_available: number; live_status: string }>(
    sql`SELECT review_status, moved_to_available, live_status
        FROM submissions
        WHERE id = ${args.submissionId}
        LIMIT 1`
  );
  const row = fresh.rows[0];
  if (!row) {
    logger.warn({ submissionId: args.submissionId }, "Early liveness check: submission not found, skipping");
    return;
  }
  if (row.review_status !== "accepted" || row.moved_to_available !== 0) {
    logger.info(
      { submissionId: args.submissionId, reviewStatus: row.review_status, movedToAvailable: row.moved_to_available },
      "Early liveness check: submission no longer in reversible state, skipping"
    );
    return;
  }

  if (!isRedditUrl(args.proofLink)) {
    logger.info({ submissionId: args.submissionId }, "Early liveness check: non-Reddit URL, skipping");
    return;
  }

  const result = await recheckRedditLiveness(args.proofLink);
  const oldStatus = row.live_status as LiveStatus;
  const newStatus = result.liveStatus;

  logger.info(
    { submissionId: args.submissionId, oldStatus, newStatus },
    "Early liveness check: result"
  );

  if (newStatus === "unknown") {
    // Transient — just bump last_checked_at; 12-hour checker will follow up.
    await db.execute(
      sql`UPDATE submissions SET last_checked_at = now() WHERE id = ${args.submissionId}`
    );
    return;
  }

  if (newStatus === oldStatus) {
    await db.execute(
      sql`UPDATE submissions SET last_checked_at = now() WHERE id = ${args.submissionId}`
    );
    logger.info({ submissionId: args.submissionId, status: newStatus }, "Early liveness check: still live, no action needed");
    return;
  }

  // Status changed — update DB immediately.
  await db.execute(
    sql`UPDATE submissions
        SET live_status = ${newStatus},
            last_checked_at = now(),
            live_status_changed_at = now(),
            removal_reason = ${result.reason ?? null}
        WHERE id = ${args.submissionId}`
  );

  logger.info(
    { submissionId: args.submissionId, discordId: args.discordId, oldStatus, newStatus, reason: result.reason },
    "Early liveness check: status changed"
  );

  if (newStatus === "removed" || newStatus === "deleted") {
    const syntheticRow: SubmissionRow = {
      id: String(args.submissionId),
      proof_link: args.proofLink,
      discord_id: args.discordId,
      task_id: args.taskId,
      reward: args.reward,
      live_status: oldStatus,
      reddit_username: args.redditUsername,
      workspace_channel_id: args.workspaceChannelId,
    };
    await performReversalWithConfirmation(client, syntheticRow, oldStatus, newStatus, result.reason, true);
  } else {
    // Went live→unknown or some other non-removal change — notify without reversal.
    const syntheticRow: SubmissionRow = {
      id: String(args.submissionId),
      proof_link: args.proofLink,
      discord_id: args.discordId,
      task_id: args.taskId,
      reward: args.reward,
      live_status: oldStatus,
      reddit_username: args.redditUsername,
      workspace_channel_id: args.workspaceChannelId,
    };
    await notifyStatusChange(client, syntheticRow, oldStatus, newStatus, result.reason, true);
  }
}

/**
 * Schedule a one-shot liveness check 5 minutes after a submission is
 * auto-approved, to catch workers who delete their comment immediately after
 * getting validated.  Safe to call fire-and-forget — uses the cached Discord
 * client and re-validates the submission state at check time.
 */
export function scheduleEarlyLivenessCheck(args: EarlyCheckArgs): void {
  setTimeout(() => {
    if (!cachedClient) {
      logger.warn({ submissionId: args.submissionId }, "Early liveness check: no Discord client cached, skipping");
      return;
    }
    runEarlyCheck(cachedClient, args).catch((err) => {
      logger.error({ err, submissionId: args.submissionId }, "Early liveness check: unhandled error");
    });
  }, EARLY_CHECK_DELAY_MS).unref();

  logger.info({ submissionId: args.submissionId, delayMs: EARLY_CHECK_DELAY_MS }, "Early liveness check: scheduled");
}

// ---------------------------------------------------------------------------
// On-demand single-submission check — called by /checksubmission command.
// ---------------------------------------------------------------------------

export interface SubmissionCheckResult {
  found: boolean;
  submissionId: number;
  proofLink: string | null;
  previousStatus: LiveStatus | null;
  newStatus: LiveStatus | null;
  statusChanged: boolean;
  isReversible: boolean;
  reversalTriggered: boolean;
  autoRejected: boolean;
  clawbackTriggered: boolean;
  reason: string | null;
  errorMessage: string | null;
}

interface FullSubmissionRow extends Record<string, unknown> {
  id: string;
  proof_link: string;
  discord_id: string;
  task_id: string;
  task_type: string;
  reward: string;
  live_status: string;
  review_status: string;
  moved_to_available: number;
  user_id: string | null;
  reddit_username: string | null;
  workspace_channel_id: string | null;
}

/**
 * Immediately re-checks a single submission by ID.
 * If the check finds it removed/deleted and the payout is still reversible,
 * the 45-second confirmation + reversal is fired in the background.
 * Returns a result object the Discord command handler can turn into an embed.
 */
export async function checkSubmissionNow(submissionId: number): Promise<SubmissionCheckResult> {
  const base: SubmissionCheckResult = {
    found: false, submissionId, proofLink: null,
    previousStatus: null, newStatus: null,
    statusChanged: false, isReversible: false,
    reversalTriggered: false, autoRejected: false, clawbackTriggered: false,
    reason: null, errorMessage: null,
  };

  const rows = await db.execute<FullSubmissionRow>(
    sql`SELECT s.id::text              AS id,
               s.proof_link            AS proof_link,
               s.discord_id            AS discord_id,
               s.task_id::text         AS task_id,
               s.user_id::text         AS user_id,
               s.reward::text          AS reward,
               s.live_status           AS live_status,
               s.review_status         AS review_status,
               s.moved_to_available    AS moved_to_available,
               t.type                  AS task_type,
               u.reddit_username       AS reddit_username,
               u.workspace_channel_id  AS workspace_channel_id
        FROM submissions s
        JOIN tasks t ON t.id = s.task_id
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ${submissionId}
        LIMIT 1`
  );

  const row = rows.rows[0];
  if (!row) return { ...base, errorMessage: `Submission #${submissionId} not found.` };

  if (!isRedditUrl(row.proof_link)) {
    return {
      ...base, found: true, proofLink: row.proof_link,
      errorMessage: "This submission's proof link is not a Reddit URL — nothing to check.",
    };
  }

  // Detect the "post URL submitted for a comment task" case.  The liveness
  // checker would otherwise see no commentId and treat it as a live post check.
  if (row.task_type === "comment") {
    const parsedProof = parseRedditProofUrl(row.proof_link);
    if (!parsedProof?.commentId) {
      return {
        ...base, found: true, proofLink: row.proof_link,
        previousStatus: row.live_status as LiveStatus,
        errorMessage:
          "This submission contains a Reddit **post** URL, not a comment link. " +
          "The worker submitted post-level proof for a comment task. " +
          "Manually reverse this submission — it should never have been approved.",
      };
    }
  }

  const previousStatus = row.live_status as LiveStatus;
  const reviewStatus = row.review_status;
  const movedToAvailable = Number(row.moved_to_available);
  // Reversible = accepted + not yet paid out (balance is still in balance_pending)
  const isReversible = reviewStatus === "accepted" && movedToAvailable === 0;

  const result = await recheckRedditLiveness(row.proof_link);
  const newStatus = result.liveStatus;

  // Always update last_checked_at. Only flip live_status if it changed and
  // wasn't just a transient unknown.
  if (newStatus !== "unknown" && newStatus !== previousStatus) {
    await db.execute(
      sql`UPDATE submissions
          SET live_status = ${newStatus},
              last_checked_at = now(),
              live_status_changed_at = now(),
              removal_reason = ${result.reason ?? null}
          WHERE id = ${submissionId}`
    );
    logger.info(
      { submissionId, previousStatus, newStatus, reason: result.reason },
      "checkSubmissionNow: status changed"
    );
  } else {
    await db.execute(
      sql`UPDATE submissions SET last_checked_at = now() WHERE id = ${submissionId}`
    );
  }

  let reversalTriggered = false;
  let autoRejected = false;
  let clawbackTriggered = false;

  if (newStatus === "removed" || newStatus === "deleted") {
    const reviewReason = `Auto-rejected by /checksubmission: comment ${newStatus}.${result.reason ? " Reason: " + result.reason : ""}`;

    // Reject the submission regardless of its current state.
    await db.execute(
      sql`UPDATE submissions
          SET review_status          = 'rejected',
              review_reason          = ${reviewReason},
              live_status            = ${newStatus},
              removal_reason         = ${result.reason ?? null},
              last_checked_at        = now(),
              live_status_changed_at = now()
          WHERE id = ${submissionId}`
    );
    autoRejected = true;

    // Was money actually credited for this submission?
    // Money is only ever added when review_status reaches 'accepted'.
    const moneyWasCredited = reviewStatus === "accepted";
    const reward = parseFloat(row.reward);
    const userId = parseInt(row.user_id ?? "0");

    if (moneyWasCredited && userId > 0) {
      if (movedToAvailable === 0) {
        // Funds are still in balance_pending — deduct from there.
        await db.execute(
          sql`UPDATE users
              SET balance_pending = GREATEST(0, balance_pending - ${reward}::numeric),
                  trust_score     = GREATEST(0, trust_score - 3)
              WHERE id = ${userId}`
        );
      } else {
        // Funds already moved to balance_available — claw back from there.
        await db.execute(
          sql`UPDATE users
              SET balance_available = GREATEST(0, balance_available - ${reward}::numeric),
                  total_earned      = GREATEST(0, total_earned - ${reward}::numeric),
                  trust_score       = GREATEST(0, trust_score - 3)
              WHERE id = ${userId}`
        );
      }
      clawbackTriggered = true;
      logger.warn(
        { submissionId, discordId: row.discord_id, reward, newStatus, movedToAvailable },
        "checkSubmissionNow: comment not live — funds clawed back + submission rejected"
      );
      try { logSubmissionEvent(submissionId, "removed"); } catch { /* non-fatal */ }
    } else {
      logger.warn(
        { submissionId, discordId: row.discord_id, newStatus, reviewStatus },
        "checkSubmissionNow: comment not live — submission rejected (no funds to claw back)"
      );
    }

    // Notify the user via DM + task-logs.
    if (cachedClient) {
      const notifyRow = {
        id: row.id, proof_link: row.proof_link,
        discord_id: row.discord_id, task_id: row.task_id,
        reward: row.reward, live_status: newStatus as LiveStatus,
        reddit_username: row.reddit_username,
        workspace_channel_id: row.workspace_channel_id,
      };

      // When money was already moved to available and is now clawed back,
      // send a specific DM so the user knows their available balance was reduced.
      if (clawbackTriggered && movedToAvailable === 1 && cachedClient) {
        const reward = parseFloat(row.reward);
        const statusLabel = newStatus === "deleted" ? "deleted" : "removed";
        const emoji = newStatus === "deleted" ? "🗑️" : "🛡️";
        const clawbackEmbed = new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle(`${emoji} Payout Reversed — Comment ${statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1)}`)
          .setDescription(
            [
              `Your submission **#${row.id}** was re-checked by a moderator and your comment was found **${statusLabel}**.`,
              ``,
              `**$${reward.toFixed(2)}** has been deducted from your available balance.`,
              result.reason ? `Reason: ${result.reason}` : null,
              ``,
              `Comments must remain live indefinitely to keep their reward. Deleting or having your comment removed after payout is a violation of the rules.`,
            ].filter((l) => l !== null).join("\n")
          )
          .addFields({ name: "Proof", value: `[Open Reddit post](${row.proof_link})`, inline: false })
          .setTimestamp(new Date());

        try {
          const discordUser = await cachedClient.users.fetch(row.discord_id);
          await discordUser.send({ embeds: [clawbackEmbed] });
        } catch {
          // DMs closed — fall through to workspace channel
        }

        try {
          if (row.workspace_channel_id) {
            const ch = await cachedClient.channels.fetch(row.workspace_channel_id).catch(() => null);
            if (ch && ch.isTextBased() && "send" in ch) {
              await (ch as TextChannel).send({ embeds: [clawbackEmbed] }).catch(() => {});
            }
          }
        } catch { /* non-fatal */ }
      }

      notifyStatusChange(cachedClient, notifyRow, previousStatus, newStatus, result.reason, false)
        .catch(() => {});
    }
  }

  return {
    found: true,
    submissionId,
    proofLink: row.proof_link,
    previousStatus,
    newStatus: newStatus === "unknown" ? null : newStatus,
    statusChanged: newStatus !== "unknown" && newStatus !== previousStatus,
    isReversible,
    reversalTriggered,
    autoRejected,
    clawbackTriggered,
    reason: result.reason ?? null,
    errorMessage: null,
  };
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

// ---------------------------------------------------------------------------
// Bulk all-time liveness scan — no age cutoff, no recheck interval filter.
// Checks every accepted submission currently showing live_status='live'.
// Fires in the background; the HTTP response returns immediately with a count.
// ---------------------------------------------------------------------------

let bulkScanRunning = false;

export interface BulkScanResult {
  ok: boolean;
  reason?: string;
  total: number;
  checked: number;
  removed: number;
  deleted: number;
}

export async function startBulkLivenessScanAllTime(): Promise<{ ok: boolean; reason?: string; total: number }> {
  if (!cachedClient) return { ok: false, reason: "Liveness checker not started yet", total: 0 };
  if (bulkScanRunning) return { ok: false, reason: "A bulk scan is already in progress", total: 0 };

  // Count how many we'll scan so the UI can show a meaningful message.
  const countRes = await db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n
        FROM submissions
        WHERE review_status = 'accepted'
          AND live_status = 'live'
          AND proof_link ILIKE '%reddit.com%'`
  );
  const total = parseInt(countRes.rows[0]?.n ?? "0");

  // Set the flag synchronously before launching the background task so the
  // status endpoint never sees a false-negative "not running" window.
  bulkScanRunning = true;

  // Fire the scan in the background without awaiting.
  runBulkScan(cachedClient, total).catch((err) => {
    logger.error({ err }, "Bulk liveness scan: unhandled top-level error");
    bulkScanRunning = false;
  });

  logger.info({ total }, "Bulk liveness scan: started in background");
  return { ok: true, total };
}

async function runBulkScan(client: Client, total: number): Promise<void> {
  // bulkScanRunning is already set to true by the caller.
  let checked = 0;
  let removed = 0;
  let deleted = 0;

  try {
    logger.info({ total }, "Bulk liveness scan: beginning full scan of all live accepted submissions");

    // Use cursor-style pagination by ID so we never need an extra DB column.
    // Each iteration fetches the next BATCH_SIZE rows with id > lastId.
    let lastId = 0;

    while (true) {
      const rows = await db.execute<SubmissionRow>(
        sql`SELECT s.id::text          AS id,
                   s.proof_link        AS proof_link,
                   s.discord_id        AS discord_id,
                   s.task_id::text     AS task_id,
                   s.reward::text      AS reward,
                   s.live_status       AS live_status,
                   s.moved_to_available AS moved_to_available,
                   u.reddit_username   AS reddit_username,
                   u.workspace_channel_id AS workspace_channel_id
            FROM submissions s
            LEFT JOIN users u ON u.id = s.user_id
            WHERE s.review_status = 'accepted'
              AND s.live_status = 'live'
              AND s.proof_link ILIKE '%reddit.com%'
              AND s.id > ${lastId}
            ORDER BY s.id ASC
            LIMIT ${BATCH_SIZE}`
      );

      if (rows.rows.length === 0) break;

      // Advance the cursor to the last ID we fetched.
      lastId = parseInt(rows.rows[rows.rows.length - 1].id);

      for (const row of rows.rows) {
        const result = await recheckRedditLiveness(row.proof_link);
        const oldStatus = row.live_status as LiveStatus;
        const newStatus = result.liveStatus;
        checked++;

        if (newStatus === "unknown") {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }

        if (newStatus === oldStatus) {
          await db.execute(
            sql`UPDATE submissions SET last_checked_at = now() WHERE id = ${parseInt(row.id)}`
          );
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }

        // Status changed — update DB.
        await db.execute(
          sql`UPDATE submissions
              SET live_status = ${newStatus},
                  last_checked_at = now(),
                  live_status_changed_at = now(),
                  removal_reason = ${result.reason ?? null}
              WHERE id = ${parseInt(row.id)}`
        );

        logger.info(
          { submissionId: row.id, discordId: row.discord_id, oldStatus, newStatus, reason: result.reason },
          "Bulk liveness scan: status changed"
        );

        if (newStatus === "removed") removed++;
        if (newStatus === "deleted") deleted++;

        if (newStatus === "removed" || newStatus === "deleted") {
          // Perform reversal with confirmation (45-second check + clawback).
          // Works whether the reward is still in balance_pending OR has already
          // been moved to balance_available by the pending processor.
          await performReversalWithConfirmation(client, row, oldStatus, newStatus, result.reason, false);
        } else {
          await notifyStatusChange(client, row, oldStatus, newStatus, result.reason, false);
        }

        // Courtesy delay to avoid hammering Reddit proxies.
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    logger.info({ total, checked, removed, deleted }, "Bulk liveness scan: completed");
  } catch (err) {
    logger.error({ err }, "Bulk liveness scan: failed");
  } finally {
    bulkScanRunning = false;
  }
}

/** Returns whether a bulk scan is currently in progress. */
export function isBulkScanRunning(): boolean {
  return bulkScanRunning;
}
