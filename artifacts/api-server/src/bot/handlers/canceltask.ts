import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type Guild,
  type TextChannel,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, tasks, campaigns, auditLogs } from "@workspace/db";
import { makeEmbed, hasModRole } from "../util.js";
import { COLORS } from "../constants.js";
import { invalidateTask, invalidateClaim } from "../cache.js";
import { setupGuild } from "../setup.js";
import {
  buildCampaignProgressEmbed,
  buildPublicButtons,
  buildPublicTaskEmbed,
  refreshCampaignSummary,
} from "../task-creation.js";
import { logger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Pending ephemeral Discord confirmations for /cancelcampaign
// Bounded TTL map so an unused prompt self-cleans and double-clicks cannot run
// the same cancellation twice.
// ---------------------------------------------------------------------------
const CONFIRM_TTL_MS = 5 * 60 * 1000;

interface PendingCampaignCancel {
  campaignId: number;
  reason: string;
  actorDiscordId: string;
  actorUsername: string;
  expiresAt: number;
}

const pendingCampaignCancels = new Map<string, PendingCampaignCancel>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingCampaignCancels) {
    if (v.expiresAt < now) pendingCampaignCancels.delete(k);
  }
}, 60_000).unref();

export interface AuditLogInput {
  action: string;
  entityType: "campaign" | "task";
  entityId: number;
  actorDiscordId: string | null;
  actorUsername: string;
  source: "discord" | "dashboard" | "script";
  reason?: string | null;
  metadata?: Record<string, unknown>;
  guild?: Guild | null;
  taskLogsChannel?: TextChannel | null;
  logEmbed?: EmbedBuilder;
}

/** Persist a durable admin action record in `audit_logs` and optionally post to #task-logs. */
export async function recordAuditLog(input: AuditLogInput): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      actorDiscordId: input.actorDiscordId,
      actorUsername: input.actorUsername,
      source: input.source,
      reason: input.reason ?? null,
      metadata: input.metadata ?? {},
    });
  } catch (err) {
    logger.warn({ err, action: input.action, entityId: input.entityId }, "Failed to insert audit_logs row (non-fatal)");
  }

  if (input.logEmbed && (input.taskLogsChannel || input.guild)) {
    try {
      const ch = input.taskLogsChannel ?? (input.guild ? (await setupGuild(input.guild)).taskLogsChannel : null);
      if (ch && "send" in ch) {
        await (ch as TextChannel).send({ embeds: [input.logEmbed] });
      }
    } catch (err) {
      logger.warn({ err, action: input.action, entityId: input.entityId }, "Failed to post audit embed to #task-logs (non-fatal)");
    }
  }
}

function formatActorLabel(actorDiscordId: string | null, actorUsername: string, source: "discord" | "dashboard" | "script"): string {
  const base = actorDiscordId ? `<@${actorDiscordId}> (${actorUsername})` : actorUsername;
  return `${base} via **${source}**`;
}

