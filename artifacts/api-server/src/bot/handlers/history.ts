import {
  type ChatInputCommandInteraction,
} from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { makeEmbed, formatMoney } from "../util.js";
import { COLORS } from "../constants.js";

const PAGE_SIZE = 8;

export async function handleTaskHistoryCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser("user") ?? interaction.user;
  const discordId = targetUser.id;

  const [tasksResult, statsResult] = await Promise.all([
    db.execute<{
      id: number;
      title: string;
      type: string;
      reward: string;
      status: string;
      slots_filled: number;
      max_slots: number;
      created_at: string;
      total: string;
    }>(
      sql`SELECT id, title, type, reward::text, status, slots_filled, max_slots, created_at,
                 COUNT(*) OVER ()::text as total
          FROM tasks
          WHERE creator_discord_id = ${discordId}
          ORDER BY created_at DESC
          LIMIT ${PAGE_SIZE}`
    ),
    db.execute<{
      total_tasks: string;
      open_tasks: string;
      total_slots: string;
      slots_filled: string;
      total_reward_value: string;
      completions: string;
    }>(
      sql`SELECT
            COUNT(*)::text AS total_tasks,
            COUNT(*) FILTER (WHERE status = 'open')::text AS open_tasks,
            COALESCE(SUM(max_slots), 0)::text AS total_slots,
            COALESCE(SUM(slots_filled), 0)::text AS slots_filled,
            COALESCE(SUM(reward * max_slots), 0)::text AS total_reward_value,
            (SELECT COUNT(*) FROM submissions s
             INNER JOIN tasks t ON t.id = s.task_id
             WHERE t.creator_discord_id = ${discordId}
               AND s.review_status = 'accepted')::text AS completions
          FROM tasks
          WHERE creator_discord_id = ${discordId}`
    ),
  ]);

  if (tasksResult.rows.length === 0) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.MUTED).setDescription(`📭 No tasks found created by <@${discordId}>.`)],
    });
  }

  const total = parseInt(tasksResult.rows[0]?.total ?? "0");
  const stats = statsResult.rows[0];

  const lines = tasksResult.rows.map((t: any) => {
    const statusIcon = t.status === "open" ? "🟢" : "🔴";
    const slotText = `${t.slots_filled}/${t.max_slots}`;
    const createdAt = Math.floor(new Date(t.created_at).getTime() / 1000);
    return `${statusIcon} **#${t.id}** — ${t.title.slice(0, 40)} | ${t.type} | ${formatMoney(t.reward)} | Slots: ${slotText} | <t:${createdAt}:d>`;
  });

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(`📊 Task History — ${targetUser.username}`)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Total Tasks Created", value: String(total), inline: true },
      { name: "Open Tasks", value: stats?.open_tasks ?? "0", inline: true },
      { name: "Completions by Users", value: stats?.completions ?? "0", inline: true },
      { name: "Total Slots", value: `${stats?.slots_filled ?? 0}/${stats?.total_slots ?? 0} filled`, inline: true },
      { name: "Total Reward Value", value: formatMoney(stats?.total_reward_value ?? "0"), inline: true },
    )
    .setFooter({ text: `Showing latest ${tasksResult.rows.length} of ${total} tasks` });

  await interaction.editReply({ embeds: [embed] });
}

