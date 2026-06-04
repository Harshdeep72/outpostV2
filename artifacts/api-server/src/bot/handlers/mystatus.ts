import { type ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { makeEmbed, formatMoney } from "../util.js";
import { COLORS } from "../constants.js";

interface ActiveSubmissionRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  task_title: string;
  reward: string;
  proof_link: string;
  available_at: string | null;
  live_status: string;
  submitted_at: string;
  review_status: string;
  hold_hours: string;
}

export async function handleMyStatusCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const discordId = interaction.user.id;

  const rows = await db.execute<ActiveSubmissionRow>(
    sql`SELECT
          s.id,
          s.task_id,
          t.title      AS task_title,
          s.reward,
          s.proof_link,
          s.available_at,
          s.live_status,
          s.submitted_at,
          s.review_status,
          t.pending_delay_hours AS hold_hours
        FROM submissions s
        JOIN tasks t ON t.id = s.task_id
        WHERE s.discord_id = ${discordId}
          AND (
            s.review_status IN ('pending', 'pending_hold')
            OR (s.review_status = 'accepted' AND s.moved_to_available = 0)
          )
        ORDER BY s.submitted_at DESC
        LIMIT 15`
  );

  const active = rows.rows;

  if (active.length === 0) {
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.PRIMARY)
          .setTitle("📋 Your Active Submissions")
          .setDescription(
            "You have no active submissions right now.\n\n" +
            "When you submit proof for a task, it will appear here " +
            "so you can track its review status and payout timing."
          ),
      ],
    });
  }

  const now = Date.now();

  const embed = new EmbedBuilder()
    .setColor(COLORS.WARNING)
    .setTitle("📋 Your Active Submissions")
    .setDescription(
      `You have **${active.length}** active submission${active.length === 1 ? "" : "s"}.\n` +
      `Keep your comments live — they are checked automatically.`
    )
    .setTimestamp(new Date());

  for (const row of active) {
    const liveEmoji =
      row.live_status === "live" ? "✅" :
      row.live_status === "removed" ? "🛡️" :
      row.live_status === "deleted" ? "🗑️" : "❔";

    const liveLabel =
      row.live_status === "live" ? "Live" :
      row.live_status === "removed" ? "Removed" :
      row.live_status === "deleted" ? "Deleted" : "Unknown";

    let statusLine: string;
    let payoutLine = "";

    if (row.review_status === "pending") {
      statusLine = "🕐 Awaiting manual review";
    } else if (row.review_status === "pending_hold") {
      statusLine = `⏳ Pending — verification hold`;
      if (row.available_at) {
        const availTs = new Date(row.available_at).getTime();
        const msLeft = availTs - now;
        const unixAvail = Math.floor(availTs / 1000);
        payoutLine = msLeft > 0
          ? `\n**Pays out:** <t:${unixAvail}:R> (<t:${unixAvail}:f>)`
          : `\n**Pays out:** ⏰ Re-check imminent…`;
      }
    } else {
      // accepted, moved_to_available = 0
      statusLine = `${liveEmoji} ${liveLabel} — approved, payout pending`;
      if (row.available_at) {
        const availTs = new Date(row.available_at).getTime();
        const msLeft = availTs - now;
        const unixAvail = Math.floor(availTs / 1000);
        payoutLine = msLeft > 0
          ? `\n**Pays out:** <t:${unixAvail}:R> (<t:${unixAvail}:f>)`
          : `\n**Pays out:** ⏰ Processing soon…`;
      }
    }

    const shortProof = (() => {
      try {
        const u = new URL(row.proof_link);
        const path = u.pathname.slice(0, 40) + (u.pathname.length > 40 ? "…" : "");
        return u.hostname.replace("www.", "") + path;
      } catch {
        return row.proof_link.slice(0, 50);
      }
    })();

    const taskLabel = row.task_title.slice(0, 40) + (row.task_title.length > 40 ? "…" : "");

    embed.addFields({
      name: `#${row.id} — ${taskLabel}`,
      value:
        `**Reward:** ${formatMoney(row.reward)}\n` +
        `**Status:** ${statusLine}` +
        payoutLine +
        `\n**Proof:** [${shortProof}](${row.proof_link})`,
      inline: false,
    });
  }

  const totalReward = active.reduce((sum, r) => sum + parseFloat(r.reward), 0);
  embed.setFooter({
    text: `Total in-flight: ${formatMoney(totalReward.toFixed(2))} • Keep your comments live until paid out`,
  });

  return interaction.editReply({ embeds: [embed] });
}