/** Expire all active (`status = 'claimed'`) claims for a task, decrement `slots_filled`, DM claimers, and lock workspaces. */
async function releaseActiveClaimsForTask(
  taskId: number,
  guild: Guild | null,
  copy: {
    dmTitle: string;
    dmDescription: string;
    workspaceTitle: string;
    workspaceDescription: string;
    reason: string;
  }
): Promise<number> {
  const expiredClaims = await db.execute<{ id: number; discord_id: string; workspace_message_id: string | null }>(
    sql`UPDATE claims
        SET status = 'expired'
        WHERE task_id = ${taskId} AND status = 'claimed'
        RETURNING id, discord_id, workspace_message_id`
  );

  const releasedCount = expiredClaims.rows.length;
  if (releasedCount === 0) return 0;

  await db.execute(
    sql`UPDATE tasks
        SET slots_filled = GREATEST(0, slots_filled - ${releasedCount})
        WHERE id = ${taskId}`
  );
  invalidateTask(taskId);

  for (const c of expiredClaims.rows) {
    invalidateClaim(c.id);
    if (!guild) continue;

    try {
      const u = await guild.client.users.fetch(c.discord_id);
      await u.send({
        embeds: [
          makeEmbed(COLORS.WARNING)
            .setTitle(copy.dmTitle)
            .setDescription(`${copy.dmDescription}\n\n**Reason:** ${copy.reason}`)
        ],
      });
    } catch {
      logger.warn({ discordId: c.discord_id, taskId }, "Could not DM user about cancelled task");
    }

    if (c.workspace_message_id) {
      try {
        const userRow = await db.execute<{ workspace_channel_id: string | null }>(
          sql`SELECT workspace_channel_id FROM users WHERE discord_id = ${c.discord_id} LIMIT 1`
        );
        const wsChannelId = userRow.rows[0]?.workspace_channel_id;
        if (wsChannelId) {
          const ch = await guild.channels.fetch(wsChannelId).catch(() => null);
          if (ch && "messages" in ch) {
            const wsMsg = await (ch as TextChannel).messages.fetch(c.workspace_message_id).catch(() => null);
            if (wsMsg) {
              await wsMsg.edit({
                embeds: [
                  makeEmbed(COLORS.MUTED)
                    .setTitle(copy.workspaceTitle)
                    .setDescription(`${copy.workspaceDescription}\n\n**Reason:** ${copy.reason}`)
                ],
                components: [],
              });
            }
          }
        }
      } catch (err) {
        logger.warn({ err, claimId: c.id }, "Could not lock workspace embed on cancel");
      }
    }
  }

  return releasedCount;
}

export type CancelTaskResult =
  | { ok: true; taskId: number; title: string; claimsReleased: number; preservedPartialSubs: number }
  | { ok: false; code: "not_found" | "already_closed" | "has_submitted_proofs"; message: string };

