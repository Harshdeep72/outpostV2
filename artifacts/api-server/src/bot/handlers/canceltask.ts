import { type ChatInputCommandInteraction } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { tasks, claims, campaigns } from "@workspace/db";
import { eq } from "drizzle-orm";
import { makeEmbed, formatMoney, hasAdminRole, hasModRole } from "../util.js";
import { COLORS } from "../constants.js";
import { invalidateTask, invalidateClaim } from "../cache.js";
import { setupGuild } from "../setup.js";
import { logger } from "../../lib/logger.js";

export async function handleCancelTaskCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  const member = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(member, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can cancel tasks.")] });
  }

  const taskId = interaction.options.getInteger("task_id", true);
  const reason = interaction.options.getString("reason") ?? "Cancelled by admin";

  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const task = taskRows[0];
  if (!task) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Task #${taskId} not found.`)] });
  }
  if (task.status === "closed") {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.WARNING).setDescription(`⚠️ Task #${taskId} is already closed.`)] });
  }

  await db.update(tasks).set({ status: "closed" }).where(eq(tasks.id, taskId));
  invalidateTask(taskId);

  const expiredClaims = await db.execute<{ id: number; discord_id: string; workspace_message_id: string | null }>(
    sql`UPDATE claims SET status = 'expired' WHERE task_id = ${taskId} AND status = 'claimed' RETURNING id, discord_id, workspace_message_id`
  );

  for (const c of expiredClaims.rows) {
    invalidateClaim(c.id);
    try {
      const u = await guild.client.users.fetch(c.discord_id);
      await u.send({
        embeds: [
          makeEmbed(COLORS.WARNING)
            .setTitle("⚠️ Task Cancelled")
            .setDescription(`**Task #${taskId}** was cancelled by an admin. Your claim has been released.\n\n**Reason:** ${reason}`)
        ],
      });
    } catch {
      logger.warn({ discordId: c.discord_id }, "Could not DM user about cancelled task");
    }

    // Lock the user's workspace embed for this claim so the Submit Proof
    // button can no longer be clicked. We strip components and overlay a
    // CANCELLED embed; failures are non-fatal.
    if (c.workspace_message_id) {
      try {
        const userRow = await db.execute<{ workspace_channel_id: string | null }>(
          sql`SELECT workspace_channel_id FROM users WHERE discord_id = ${c.discord_id} LIMIT 1`
        );
        const wsChannelId = userRow.rows[0]?.workspace_channel_id;
        if (wsChannelId) {
          const ch = await guild.channels.fetch(wsChannelId).catch(() => null);
          if (ch && "messages" in ch) {
            const wsMsg = await (ch as any).messages.fetch(c.workspace_message_id).catch(() => null);
            if (wsMsg) {
              await wsMsg.edit({
                embeds: [
                  makeEmbed(COLORS.MUTED)
                    .setTitle(`❌ Task #${taskId} — CANCELLED`)
                    .setDescription(`This task was cancelled by an admin.\n\n**Reason:** ${reason}`)
                ],
                components: [],
              });
            }
          }
        }
      } catch (err) {
        logger.warn({ err, claimId: c.id }, "Could not lock workspace embed on task cancel");
      }
    }
  }

  if (task.channelMessageId) {
    try {
      const { tasksChannel } = await setupGuild(guild);
      const msg = await tasksChannel.messages.fetch(task.channelMessageId);
      await msg.edit({
        content: `~~${msg.content ?? ""}~~`,
        embeds: [
          makeEmbed(COLORS.MUTED)
            .setTitle(`❌ Task #${taskId} — CANCELLED`)
            .setDescription(`This task was cancelled.\n\n**Reason:** ${reason}`)
        ],
        components: [],
      });
    } catch {
      logger.warn({ taskId }, "Could not edit task message on cancel");
    }
  }

  logger.info({ taskId, actor: interaction.user.id, reason, claimsReleased: expiredClaims.rows.length }, "Task cancelled");

  return interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle(`✅ Task #${taskId} Cancelled`)
        .setDescription(`**"${task.title}"** has been closed.\n\n**Reason:** ${reason}\n\n${expiredClaims.rows.length > 0 ? `**${expiredClaims.rows.length}** active claim(s) released and claimers notified.` : "No active claims to release."}`)
    ]
  });
}

