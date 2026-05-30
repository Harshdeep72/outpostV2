import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { type Client, type TextChannel, EmbedBuilder } from "discord.js";
import { logger } from "../lib/logger.js";
import { invalidateUser } from "./cache.js";
import { COLORS } from "./constants.js";
import { logSubmissionEvent } from "../lib/sheetsLogger.js";

let started = false;

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
      `**$${row.reward}** has moved from *pending* to your *available* balance and is now withdrawable.`
    )
    .setTimestamp(new Date());

  // DM the user.
  try {
    const user = await client.users.fetch(row.discord_id);
    await user.send({ embeds: [embed] });
  } catch (err) {
    logger.debug({ err, discordId: row.discord_id, submissionId: row.id }, "Pending processor: DM failed (DMs closed?)");
  }

  // Post in their workspace channel.
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

export function startPendingProcessor(client: Client) {
  if (started) return;
  started = true;

  setInterval(async () => {
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

        // ATOMIC CAS — flip moved_to_available 0→1 in a single statement
        // gated by the same condition we read above. Only if RETURNING gives
        // us a row do we credit balances + notify; otherwise some other tick
        // already processed this submission and crediting again would
        // double-pay (the prior version SELECT'd, UPDATE'd users, then
        // UPDATE'd submissions — a second tick running between the two
        // UPDATEs would re-credit total_earned + balance_available).
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

        // Lifetime Earnings (total_earned) is only credited HERE, when the
        // verify hold clears and money becomes spendable. Safe to run after
        // the CAS above because we're guaranteed to be the only worker that
        // won the moved_to_available 0→1 flip for this submission.
        await db.execute(
          sql`UPDATE users
              SET balance_pending   = GREATEST(0, balance_pending - ${row.reward}::numeric),
                  balance_available = balance_available + ${row.reward}::numeric,
                  total_earned      = total_earned + ${row.reward}::numeric
              WHERE id = ${userId}`
        );
        invalidateUser(row.discord_id, userId);

        // Mirror the payout event to Google Sheets (per-campaign URL or env
        // fallback). Fire-and-forget — never blocks the payout loop.
        logSubmissionEvent(subId, "paid");

        // Notify worker — DM + workspace channel. Non-fatal on failure.
        await notifySubmissionCleared(client, row);
      }

      if (rows.rows.length > 0) {
        logger.info({ count: rows.rows.length }, "Pending → available processed");
      }
    } catch (err) {
      logger.error({ err }, "Pending processor error");
    }
  }, 60_000);
}