/** Close a single open task while protecting tasks whose slots are already filled with submitted proofs. */
export async function cancelTaskById(params: {
  taskId: number;
  reason: string;
  actorDiscordId: string | null;
  actorUsername: string;
  source: "discord" | "dashboard" | "script";
  guild: Guild | null;
}): Promise<CancelTaskResult> {
  const { taskId, reason, actorDiscordId, actorUsername, source, guild } = params;
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task) {
    return { ok: false, code: "not_found", message: `Task #${taskId} not found.` };
  }
  if (task.status === "closed") {
    return { ok: false, code: "already_closed", message: `Task #${taskId} is already closed.` };
  }

  const subRes = await db.execute<{ active_subs: number }>(
    sql`SELECT COUNT(*) FILTER (WHERE review_status != 'rejected')::int AS active_subs
        FROM submissions
        WHERE task_id = ${taskId}`
  );
  const activeSubs = Number(subRes.rows[0]?.active_subs ?? 0);

  if (activeSubs > 0 && task.slotsFilled >= task.maxSlots) {
    return {
      ok: false,
      code: "has_submitted_proofs",
      message:
        `Cannot cancel Task #${taskId}: all slots already have submitted/accepted proof(s) (${activeSubs}). ` +
        `Review or reject the submission instead of cancelling the task.`,
    };
  }

  await db.update(tasks).set({ status: "closed" }).where(eq(tasks.id, taskId));
  invalidateTask(taskId);

  const claimsReleased = await releaseActiveClaimsForTask(taskId, guild, {
    dmTitle: "⚠️ Task Cancelled",
    dmDescription: `**Task #${taskId}** was cancelled by an admin. Your claim has been released.`,
    workspaceTitle: `❌ Task #${taskId} — CANCELLED`,
    workspaceDescription: `This task was cancelled by an admin.`,
    reason,
  });

  let taskLogsChannel: TextChannel | null = null;
  if (guild) {
    try {
      const setup = await setupGuild(guild);
      taskLogsChannel = setup.taskLogsChannel as TextChannel;

      if (task.channelMessageId) {
        try {
          const msg = await setup.tasksChannel.messages.fetch(task.channelMessageId);
          if (activeSubs > 0) {
            const [refreshed] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
            if (refreshed) {
              const card = buildPublicTaskEmbed(refreshed);
              const prog = refreshed.campaignId ? await buildCampaignProgressEmbed(refreshed.campaignId) : null;
              await msg.edit({
                embeds: prog ? [card, prog] : [card],
                components: [buildPublicButtons(taskId, true)],
              });
            }
          } else {
            const struckContent =
              msg.content && !msg.content.startsWith("~~") ? `~~${msg.content}~~` : msg.content;
            await msg.edit({
              content: struckContent,
              embeds: [
                makeEmbed(COLORS.MUTED)
                  .setTitle(`❌ Task #${taskId} — CANCELLED`)
                  .setDescription(`This task was cancelled.\n\n**Reason:** ${reason}`)
              ],
              components: [],
            });
          }
        } catch {
          logger.warn({ taskId }, "Could not edit task message on cancel");
        }
      }

      if (task.campaignId) {
        void refreshCampaignSummary(task.campaignId);
      }
    } catch (err) {
      logger.warn({ err, taskId }, "Could not update Discord task card on cancel");
    }
  }

  logger.info(
    { taskId, actorDiscordId, actorUsername, source, reason, claimsReleased, activeSubsPreserved: activeSubs },
    "Task cancelled"
  );

  await recordAuditLog({
    action: "task.cancel",
    entityType: "task",
    entityId: taskId,
    actorDiscordId,
    actorUsername,
    source,
    reason,
    metadata: { claimsReleased, activeSubsPreserved: activeSubs, campaignId: task.campaignId ?? null },
    guild,
    taskLogsChannel,
    logEmbed: makeEmbed(COLORS.WARNING)
      .setTitle(`🚫 Task #${taskId} Cancelled`)
      .setDescription(`**"${task.title}"** was closed.`)
      .addFields(
        { name: "Cancelled By", value: formatActorLabel(actorDiscordId, actorUsername, source), inline: true },
        { name: "Claims Released", value: String(claimsReleased), inline: true },
        ...(activeSubs > 0
          ? [{ name: "Existing Submissions Preserved", value: String(activeSubs), inline: true }]
          : []),
        { name: "Reason", value: reason.slice(0, 1000), inline: false }
      ),
  });

  return {
    ok: true,
    taskId,
    title: task.title,
    claimsReleased,
    preservedPartialSubs: activeSubs,
  };
}

export async function handleCancelTaskCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  const member = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(member, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can cancel tasks.")] });
  }

  const taskId = interaction.options.getInteger("task_id", true);
  const reason = interaction.options.getString("reason") ?? "Cancelled by admin";

  const result = await cancelTaskById({
    taskId,
    reason,
    actorDiscordId: interaction.user.id,
    actorUsername: interaction.user.username,
    source: "discord",
    guild,
  });

  if (!result.ok) {
    const color = result.code === "already_closed" ? COLORS.WARNING : COLORS.DANGER;
    return interaction.editReply({ embeds: [makeEmbed(color).setDescription(`❌ ${result.message}`)] });
  }

  return interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle(`✅ Task #${taskId} Cancelled`)
        .setDescription(
          `**"${result.title}"** has been closed.\n\n` +
          `**Reason:** ${reason}\n\n` +
          (result.claimsReleased > 0
            ? `**${result.claimsReleased}** active claim(s) released and claimers notified.`
            : "No active claims to release.")
        )
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
    campaign_status: string;
    total: string;
    closed_count: string;
    filled_open: string;
    unclaimed: string;
  }>(
    sql`SELECT
          c.id,
          c.title,
          c.status AS campaign_status,
          COUNT(t.id)::text AS total,
          COUNT(t.id) FILTER (WHERE t.status = 'completed' OR t.status = 'closed')::text AS closed_count,
          COUNT(t.id) FILTER (WHERE t.status = 'open' AND t.slots_filled >= t.max_slots)::text AS filled_open,
          COUNT(t.id) FILTER (WHERE t.status = 'open' AND t.slots_filled < t.max_slots)::text AS unclaimed
        FROM campaigns c
        LEFT JOIN tasks t ON t.campaign_id = c.id
        WHERE c.id = ${campaignId}
        GROUP BY c.id, c.title, c.status`
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
  const closedCount = parseInt(row.closed_count || "0");
  const filledOpen = parseInt(row.filled_open || "0");
  const unclaimed = parseInt(row.unclaimed || "0");

  const listText = unclaimedList.rows.length > 0
    ? unclaimedList.rows.map((t) => `• **Task #${t.id}**: [${t.title}](${t.reddit_link})`).join("\n")
    : "🎉 No unclaimed open tasks remaining!";

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(`📊 Campaign #${campaignId} Status`)
    .setDescription(`**Title:** ${row.title}\n**Status:** \`${row.campaign_status}\``)
    .addFields(
      { name: "📋 Total Tasks", value: String(total), inline: true },
      { name: "⏳ Unclaimed Remaining", value: `**${unclaimed}**`, inline: true },
      { name: "🔒 Filled / Submitted", value: String(filledOpen), inline: true },
      { name: "🚫 Closed / Cancelled", value: String(closedCount), inline: true },
      { name: `📌 Remaining Tasks (${unclaimed})`, value: listText.slice(0, 1024), inline: false },
    );

  await interaction.editReply({ embeds: [embed] });
}