export async function handleCampaignStatusCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild!;
  const member = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(member, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can view campaign status.")] });
  }

  let campaignId = interaction.options.getInteger("campaign_id");
  if (!campaignId) {
    const latest = await db.execute<{ id: number }>(
      sql`SELECT id FROM campaigns ORDER BY id DESC LIMIT 1`
    );
    campaignId = latest.rows[0]?.id;
  }

  if (!campaignId) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.WARNING).setDescription("⚠️ No campaigns found.")] });
  }

  const campRes = await db.execute<{
    id: number;
    title: string;
    total: string;
    completed: string;
    claimed: string;
    unclaimed: string;
  }>(
    sql`SELECT
          c.id,
          c.title,
          COUNT(t.id)::text AS total,
          COUNT(t.id) FILTER (WHERE t.status = 'completed' OR t.status = 'closed')::text AS completed,
          COUNT(t.id) FILTER (WHERE t.status = 'open' AND t.slots_filled >= t.max_slots)::text AS claimed,
          COUNT(t.id) FILTER (WHERE t.status = 'open' AND t.slots_filled < t.max_slots)::text AS unclaimed
        FROM campaigns c
        LEFT JOIN tasks t ON t.campaign_id = c.id
        WHERE c.id = ${campaignId}
        GROUP BY c.id, c.title`
  );

  const row = campRes.rows[0];
  if (!row) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Campaign #${campaignId} not found.`)] });
  }

  const unclaimedList = await db.execute<{ id: number; title: string; reddit_link: string }>(
    sql`SELECT id, title, reddit_link FROM tasks
        WHERE campaign_id = ${campaignId} AND status = 'open' AND slots_filled < max_slots
        ORDER BY id ASC LIMIT 15`
  );

  const total = parseInt(row.total || "0");
  const completed = parseInt(row.completed || "0");
  const claimed = parseInt(row.claimed || "0");
  const unclaimed = parseInt(row.unclaimed || "0");

  const listText = unclaimedList.rows.length > 0
    ? unclaimedList.rows.map((t) => `• **Task #${t.id}**: [${t.title}](${t.reddit_link})`).join("\n")
    : "🎉 All tasks have been claimed!";

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(`📊 Campaign #${campaignId} Status`)
    .setDescription(`**Title:** ${row.title}`)
    .addFields(
      { name: "📋 Total Tasks", value: String(total), inline: true },
      { name: "⏳ Unclaimed Remaining", value: `**${unclaimed}**`, inline: true },
      { name: "🔒 Active / Claimed", value: String(claimed), inline: true },
      { name: "✅ Completed", value: String(completed), inline: true },
      { name: `📌 Remaining Tasks (${unclaimed})`, value: listText.slice(0, 1024), inline: false },
    );

  await interaction.editReply({ embeds: [embed] });
}

