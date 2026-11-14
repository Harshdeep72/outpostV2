import { type ChatInputCommandInteraction } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { makeEmbed } from "../util.js";
import { COLORS } from "../constants.js";

export async function handleDropsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: 64 });

  const now = new Date();

  // Daily regular drop: ~17:30 IST (12:00 UTC)
  const todayUtc12 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
  const nextDailyUtc = now.getTime() > todayUtc12.getTime()
    ? new Date(todayUtc12.getTime() + 24 * 60 * 60 * 1000)
    : todayUtc12;
  const nextDailyUnix = Math.floor(nextDailyUtc.getTime() / 1000);

  // Check scheduled queue drops in db
  let scheduledInfo = "";
  try {
    const queueRows = await db.execute<{ total: string; earliest: Date | null }>(
      sql`SELECT COUNT(*)::text AS total, MIN(scheduled_at) AS earliest
          FROM campaign_queue
          WHERE status = 'pending' AND scheduled_at > NOW()`
    );
    const total = parseInt(queueRows.rows[0]?.total ?? "0");
    const earliest = queueRows.rows[0]?.earliest;
    if (total > 0 && earliest) {
      const scheduledUnix = Math.floor(new Date(earliest).getTime() / 1000);
      scheduledInfo = `\n\n🎯 **Upcoming Scheduled Drops:**\nThere are **${total}** task(s) currently queued! Next scheduled drop is <t:${scheduledUnix}:R> (<t:${scheduledUnix}:t>).`;
    }
  } catch (err) {
    // Non-fatal
  }

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle("📦 Daily Task Drop Schedule & Timings")
    .setDescription(
      `Tasks drop regularly every day so everyone has a fair chance to earn!${scheduledInfo}\n\n` +
      `🕒 **Standard Daily Drop:** Everyday around **~5:30 PM IST (12:00 PM UTC)**\n` +
      `⏳ **Next Expected Daily Drop:** <t:${nextDailyUnix}:R> (<t:${nextDailyUnix}:t> in your local time)\n\n` +
      `⚡ **Spontaneous Drops:** Advertisers drop new campaigns throughout the day between 10:00 AM – 11:00 PM IST.`
    )
    .addFields(
      {
        name: "🔔 How to Never Miss a Task",
        value:
          "1. **Enable Channel Notifications:** Right-click `#tasks` → **Notification Settings** → select **All Messages**.\n" +
          "2. **Verify Ahead of Time:** Make sure your Reddit account is linked and approved via `/verify` before drops arrive.\n" +
          "3. **Claim Speed:** Tasks are claimed in 2–5 minutes. Once you click **Claim Task**, you have a full **60-minute window** to review instructions, write your comment, and submit proof.",
        inline: false,
      },
      {
        name: "💼 Check Your Earnings & Hold Status",
        value:
          "• `/wallet` — View available balance, lifetime earnings, and payout dates.\n" +
          "• `/myhold` — Track your pending hold submissions and exact minute countdowns.",
        inline: false,
      }
    )
    .setFooter({ text: "Reddit Microtasks • Daily Drops" })
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
}