type CampaignTaskCandidate = {
  id: number;
  title: string;
  channel_message_id: string | null;
  slots_filled: number;
  max_slots: number;
  has_non_rejected: boolean;
  active_claims: number;
};

export interface CampaignCancelPreview {
  campaign: typeof campaigns.$inferSelect;
  cancellableTasks: CampaignTaskCandidate[];
  partialSubmittedTasks: CampaignTaskCandidate[];
  preservedSubmittedTasks: CampaignTaskCandidate[];
  activeClaimsToRelease: number;
  pendingQueueCount: number;
}

export async function getCampaignCancelPreview(
  campaignId: number
): Promise<
  | { ok: true; preview: CampaignCancelPreview }
  | { ok: false; code: "not_found" | "already_cancelled" | "all_submitted"; message: string }
> {
  const campaignRows = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  const campaign = campaignRows[0];
  if (!campaign) {
    return { ok: false, code: "not_found", message: `Campaign #${campaignId} not found.` };
  }
  if (campaign.status === "cancelled") {
    return { ok: false, code: "already_cancelled", message: `Campaign #${campaignId} is already cancelled.` };
  }

  // Strictly scope to `campaign_id = campaignId` — never match sibling campaigns
  // or standalone /task posts created by the same author.
  const openTasksRes = await db.execute<CampaignTaskCandidate>(
    sql`SELECT t.id,
               t.title,
               t.channel_message_id,
               t.slots_filled,
               t.max_slots,
               EXISTS (
                 SELECT 1 FROM submissions s
                 WHERE s.task_id = t.id AND s.review_status != 'rejected'
               ) AS has_non_rejected,
               (
                 SELECT COUNT(*)::int FROM claims c
                 WHERE c.task_id = t.id AND c.status = 'claimed'
               ) AS active_claims
        FROM tasks t
        WHERE t.campaign_id = ${campaignId}
          AND t.status = 'open'
        ORDER BY t.id ASC`
  );

  const queueRes = await db.execute<{ cnt: number }>(
    sql`SELECT COUNT(*)::int AS cnt FROM campaign_queue WHERE campaign_id = ${campaignId} AND status = 'pending'`
  );
  const pendingQueueCount = Number(queueRes.rows[0]?.cnt ?? 0);

  const preservedSubmittedTasks: CampaignTaskCandidate[] = [];
  const partialSubmittedTasks: CampaignTaskCandidate[] = [];
  const cancellableTasks: CampaignTaskCandidate[] = [];
  let activeClaimsToRelease = 0;

  for (const t of openTasksRes.rows) {
    if (t.has_non_rejected && Number(t.slots_filled) >= Number(t.max_slots)) {
      preservedSubmittedTasks.push(t);
    } else if (t.has_non_rejected) {
      partialSubmittedTasks.push(t);
      activeClaimsToRelease += Number(t.active_claims || 0);
    } else {
      cancellableTasks.push(t);
      activeClaimsToRelease += Number(t.active_claims || 0);
    }
  }

  if (
    cancellableTasks.length === 0 &&
    partialSubmittedTasks.length === 0 &&
    pendingQueueCount === 0 &&
    preservedSubmittedTasks.length > 0
  ) {
    return {
      ok: false,
      code: "all_submitted",
      message:
        `Cannot cancel Campaign #${campaignId}: all ${preservedSubmittedTasks.length} open task(s) already have submitted proofs and 0 pending drops remain.`,
    };
  }

  return {
    ok: true,
    preview: {
      campaign,
      cancellableTasks,
      partialSubmittedTasks,
      preservedSubmittedTasks,
      activeClaimsToRelease,
      pendingQueueCount,
    },
  };
}

