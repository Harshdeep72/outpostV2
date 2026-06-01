import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { type Client, type TextChannel, EmbedBuilder } from "discord.js";
import { logger } from "../lib/logger.js";
import { invalidateUser } from "./cache.js";
import { COLORS } from "./constants.js";
import { logSubmissionEvent } from "../lib/sheetsLogger.js";
import { recheckRedditLiveness } from "./reddit-validator.js";
import { safeSyncEarnerRoles } from "./earnerRoles.js";
import { setupGuild } from "./setup.js";
import { getPrimaryGuild } from "./discord-client.js";

let started = false;

/**
 * Post an alert to #task-logs pinging the Admin role whenever a hold-end
 * liveness check is inconclusive and the submission is queued for manual
 * review. Ensures the case doesn't sit silently in the queue.
 */
async function notifyManualReview(
  row: { id: string; discord_id: string; reward: string; proof_link: string },
  reason: string
): Promise<void> {
  try {
    const guild = getPrimaryGuild();
    if (!guild) return;
    const { taskLogsChannel, adminRole } = await setupGuild(guild);
    const embed = new EmbedBuilder()
      .setColor(COLORS.WARNING)
      .setTitle("⚠️ Hold-End Check Inconclusive — Manual Review Required")
      .setDescription(
        [
          `Submission **#${row.id}** could not be automatically resolved at the end of its hold period.`,
          ``,
          `**Reason:** ${reason}`,
          ``,
          `Use \`/approvesubmission ${row.id}\` to credit the reward, or review the submission in the dashboard.`,
        ].join("\n")
      )
      .addFields(
        { name: "Worker", value: `<@${row.discord_id}>`, inline: true },
        { name: "Reward", value: `$${row.reward}`, inline: true },
        { name: "Proof", value: `[Open link](${row.proof_link})`, inline: false }
      )
      .setTimestamp(new Date());

    await (taskLogsChannel as TextChannel).send({
      content: `${adminRole} — submission needs a manual decision`,
      embeds: [embed],
    });
  } catch (err) {
    logger.warn({ err, submissionId: row.id }, "Pending processor: notifyManualReview failed (non-fatal)");
  }
}

/**
 * Post an informational alert to #task-logs when the confirmation check
 * overrides a false-positive "removed" first reading and pays out automatically.
 * Lets admins audit the system without requiring any action.
 */
