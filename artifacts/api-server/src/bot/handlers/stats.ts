import type { ChatInputCommandInteraction } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { makeEmbed, formatMoney, getISOWeekStart, smokyFooterText } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";

// Run a query and return its first row, or null on failure. The error is
// logged and surfaced via `errors[]` so /stats can render a partial embed
// instead of failing the entire command if a single sub-query breaks.
async function safeQuery<T>(label: string, errors: string[], runner: () => Promise<{ rows: T[] }>): Promise<T | null> {
  try {
    const res = await runner();
    return res.rows[0] ?? null;
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    logger.error({ err, label }, `/stats ${label} query failed`);
    errors.push(`${label}: ${msg}`);
    return null;
  }
}

export async function handleStatsCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const errors: string[] = [];
  const weekStart = getISOWeekStart();

  const [a, p, w, tw, ta] = await Promise.all([
    safeQuery<{ total_earned: string; total_tasks: string; verified: string; total_users: string }>(
      "users-aggregate", errors,
      () => db.execute<{ total_earned: string; total_tasks: string; verified: string; total_users: string }>(sql`
        SELECT
          COALESCE(SUM(total_earned), 0)::text AS total_earned,
          (SELECT COUNT(*)::text FROM submissions WHERE review_status = 'accepted') AS total_tasks,
          COUNT(*) FILTER (WHERE verified)::text AS verified,
          COUNT(*)::text AS total_users
        FROM users;
      `),
    ),
    safeQuery<{ total_paid: string }>(
      "withdrawals-paid", errors,
      () => db.execute<{ total_paid: string }>(sql`
        SELECT COALESCE(SUM(amount), 0)::text AS total_paid
          FROM withdrawals
          WHERE status = 'approved';
      `),
    ),
    safeQuery<{ week_total: string; week_count: string }>(
      "week-aggregate", errors,
      () => db.execute<{ week_total: string; week_count: string }>(sql`
        SELECT
          COALESCE(SUM(reward), 0)::text AS week_total,
          COUNT(*)::text AS week_count
        FROM submissions
        WHERE review_status = 'accepted' AND submitted_at >= ${weekStart};
      `),
    ),
    safeQuery<{ discord_id: string; reddit_username: string | null; week_earned: string }>(
      "top-week", errors,
      () => db.execute<{ discord_id: string; reddit_username: string | null; week_earned: string }>(sql`
        SELECT u.discord_id, u.reddit_username, COALESCE(SUM(s.reward), 0)::text AS week_earned
        FROM submissions s
        JOIN users u ON u.id = s.user_id
        WHERE s.review_status = 'accepted' AND s.submitted_at >= ${weekStart}
        GROUP BY u.discord_id, u.reddit_username
        ORDER BY SUM(s.reward) DESC
        LIMIT 1;
      `),
    ),
    safeQuery<{ discord_id: string; reddit_username: string | null; total: string }>(
      "top-alltime", errors,
      () => db.execute<{ discord_id: string; reddit_username: string | null; total: string }>(sql`
        SELECT discord_id, reddit_username, total_earned::text AS total
        FROM users
        WHERE total_earned > 0
        ORDER BY total_earned DESC
        LIMIT 1;
      `),
    ),
  ]);

  const topWeekStr = tw
    ? `<@${tw.discord_id}>${tw.reddit_username ? ` (u/${tw.reddit_username})` : ""} — **${formatMoney(tw.week_earned)}**`
    : "_No earnings this week yet_";
  const topAllStr = ta
    ? `<@${ta.discord_id}>${ta.reddit_username ? ` (u/${ta.reddit_username})` : ""} — **${formatMoney(ta.total)}**`
    : "_No earnings yet_";

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle("📊 Outpost Bot — Community Stats")
    .addFields(
      { name: "💰 Lifetime Earnings", value: formatMoney(a?.total_earned ?? "0"), inline: true },
      { name: "💸 Total Paid", value: formatMoney(p?.total_paid ?? "0"), inline: true },
      { name: "✅ Tasks Completed", value: a?.total_tasks ?? "0", inline: true },
      { name: "🔗 Verified Users", value: `${a?.verified ?? "0"} / ${a?.total_users ?? "0"}`, inline: true },
      { name: "📅 This Week", value: `${formatMoney(w?.week_total ?? "0")} (${w?.week_count ?? "0"} tasks)`, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "🏆 Top Earner This Week", value: topWeekStr },
      { name: "👑 All-Time #1", value: topAllStr },
    )
    .setFooter({ text: smokyFooterText("Stats refresh in real time") });

  // If something broke, show a generic notice in the public embed (don't leak
  // DB internals) and send the detailed error privately to the invoker as an
  // ephemeral follow-up so we can debug without exposing schema info.
  if (errors.length > 0) {
    embed.addFields({ name: "⚠️ Partial data", value: "_Some stats are temporarily unavailable. Admins have been notified._" });
  }

  await interaction.editReply({ embeds: [embed] });

  if (errors.length > 0) {
    const diag = errors.join(" | ").slice(0, 1800);
    await interaction
      .followUp({
        content: `🔧 **/stats diagnostics** (only you can see this):\n\`\`\`${diag}\`\`\``,
        ephemeral: true,
      })
      .catch((err) => logger.warn({ err }, "/stats failed to send ephemeral diagnostics"));
  }
}