export type CancelCampaignResult =
  | {
      ok: true;
      campaignId: number;
      campaignTitle: string;
      tasksClosed: number;
      preservedSubmittedTasks: number;
      partialTasksClosed: number;
      releasedClaims: number;
      queueCancelled: number;
    }
  | { ok: false; code: "not_found" | "already_cancelled" | "all_submitted"; message: string };

/**
 * Shared campaign cancellation routine used by both Discord `/cancelcampaign`
 * (after confirmation) and Dashboard `POST /admin/campaigns/:id/cancel`.
 * Preserves tasks that already have non-rejected submissions filling their slots.
 */
export async function cancelCampaignById(params: {
  campaignId: number;
  reason: string;
  actorDiscordId: string | null;
  actorUsername: string;
  source: "discord" | "dashboard" | "script";
  guild: Guild | null;
}): Promise<CancelCampaignResult> {
  const { campaignId, reason, actorDiscordId, actorUsername, source, guild } = params;

  const previewRes = await getCampaignCancelPreview(campaignId);
  if (!previewRes.ok) {
    return previewRes;
  }

  const { campaign, cancellableTasks, partialSubmittedTasks, preservedSubmittedTasks } = previewRes.preview;
  const tasksToClose = [...cancellableTasks, ...partialSubmittedTasks];
  const closeIds = tasksToClose.map((t) => t.id);

  await db.execute(sql`UPDATE campaigns SET status = 'cancelled' WHERE id = ${campaignId}`);

  if (closeIds.length > 0) {
    await db.update(tasks).set({ status: "closed" }).where(inArray(tasks.id, closeIds));
    for (const id of closeIds) invalidateTask(id);
  }

  const queueRes = await db.execute<{ id: number }>(
    sql`UPDATE campaign_queue
        SET status = 'cancelled'
        WHERE campaign_id = ${campaignId} AND status = 'pending'
        RETURNING id`
  );
  const queueCancelled = queueRes.rows.length;

  let releasedClaims = 0;
  let setup: Awaited<ReturnType<typeof setupGuild>> | null = null;
  if (guild) {
    try {
      setup = await setupGuild(guild);
    } catch (err) {
      logger.warn({ err, campaignId }, "Could not resolve guild channels on campaign cancel");
    }
  }

  for (const t of tasksToClose) {
    releasedClaims += await releaseActiveClaimsForTask(t.id, guild, {
      dmTitle: "⚠️ Campaign Cancelled",
      dmDescription: `Campaign **"${campaign.title}"** was cancelled. **Task #${t.id}** has been closed and your claim released.`,
      workspaceTitle: `❌ Task #${t.id} — CAMPAIGN CANCELLED`,
      workspaceDescription: `Campaign **"${campaign.title}"** was cancelled.`,
      reason,
    });
  }

  if (guild && setup) {
    const progressEmbed = partialSubmittedTasks.length > 0 ? await buildCampaignProgressEmbed(campaignId) : null;

    for (const t of cancellableTasks) {
      if (!t.channel_message_id) continue;
      try {
        const msg = await setup.tasksChannel.messages.fetch(t.channel_message_id).catch(() => null);
        if (msg) {
          await msg.edit({
            embeds: [
              makeEmbed(COLORS.MUTED)
                .setTitle(`❌ Task #${t.id} — CAMPAIGN CANCELLED`)
                .setDescription(`This task was part of campaign **"${campaign.title}"** which was cancelled.\n\n**Reason:** ${reason}`)
            ],
            components: [],
          });
        }
      } catch {
        logger.warn({ taskId: t.id }, "Could not edit task message on campaign cancel");
      }
    }

    for (const t of partialSubmittedTasks) {
      if (!t.channel_message_id) continue;
      try {
        const [refreshed] = await db.select().from(tasks).where(eq(tasks.id, t.id)).limit(1);
        const msg = await setup.tasksChannel.messages.fetch(t.channel_message_id).catch(() => null);
        if (msg && refreshed) {
          const card = buildPublicTaskEmbed(refreshed);
          await msg.edit({
            embeds: progressEmbed ? [card, progressEmbed] : [card],
            components: [buildPublicButtons(t.id, true)],
          });
        }
      } catch {
        logger.warn({ taskId: t.id }, "Could not refresh partial task message on campaign cancel");
      }
    }

    void refreshCampaignSummary(campaignId);
  }

  logger.info(
    {
      campaignId,
      actorDiscordId,
      actorUsername,
      source,
      tasksClosedCount: closeIds.length,
      preservedSubmittedCount: preservedSubmittedTasks.length,
      partialTasksClosedCount: partialSubmittedTasks.length,
      releasedClaims,
      queueCancelled,
    },
    "Campaign cancelled"
  );

  await recordAuditLog({
    action: "campaign.cancel",
    entityType: "campaign",
    entityId: campaignId,
    actorDiscordId,
    actorUsername,
    source,
    reason,
    metadata: {
      tasksClosed: closeIds.length,
      closedTaskIds: closeIds,
      preservedSubmittedTasks: preservedSubmittedTasks.length,
      preservedTaskIds: preservedSubmittedTasks.map((t) => t.id),
      partialTasksClosed: partialSubmittedTasks.length,
      releasedClaims,
      queueCancelled,
    },
    guild,
    taskLogsChannel: (setup?.taskLogsChannel as TextChannel) ?? null,
    logEmbed: makeEmbed(COLORS.DANGER)
      .setTitle(`🚫 Campaign #${campaignId} Cancelled`)
      .setDescription(`**"${campaign.title}"**`)
      .addFields(
        { name: "Cancelled By", value: formatActorLabel(actorDiscordId, actorUsername, source), inline: true },
        { name: "Tasks Closed", value: String(closeIds.length), inline: true },
        { name: "Submitted Tasks Preserved", value: String(preservedSubmittedTasks.length), inline: true },
        { name: "Claims Released", value: String(releasedClaims), inline: true },
        { name: "Queued Drops Cancelled", value: String(queueCancelled), inline: true },
        { name: "Reason", value: reason.slice(0, 1000), inline: false }
      ),
  });

  return {
    ok: true,
    campaignId,
    campaignTitle: campaign.title,
    tasksClosed: closeIds.length,
    preservedSubmittedTasks: preservedSubmittedTasks.length,
    partialTasksClosed: partialSubmittedTasks.length,
    releasedClaims,
    queueCancelled,
  };
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

  const previewRes = await getCampaignCancelPreview(campaignId);
  if (!previewRes.ok) {
    const color = previewRes.code === "already_cancelled" || previewRes.code === "all_submitted" ? COLORS.WARNING : COLORS.DANGER;
    return interaction.editReply({ embeds: [makeEmbed(color).setDescription(`❌ ${previewRes.message}`)] });
  }

  const { preview } = previewRes;
  const nonce = randomBytes(4).toString("hex");
  pendingCampaignCancels.set(nonce, {
    campaignId,
    reason,
    actorDiscordId: interaction.user.id,
    actorUsername: interaction.user.username,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`campaign:cancelconfirm:${campaignId}:${nonce}`)
      .setLabel(`Confirm Cancel (#${campaignId})`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`campaign:cancelabort:${campaignId}:${nonce}`)
      .setLabel("Keep Campaign")
      .setStyle(ButtonStyle.Secondary)
  );

  const previewEmbed = makeEmbed(COLORS.WARNING)
    .setTitle(`⚠️ Confirm Campaign Cancellation — #${campaignId}`)
    .setDescription(
      `**"${preview.campaign.title}"**\n\n` +
      `Tasks with already-submitted proofs will **not** be overwritten or closed.`
    )
    .addFields(
      { name: "Unsubmitted Tasks to Close", value: String(preview.cancellableTasks.length), inline: true },
      { name: "Submitted Tasks Preserved", value: String(preview.preservedSubmittedTasks.length), inline: true },
      { name: "Active Claims to Release", value: String(preview.activeClaimsToRelease), inline: true },
      ...(preview.partialSubmittedTasks.length > 0
        ? [{ name: "Partial Multi-Slot Tasks to Close", value: String(preview.partialSubmittedTasks.length), inline: true }]
        : []),
      { name: "Pending Queued Drops", value: String(preview.pendingQueueCount), inline: true },
      { name: "Reason", value: reason.slice(0, 1000), inline: false }
    );

  return interaction.editReply({ embeds: [previewEmbed], components: [row] });
}

