import { type ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { makeEmbed, formatMoney } from "../util.js";
import { COLORS } from "../constants.js";

interface PendingHoldRow {
  id: string;
  task_id: string;
  task_title: string;
  reward: string;
  proof_link: string;
  available_at: string;
  live_status: string;
  submitted_at: string;
  hold_hours: string;
}

export async function handleMyStatusCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const discordId = interaction.user.id;

  const rows = await db.execute<PendingHoldRow>(
    sql`SELECT
          s.id,
          s.task_id,
          t.title      AS task_title,
          s.reward,
          s.proof_link,
          s.available_at,
          s.live_status,
          s.submitted_at,
          t.pending_delay_hours AS hold_hours
        FROM submissions s
        JOIN tasks t ON t.id = s.task_id
        WHERE s.discord_id = ${discordId}
          AND s.review_status = 'pending_hold'
        ORDER BY s.available_at ASC
        LIMIT 10`
  );

  const pending = rows.rows;

  if (pending.length === 0) {
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.PRIMARY)
          .setTitle("📋 Your Active Submissions")
          .setDescription(
            "You have no submissions currently in the verification hold.\n\n" +
            "When you submit proof for a task, it will appear here during the hold period " +
            "so you can track when your reward will be paid out."
          ),
      ],
    });
  }

  const now = Date.now();

  const embed = new EmbedBuilder()
    .setColor(COLORS.WARNING)
    .setTitle("📋 Your Submissions In Hold")
    .setDescription(
      `You have **${pending.length}** submission${pending.length === 1 ? "" : "s"} in the verification hold period.\n` +
      `Keep your comments live — they are re-checked automatically when the hold ends.`
    )
    .setTimestamp(new Date());

  for (const row of pending) {
    const availTs = new Date(row.available_at).getTime();
    const msLeft = availTs - now;
    const unixAvail = Math.floor(availTs / 1000);

    const liveEmoji = row.live_status === "live" ? "✅" : row.live_status === "removed" ? "🛡️" : row.live_status === "deleted" ? "🗑️" : "❔";
    const liveLabel = row.live_status === "live" ? "Live" : row.live_status === "removed" ? "Removed" : row.live_status === "deleted" ? "Deleted" : "Unknown";

    const timeLeft = msLeft > 0
      ? `<t:${unixAvail}:R> (<t:${unixAvail}:f>)`
      : "⏰ Re-check imminent…";

    const shortProof = (() => {
      try {
        const u = new URL(row.proof_link);
        return u.hostname.replace("www.", "") + u.pathname.slice(0, 40) + (u.pathname.length > 40 ? "…" : "");
      } catch {
        return row.proof_link.slice(0, 50);
      }
    })();

    embed.addFields({
      name: `#${row.id} — ${row.task_title.slice(0, 40)}${row.task_title.length > 40 ? "…" : ""}`,
      value:
        `**Reward:** ${formatMoney(row.reward)}\n` +
        `**Status:** ${liveEmoji} ${liveLabel}\n` +
        `**Pays out:** ${timeLeft}\n` +
        `**Proof:** [${shortProof}](${row.proof_link})`,
      inline: false,
    });
  }

  const totalReward = pending.reduce((sum, r) => sum + parseFloat(r.reward), 0);
  embed.setFooter({
    text: `Total pending payout: ${formatMoney(totalReward.toFixed(2))} • Comment must stay live until the hold ends`,
  });

  return interaction.editReply({ embeds: [embed] });
}