export async function handleCancelCampaignCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  const member = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(member, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can cancel campaigns.")] });
  }

  const campaignId = interaction.options.getInteger("campaign_id", true);
  const reason = interaction.options.getString("reason") ?? "Campaign cancelled by admin";

  const campaignRows = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  const campaign = campaignRows[0];
  if (!campaign) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Campaign #${campaignId} not found.`)] });
  }

  await db.execute(
    sql`UPDATE campaigns SET status = 'cancelled' WHERE id = ${campaignId}`
  );

  const openTasksRes = await db.execute<{ id: number; title: string; channel_message_id: string | null }>(
    sql`UPDATE tasks SET status = 'closed'
        WHERE creator_discord_id IN (
          SELECT creator_discord_id FROM campaigns WHERE id = ${campaignId}
        )
        AND status = 'open'
        AND created_at >= (SELECT created_at FROM campaigns WHERE id = ${campaignId})
        RETURNING id, title, channel_message_id`
  );

  const cancelledTaskIds = openTasksRes.rows.map((r) => r.id);
  let releasedClaims = 0;

  for (const t of openTasksRes.rows) {
    invalidateTask(t.id);
    const expiredClaims = await db.execute<{ id: number; discord_id: string; workspace_message_id: string | null }>(
      sql`UPDATE claims SET status = 'expired' WHERE task_id = ${t.id} AND status = 'claimed' RETURNING id, discord_id, workspace_message_id`
    );
    releasedClaims += expiredClaims.rows.length;
    for (const c of expiredClaims.rows) {
      invalidateClaim(c.id);
      try {
        const u = await guild.client.users.fetch(c.discord_id);
        await u.send({
          embeds: [
            makeEmbed(COLORS.WARNING)
              .setTitle("⚠️ Campaign Cancelled")
              .setDescription(`Campaign **"${campaign.title}"** was cancelled. **Task #${t.id}** has been closed and your claim released.\n\n**Reason:** ${reason}`)
          ],
        });
      } catch {
        logger.warn({ discordId: c.discord_id }, "Could not DM user about cancelled campaign task");
      }

      // Lock the user's workspace embed for this claim so they can no longer
      // submit proof for a cancelled campaign task.
      if (c.workspace_message_id) {
        try {
          const userRow = await db.execute<{ workspace_channel_id: string | null }>(
            sql`SELECT workspace_channel_id FROM users WHERE discord_id = ${c.discord_id} LIMIT 1`
          );
          const wsChannelId = userRow.rows[0]?.workspace_channel_id;
          if (wsChannelId) {
            const ch = await guild.channels.fetch(wsChannelId).catch(() => null);
            if (ch && "messages" in ch) {
              const wsMsg = await (ch as any).messages.fetch(c.workspace_message_id).catch(() => null);
              if (wsMsg) {
                await wsMsg.edit({
                  embeds: [
                    makeEmbed(COLORS.MUTED)
                      .setTitle(`❌ Task #${t.id} — CAMPAIGN CANCELLED`)
                      .setDescription(`Campaign **"${campaign.title}"** was cancelled.\n\n**Reason:** ${reason}`)
                  ],
                  components: [],
                });
              }
            }
          }
        } catch (err) {
          logger.warn({ err, claimId: c.id }, "Could not lock workspace embed on campaign cancel");
        }
      }
    }

    if (t.channel_message_id) {
      try {
        const { tasksChannel } = await setupGuild(guild);
        const msg = await tasksChannel.messages.fetch(t.channel_message_id);
        await msg.edit({
          embeds: [
            makeEmbed(COLORS.MUTED)
              .setTitle(`❌ Task #${t.id} — CAMPAIGN CANCELLED`)
              .setDescription(`This task was part of campaign **"${campaign.title}"** which was cancelled.\n\n**Reason:** ${reason}`)
          ],
          components: [],
        });
      } catch {
        logger.warn({ taskId: t.id }, "Could not edit task message on campaign cancel");
      }
    }
  }

  await db.execute(
    sql`UPDATE campaign_queue SET status = 'cancelled' WHERE campaign_id = ${campaignId} AND status = 'pending'`
  );

  logger.info({ campaignId, actor: interaction.user.id, tasksClosedCount: cancelledTaskIds.length, releasedClaims }, "Campaign cancelled");

  return interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle(`✅ Campaign #${campaignId} Cancelled`)
        .setDescription(
          `**"${campaign.title}"** has been cancelled.\n\n` +
          `**Tasks closed:** ${cancelledTaskIds.length}\n` +
          `**Claims released:** ${releasedClaims}\n` +
          `**Queued tasks cancelled:** any pending drip-feed tasks\n\n` +
          `**Reason:** ${reason}`
        )
    ]
  });
}