export async function handlePayoutHistoryCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser("user") ?? interaction.user;
  const discordId = targetUser.id;

  const [rowsResult, totalsResult] = await Promise.all([
    db.execute<{
      id: number;
      task_id: number;
      reward: string;
      review_status: string;
      reviewed_at: string | null;
      submitted_at: string;
      available_at: string | null;
    }>(
      sql`SELECT id, task_id, reward::text, review_status, reviewed_at, submitted_at, available_at
          FROM submissions
          WHERE discord_id = ${discordId}
          ORDER BY submitted_at DESC NULLS LAST
          LIMIT ${PAGE_SIZE}`
    ),
    db.execute<{ accepted_count: string; total_earned: string; pending_count: string; pending_amount: string }>(
      sql`SELECT
            COUNT(*) FILTER (WHERE review_status = 'accepted')::text AS accepted_count,
            COALESCE(SUM(reward) FILTER (WHERE review_status = 'accepted'), 0)::text AS total_earned,
            COUNT(*) FILTER (WHERE review_status = 'pending')::text AS pending_count,
            COALESCE(SUM(reward) FILTER (WHERE review_status = 'pending'), 0)::text AS pending_amount
          FROM submissions
          WHERE discord_id = ${discordId}`
    ),
  ]);

  const totals = totalsResult.rows[0];

  if (rowsResult.rows.length === 0) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.MUTED).setDescription(`📭 No submission history found for <@${discordId}>.`)],
    });
  }

  const lines = rowsResult.rows.map((s: any) => {
    const icon =
      s.review_status === "accepted" ? "✅" :
      s.review_status === "rejected" ? "❌" :
      s.review_status === "flagged" ? "🚩" : "⏳";
    const submittedAt = Math.floor(new Date(s.submitted_at).getTime() / 1000);
    return `${icon} Sub **#${s.id}** | Task #${s.task_id} | ${formatMoney(s.reward)} | ${s.review_status} | <t:${submittedAt}:d>`;
  });

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(`💰 Payout History — ${targetUser.username}`)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Accepted Submissions", value: totals?.accepted_count ?? "0", inline: true },
      { name: "Lifetime Earnings", value: formatMoney(totals?.total_earned ?? "0"), inline: true },
      { name: "Pending Review", value: `${totals?.pending_count ?? 0} (${formatMoney(totals?.pending_amount ?? "0")})`, inline: true },
    )
    .setFooter({ text: `Showing latest ${rowsResult.rows.length} submissions` });

  await interaction.editReply({ embeds: [embed] });
}

export async function handleAdminPayoutHistoryCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser("user") ?? interaction.user;
  const discordId = targetUser.id;

  const [rowsResult, totalsResult] = await Promise.all([
    db.execute<{
      id: number;
      task_id: number;
      reward: string;
      review_status: string;
      reviewed_at: string | null;
      discord_id: string;
    }>(
      sql`SELECT id, task_id, reward::text, review_status, reviewed_at, discord_id
          FROM submissions
          WHERE reviewer_discord_id = ${discordId}
          ORDER BY reviewed_at DESC NULLS LAST
          LIMIT ${PAGE_SIZE}`
    ),
    db.execute<{ count: string; total: string }>(
      sql`SELECT COUNT(*)::text as count, COALESCE(SUM(reward), 0)::text as total
          FROM submissions
          WHERE reviewer_discord_id = ${discordId} AND review_status = 'accepted'`
    ),
  ]);

  const total = parseInt(totalsResult.rows[0]?.count ?? "0");
  const totalPaid = totalsResult.rows[0]?.total ?? "0.00";

  if (rowsResult.rows.length === 0) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.MUTED).setDescription(`📭 No reviewed submissions found for <@${discordId}>.`)],
    });
  }

  const lines = rowsResult.rows.map((s: any) => {
    const icon = s.review_status === "accepted" ? "✅" : s.review_status === "rejected" ? "❌" : "🏳";
    const reviewedAt = s.reviewed_at ? Math.floor(new Date(s.reviewed_at).getTime() / 1000) : null;
    const timeStr = reviewedAt ? `<t:${reviewedAt}:d>` : "N/A";
    return `${icon} Sub **#${s.id}** | Task #${s.task_id} | ${formatMoney(s.reward)} | Worker: <@${s.discord_id}> | ${timeStr}`;
  });

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(`📋 Admin Review History — ${targetUser.username}`)
    .setDescription(lines.join("\n"))
    .addFields(
      { name: "Total Reviewed (Accepted)", value: String(total), inline: true },
      { name: "Total Value Approved", value: formatMoney(totalPaid), inline: true },
    )
    .setFooter({ text: `Showing latest ${rowsResult.rows.length} reviews` });

  await interaction.editReply({ embeds: [embed] });
}