export async function handleCancelCampaignButton(
  interaction: ButtonInteraction,
  action: "cancelconfirm" | "cancelabort",
  campaignIdStr: string,
  nonce: string
) {
  const guild = interaction.guild;
  if (!guild) return;

  const member = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(member, guild)) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can cancel campaigns.")],
      flags: 64,
    });
  }

  const pending = pendingCampaignCancels.get(nonce);
  const campaignId = parseInt(campaignIdStr, 10);
  if (!pending || pending.expiresAt < Date.now() || pending.campaignId !== campaignId) {
    pendingCampaignCancels.delete(nonce);
    return interaction.update({
      embeds: [makeEmbed(COLORS.WARNING).setDescription("⚠️ This confirmation prompt has expired. Run `/cancelcampaign` again if needed.")],
      components: [],
    });
  }

  if (pending.actorDiscordId !== interaction.user.id) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only the admin who ran `/cancelcampaign` can confirm it.")],
      flags: 64,
    });
  }

  pendingCampaignCancels.delete(nonce);

  if (action === "cancelabort") {
    return interaction.update({
      embeds: [makeEmbed(COLORS.MUTED).setTitle("Cancellation Aborted").setDescription(`Campaign **#${campaignId}** was left unchanged.`)],
      components: [],
    });
  }

  await interaction.deferUpdate();

  const result = await cancelCampaignById({
    campaignId,
    reason: pending.reason,
    actorDiscordId: interaction.user.id,
    actorUsername: interaction.user.username,
    source: "discord",
    guild,
  });

  if (!result.ok) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ ${result.message}`)],
      components: [],
    });
  }

  return interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle(`✅ Campaign #${campaignId} Cancelled`)
        .setDescription(
          `**"${result.campaignTitle}"** has been cancelled.\n\n` +
          `**Unsubmitted tasks closed:** ${result.tasksClosed}\n` +
          `**Submitted tasks preserved:** ${result.preservedSubmittedTasks}\n` +
          `**Claims released:** ${result.releasedClaims}\n` +
          `**Queued drops cancelled:** ${result.queueCancelled}\n\n` +
          `**Reason:** ${pending.reason}`
        )
    ],
    components: [],
  });
}
