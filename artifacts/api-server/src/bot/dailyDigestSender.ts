import { type Client, EmbedBuilder } from "discord.js";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { COLORS } from "./constants.js";
import { formatMoney } from "./util.js";

/**
 * Daily DM digest (feature #1). Opt-in only.
 *
 * Cron runs every 30 minutes. For each opted-in user whose last digest was
 * sent > 23h ago (or never), build a 24h summary and DM it. last_sent_at is
 * updated *before* the DM send to avoid duplicate sends if the cron lap takes
 * longer than expected — at worst we miss a digest, never spam.
 *
 * DM failures (closed DMs, blocked bot, etc.) are caught silently per user.
 *
 * Per-tick cap: MAX_PER_TICK to avoid rate-limit spikes; remaining users get
 * picked up on the next tick.
 */
const TICK_MS = 30 * 60 * 1000; // 30 minutes
const MIN_GAP_HOURS = 23;
const MAX_PER_TICK = 50;

export function startDailyDigest(client: Client): void {
  const tick = async () => {
    try {
      await runDigestTick(client);
    } catch (err) {
      logger.error({ err }, "dailyDigest tick failed");
    }
  };
  // First tick after 2 min so boot has settled.
  setTimeout(() => { tick(); setInterval(tick, TICK_MS).unref(); }, 2 * 60 * 1000).unref();
  logger.info("Daily digest scheduler started");
}

async function runDigestTick(client: Client): Promise<void> {
  const candidates = await pool.query(
    `SELECT discord_id
       FROM users
      WHERE daily_digest_optin = true
        AND (daily_digest_last_sent_at IS NULL
             OR daily_digest_last_sent_at < NOW() - INTERVAL '${MIN_GAP_HOURS} hours')
      ORDER BY daily_digest_last_sent_at NULLS FIRST
      LIMIT $1`,
    [MAX_PER_TICK],
  );
  if (candidates.rowCount === 0) return;

  // Count of new open tasks (last 24h) — shared across all DMs in this tick.
  const newTasksRes = await pool.query(
    `SELECT COUNT(*)::int AS c
       FROM tasks
      WHERE created_at > NOW() - INTERVAL '24 hours'
        AND status = 'open'`,
  );
  const newTasksCount: number = newTasksRes.rows[0]?.c ?? 0;

  for (const row of candidates.rows) {
    const discordId: string = row.discord_id;
    try {
      // Reserve the slot BEFORE sending so a transient failure doesn't loop us.
      await pool.query(
        `UPDATE users SET daily_digest_last_sent_at = NOW() WHERE discord_id = $1`,
        [discordId],
      );

      const stats = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE review_status = 'accepted' AND reviewed_at > NOW() - INTERVAL '24 hours')        AS accepted_24h,
           COUNT(*) FILTER (WHERE review_status = 'rejected' AND reviewed_at > NOW() - INTERVAL '24 hours')        AS rejected_24h,
           COUNT(*) FILTER (WHERE review_status = 'pending')                                                       AS pending_total,
           COALESCE(SUM(reward) FILTER (WHERE review_status = 'accepted' AND reviewed_at > NOW() - INTERVAL '24 hours'), 0) AS earned_24h
         FROM submissions WHERE discord_id = $1`,
        [discordId],
      );
      const bal = await pool.query(
        `SELECT balance_available, balance_pending FROM users WHERE discord_id = $1`,
        [discordId],
      );
      const s = stats.rows[0] ?? {};
      const b = bal.rows[0] ?? {};

      const earned = Number(s.earned_24h ?? 0);
      const accepted = Number(s.accepted_24h ?? 0);
      const rejected = Number(s.rejected_24h ?? 0);
      const pending = Number(s.pending_total ?? 0);

      // Skip the DM entirely if there's nothing notable to report — keeps
      // the inbox quiet for inactive users while keeping them opted in.
      if (earned === 0 && accepted === 0 && rejected === 0 && pending === 0 && newTasksCount === 0) {
        continue;
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS.PRIMARY)
        .setTitle("📬 Your daily Outpost digest")
        .setDescription(`Here's what happened in the last 24 hours.`)
        .addFields(
          { name: "💰 Earned (24h)", value: formatMoney(earned.toFixed(2)), inline: true },
          { name: "✅ Accepted", value: String(accepted), inline: true },
          { name: "❌ Rejected", value: String(rejected), inline: true },
          { name: "⏳ Pending review", value: String(pending), inline: true },
          { name: "🆕 New tasks available", value: String(newTasksCount), inline: true },
          { name: "💵 Balance available", value: formatMoney(b.balance_available ?? "0.00"), inline: true },
        )
        .setFooter({ text: "Stop these DMs anytime with /digest off" })
        .setTimestamp(new Date());

      const user = await client.users.fetch(discordId);
      await user.send({ embeds: [embed] });
      logger.info({ discordId, earned, accepted }, "Daily digest sent");
    } catch (err: any) {
      // Common failures: 50007 (cannot DM), user not found. Log at debug to
      // keep noise down; we already updated last_sent so we won't retry today.
      logger.debug({ err: err?.code ?? err?.message, discordId }, "Daily digest DM failed");
    }
  }
}