async function notifyFalsePositiveOverride(
  row: { id: string; discord_id: string; reward: string; proof_link: string },
  firstDetected: string
): Promise<void> {
  try {
    const guild = getPrimaryGuild();
    if (!guild) return;
    const { taskLogsChannel } = await setupGuild(guild);
    const embed = new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setTitle("🔄 False-Positive Overridden — Auto Paid Out")
      .setDescription(
        [
          `Submission **#${row.id}** initially read as **${firstDetected}** at the end of its hold period,`,
          `but the 45-second confirmation check found it **live**. The first reading was a transient false positive.`,
          ``,
          `**$${row.reward}** has been credited automatically. No action needed.`,
        ].join("\n")
      )
      .addFields(
        { name: "Worker", value: `<@${row.discord_id}>`, inline: true },
        { name: "Reward", value: `$${row.reward}`, inline: true },
        { name: "Proof", value: `[Open link](${row.proof_link})`, inline: false }
      )
      .setTimestamp(new Date());

    await (taskLogsChannel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    logger.warn({ err, submissionId: row.id }, "Pending processor: notifyFalsePositiveOverride failed (non-fatal)");
  }
}

/**
 * Notify the worker (DM + their workspace channel) that their submission
 * cleared and the reward moved from pending → available. Wrapped in
 * try/catches so a closed DM or stale workspace channel can never break
 * the processor loop.
 */
async function notifySubmissionCleared(
  client: Client,
  row: { id: string; discord_id: string; reward: string }
): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(COLORS.SUCCESS)
    .setTitle("✅ Payout Cleared")
    .setDescription(
      `Your submission **#${row.id}** has cleared the verify hold.\n\n` +
      `**$${row.reward}** has been added to your *available* balance and is now withdrawable.`
    )
    .setTimestamp(new Date());

  try {
    const user = await client.users.fetch(row.discord_id);
    await user.send({ embeds: [embed] });
  } catch (err) {
    logger.debug({ err, discordId: row.discord_id, submissionId: row.id }, "Pending processor: DM failed (DMs closed?)");
  }

  try {
    const wsRow = await db.execute<{ workspace_channel_id: string | null }>(
      sql`SELECT workspace_channel_id FROM users WHERE discord_id = ${row.discord_id} LIMIT 1`
    );
    const wsId = wsRow.rows[0]?.workspace_channel_id;
    if (wsId) {
      const ch = await client.channels.fetch(wsId).catch(() => null);
      if (ch && ch.isTextBased() && "send" in ch) {
        await (ch as TextChannel).send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (err) {
    logger.debug({ err, discordId: row.discord_id, submissionId: row.id }, "Pending processor: workspace channel notify failed");
  }
}

/**
 * Notify the worker that their hold-end liveness re-check failed and their
 * submission has been rejected (comment was removed/deleted during hold).
 */
async function notifyHoldRejected(
  client: Client,
  row: { id: string; discord_id: string; reward: string; live_status: string }
): Promise<void> {
  const emoji = row.live_status === "deleted" ? "🗑️" : "🛡️";
  const statusLabel = row.live_status === "deleted" ? "deleted" : "removed";
  const embed = new EmbedBuilder()
    .setColor(COLORS.DANGER)
    .setTitle(`${emoji} Submission Rejected — Comment ${statusLabel.charAt(0).toUpperCase() + statusLabel.slice(1)}`)
    .setDescription(
      `Your submission **#${row.id}** did not pass the end-of-hold liveness check.\n\n` +
      `Your comment was found **${statusLabel}** when we re-verified it after the hold period. ` +
      `The reward of **$${row.reward}** has not been credited.\n\n` +
      `Comments must remain live throughout the entire hold period to qualify for payout.`
    )
    .setTimestamp(new Date());

  try {
    const user = await client.users.fetch(row.discord_id);
    await user.send({ embeds: [embed] });
  } catch (err) {
    logger.debug({ err, discordId: row.discord_id, submissionId: row.id }, "Pending processor: hold-reject DM failed");
  }

  try {
    const wsRow = await db.execute<{ workspace_channel_id: string | null }>(
      sql`SELECT workspace_channel_id FROM users WHERE discord_id = ${row.discord_id} LIMIT 1`
    );
    const wsId = wsRow.rows[0]?.workspace_channel_id;
    if (wsId) {
      const ch = await client.channels.fetch(wsId).catch(() => null);
      if (ch && ch.isTextBased() && "send" in ch) {
        await (ch as TextChannel).send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (err) {
    logger.debug({ err, discordId: row.discord_id, submissionId: row.id }, "Pending processor: hold-reject workspace notify failed");
  }
}

export function startPendingProcessor(client: Client) {
  if (started) return;
  started = true;

  setInterval(async () => {
    // -----------------------------------------------------------------------
    // Branch 1: accepted submissions — move balance_pending → balance_available
    // These were manually accepted by an admin (or accepted via the old flow).
    // -----------------------------------------------------------------------
    try {
      const now = new Date();
      const rows = await db.execute<{ id: string; user_id: string; reward: string; discord_id: string }>(
        sql`SELECT s.id, s.user_id, s.reward, s.discord_id
            FROM submissions s
            WHERE s.review_status = 'accepted' AND s.moved_to_available = 0 AND s.available_at <= ${now}
            LIMIT 50`
      );

      for (const row of rows.rows) {
        const userId = parseInt(row.user_id);
        const subId = parseInt(row.id);

        const claimed = await db.execute<{ id: string }>(
          sql`UPDATE submissions
                 SET moved_to_available = 1, paid_at = NOW()
               WHERE id = ${subId} AND moved_to_available = 0
               RETURNING id`
        );
        if (claimed.rows.length === 0) {
          logger.warn({ subId }, "Pending processor: submission already processed by another tick, skipping");
          continue;
        }

        await db.execute(
          sql`UPDATE users
              SET balance_pending   = GREATEST(0, balance_pending - ${row.reward}::numeric),
                  balance_available = balance_available + ${row.reward}::numeric,
                  total_earned      = total_earned + ${row.reward}::numeric
              WHERE id = ${userId}`
        );
        invalidateUser(row.discord_id, userId);
        logSubmissionEvent(subId, "paid");
        await notifySubmissionCleared(client, row);
      }

      if (rows.rows.length > 0) {
        logger.info({ count: rows.rows.length }, "Pending → available processed");
      }
    } catch (err) {
      logger.error({ err }, "Pending processor error (accepted branch)");
    }

    // -----------------------------------------------------------------------
    // Branch 2: pending_hold submissions — re-check Reddit at end of hold
    // These were auto-validated but not yet credited. The hold period ensures
    // the comment must remain live for the full duration before paying out.
    // -----------------------------------------------------------------------
    try {
      const now = new Date();
      const holdRows = await db.execute<{ id: string; user_id: string; reward: string; discord_id: string; proof_link: string }>(
        sql`SELECT s.id, s.user_id, s.reward, s.discord_id, s.proof_link
            FROM submissions s
            WHERE s.review_status = 'pending_hold' AND s.available_at <= ${now}
            LIMIT 20`
      );

      for (const row of holdRows.rows) {
        const subId = parseInt(row.id);
        const userId = parseInt(row.user_id);

        // Atomic claim — prevents two ticks from processing the same row.
        // We temporarily set review_status to 'checking' to lock it.
        const locked = await db.execute<{ id: string }>(
          sql`UPDATE submissions
                 SET review_status = 'checking'
               WHERE id = ${subId} AND review_status = 'pending_hold'
               RETURNING id`
        );
        if (locked.rows.length === 0) {
          logger.debug({ subId }, "Hold processor: already processing, skipping");
          continue;
        }

        logger.info({ subId, proofLink: row.proof_link }, "Hold processor: re-checking Reddit liveness after hold period");

        let liveness: Awaited<ReturnType<typeof recheckRedditLiveness>>;
        try {
          liveness = await recheckRedditLiveness(row.proof_link);
        } catch (err) {
          // Liveness check failed — fall back to manual review so no funds
          // are lost and no fraud slips through.
          logger.warn({ err, subId }, "Hold processor: liveness recheck threw, sending to manual review");
          await db.execute(
            sql`UPDATE submissions
                   SET review_status = 'pending',
                       review_reason  = 'Hold-end liveness check errored — needs manual review',
                       last_checked_at = NOW()
                 WHERE id = ${subId}`
          );
          void notifyManualReview(row, "Reddit API error during hold-end liveness check — could not determine comment status.");
          continue;
        }

        if (liveness.status === "live") {
          // Comment is still live — pay out now.
          // Funds were never in balance_pending for pending_hold rows, so we
          // credit balance_available and total_earned directly in one step.
          const accepted = await db.execute<{ id: string }>(
            sql`UPDATE submissions
                   SET review_status     = 'accepted',
                       moved_to_available = 1,
                       paid_at           = NOW(),
                       live_status       = 'live',
                       last_checked_at   = NOW(),
                       review_reason     = COALESCE(review_reason, '') || ' — hold cleared live'
                 WHERE id = ${subId} AND review_status = 'checking'
                 RETURNING id`
          );
          if (accepted.rows.length === 0) continue;

          await db.execute(
            sql`UPDATE users
                SET balance_available = balance_available + ${row.reward}::numeric,
                    total_earned      = total_earned + ${row.reward}::numeric,
                    trust_score       = LEAST(1000, trust_score + 2),
                    last_task_completed_at = NOW()
                WHERE id = ${userId}`
          );
          invalidateUser(row.discord_id, userId);
          safeSyncEarnerRoles(row.discord_id);
          logSubmissionEvent(subId, "paid");
          await notifySubmissionCleared(client, row);

          logger.info({ subId, discordId: row.discord_id, reward: row.reward }, "Hold processor: comment still live — payout issued");

        } else if (liveness.status === "unknown") {
          // Transient / inconclusive first reading — Reddit API blip, proxy
          // block, or AutoMod temporary filter window. Do NOT reject on a
          // single inconclusive result. Send to manual review so no valid
          // work is silently discarded.
          logger.warn({ subId, proofLink: row.proof_link }, "Hold processor: first check returned unknown — sending to manual review");
          await db.execute(
            sql`UPDATE submissions
                   SET review_status  = 'pending',
                       last_checked_at = NOW(),
                       review_reason  = 'Hold-end liveness check inconclusive (unknown) — needs manual review'
                 WHERE id = ${subId} AND review_status = 'checking'`
          );
          void notifyManualReview(row, "Hold-end liveness check returned an inconclusive result (Reddit API blip or proxy issue). Comment status could not be determined.");

        } else {
          // First check says removed or deleted. Run a 45-second confirmation
          // pass before making any permanent decision — a single bad reading
          // (transient AutoMod window, Reddit API inconsistency, proxy blip)
          // must never permanently reject a valid submission.
          const firstDetected = liveness.status === "deleted" ? "deleted" : "removed";
          const firstReason = liveness.reason;

          logger.warn(
            { subId, firstDetected, proofLink: row.proof_link },
            "Hold processor: first check says removed/deleted — waiting 45s for confirmation"
          );

          await new Promise((r) => setTimeout(r, 45_000));

          let confirmation: Awaited<ReturnType<typeof recheckRedditLiveness>>;
          try {
            confirmation = await recheckRedditLiveness(row.proof_link);
          } catch (err) {
            // Confirmation check threw — can't be certain. Manual review.
            logger.warn({ err, subId }, "Hold processor: confirmation check threw — sending to manual review");
            await db.execute(
              sql`UPDATE submissions
                     SET review_status  = 'pending',
                         last_checked_at = NOW(),
                         review_reason  = 'Hold-end liveness confirmation check errored — needs manual review'
                   WHERE id = ${subId} AND review_status = 'checking'`
            );
            void notifyManualReview(row, `First check found comment **${firstDetected}**; confirmation check errored — cannot determine final status.`);
            continue;
          }

          if (confirmation.status === "live") {
            // Confirmation says live — the first reading was a false positive
            // (transient remove / AutoMod temporary filter). Pay out.
            logger.info(
              { subId, discordId: row.discord_id, firstDetected },
              "Hold processor: confirmation check says LIVE — false positive detected, paying out"
            );

            const accepted = await db.execute<{ id: string }>(
              sql`UPDATE submissions
                     SET review_status     = 'accepted',
                         moved_to_available = 1,
                         paid_at           = NOW(),
                         live_status       = 'live',
                         last_checked_at   = NOW(),
                         review_reason     = ${'Hold cleared live (confirmation overrode transient ' + firstDetected + ' reading)'}
                   WHERE id = ${subId} AND review_status = 'checking'
                   RETURNING id`
            );
            if (accepted.rows.length === 0) continue;

            await db.execute(
              sql`UPDATE users
                  SET balance_available = balance_available + ${row.reward}::numeric,
                      total_earned      = total_earned + ${row.reward}::numeric,
                      trust_score       = LEAST(1000, trust_score + 2),
                      last_task_completed_at = NOW()
                  WHERE id = ${userId}`
            );
            invalidateUser(row.discord_id, userId);
            safeSyncEarnerRoles(row.discord_id);
            logSubmissionEvent(subId, "paid");
            await notifySubmissionCleared(client, row);
            void notifyFalsePositiveOverride(row, firstDetected);

          } else if (confirmation.status === "unknown") {
            // Both reads inconclusive enough that we can't be certain.
            // Manual review is the only safe outcome.
            logger.warn(
              { subId, firstDetected },
              "Hold processor: confirmation inconclusive — sending to manual review"
            );
            await db.execute(
              sql`UPDATE submissions
                     SET review_status  = 'pending',
                         live_status    = ${firstDetected},
                         last_checked_at = NOW(),
                         removal_reason = ${firstReason ?? null},
                         review_reason  = ${'Hold-end check inconclusive after confirmation (first: ' + firstDetected + ') — needs manual review'}
                   WHERE id = ${subId} AND review_status = 'checking'`
            );
            void notifyManualReview(row, `First check found comment **${firstDetected}**; confirmation check also inconclusive — cannot determine final status.`);

          } else {
            // Both reads agree: removed or deleted. Now it is safe to reject.
            const confirmedStatus = confirmation.status === "deleted" ? "deleted" : "removed";

            logger.warn(
              { subId, discordId: row.discord_id, confirmedStatus },
              "Hold processor: confirmed removed/deleted — rejecting submission"
            );

            await db.execute(
              sql`UPDATE submissions
                     SET review_status  = 'rejected',
                         live_status    = ${confirmedStatus},
                         last_checked_at = NOW(),
                         removal_reason = ${confirmation.reason ?? firstReason ?? null},
                         review_reason  = ${"Hold-end check (confirmed): comment " + confirmedStatus + " before hold cleared"}
                   WHERE id = ${subId} AND review_status = 'checking'`
            );

            // Trust deduction only on confirmed removal — not on transient
            // or inconclusive first reads.
            await db.execute(
              sql`UPDATE users
                  SET trust_score = GREATEST(0, trust_score - 3)
                  WHERE id = ${userId}`
            );
            invalidateUser(row.discord_id, userId);
            logSubmissionEvent(subId, "removed");
            await notifyHoldRejected(client, { ...row, live_status: confirmedStatus });
          }
        }
      }

      if (holdRows.rows.length > 0) {
        logger.info({ count: holdRows.rows.length }, "Hold processor: batch complete");
      }
    } catch (err) {
      logger.error({ err }, "Pending processor error (pending_hold branch)");
    }
  }, 60_000);
}
