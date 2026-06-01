import {
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} from "discord.js";
import { eq, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { tasks, claims, submissions, users, trustLogs } from "@workspace/db";
import { setupGuild, getOrCreateWorkspaceChannel } from "../setup.js";
import { getUserByDiscordId, tryCompleteReferral, getTaskByIdCached, getClaimByIdCached, invalidateTask, invalidateClaim } from "../db.js";
import { invalidateUser, invalidateLeaderboard } from "../cache.js";
import { makeEmbed, formatMoney, hasVerifiedRole, hasModRole } from "../util.js";
import { COLORS, TASK_COOLDOWN_MINUTES, CLAIM_TIMEOUT_MINUTES, MAX_CONCURRENT_CLAIMS, isTwitterTask, isQuoraTask, getPlatformLabel, TASK_PING_DELAY_MS, ANTI_FRAUD } from "../constants.js";
import { getCooldownConfig } from "../../lib/settings.js";
import { safeSyncEarnerRoles } from "../earnerRoles.js";
import { logger } from "../../lib/logger.js";
import { logSubmissionToSheet, logSubmissionEvent } from "../../lib/sheetsLogger.js";
import { refreshLeaderboard } from "./leaderboard.js";
import { validateRedditProof, extractTaskSubreddit, detectAppUrl, appUrlHelpMessage } from "../reddit-validator.js";
import { invalidateStreak } from "../streak.js";
import { randomBytes } from "node:crypto";
import { normalizeTaskInput, createTaskAndPost, buildSharedTaskEmbed, buildPublicTaskEmbed, buildPublicButtons, formatTaskCreator, buildCampaignProgressEmbed, refreshCampaignSummary } from "../task-creation.js";


const buildTaskEmbed = buildSharedTaskEmbed;

// ---------------------------------------------------------------------------
// Pending image attachments — Discord modal customIds are capped at 100 chars
// so we can't stash a long CDN URL there. We key the cache by `${userId}:${nonce}`
// where nonce is a per-modal random token embedded in the customId. This binds
// each pending image to exactly one modal session, so a user who cancels a
// modal-with-image and then re-opens /createtask without an image cannot
// accidentally inherit the stale image.
// ---------------------------------------------------------------------------
const PENDING_IMAGE_TTL_MS = 5 * 60 * 1000;
const pendingImageByKey = new Map<string, { url: string; expires: number }>();
function newImageNonce(): string {
  return randomBytes(4).toString("hex"); // 8 chars, ~32 bits of entropy — plenty for a 5-min single-user window
}
function setPendingImage(userId: string, nonce: string, url: string): void {
  pendingImageByKey.set(`${userId}:${nonce}`, { url, expires: Date.now() + PENDING_IMAGE_TTL_MS });
}
function takePendingImage(userId: string, nonce: string | undefined): string | null {
  if (!nonce) return null;
  const key = `${userId}:${nonce}`;
  const e = pendingImageByKey.get(key);
  if (!e) return null;
  pendingImageByKey.delete(key);
  if (e.expires < Date.now()) return null;
  return e.url;
}
/** Drop any leftover entries for this user — defense against modals that were never submitted. */
function clearStaleImagesForUser(userId: string): void {
  const prefix = `${userId}:`;
  for (const k of pendingImageByKey.keys()) if (k.startsWith(prefix)) pendingImageByKey.delete(k);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingImageByKey) if (v.expires < now) pendingImageByKey.delete(k);
}, 60_000).unref();

function buildTaskButtons(task: typeof tasks.$inferSelect): ActionRowBuilder<ButtonBuilder> {
  const isFull = task.slotsFilled >= task.maxSlots;
  const closed = task.status === "closed";
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`task:claim:${task.id}`)
      .setLabel("Claim Task")
      .setStyle(ButtonStyle.Success)
      .setDisabled(isFull || closed),
    new ButtonBuilder()
      .setCustomId(`task:details:${task.id}`)
      .setLabel("View Details")
      .setStyle(ButtonStyle.Secondary)
  );
}

export async function handleCreateTaskCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const member = interaction.member;
  if (!member || typeof member === "string" || !("roles" in member) || !hasModRole(member as any, guild)) {
    return interaction.reply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can create tasks.")], flags: 64 });
  }

  const type = interaction.options.getString("type", true);
  const reward = interaction.options.getNumber("reward", true);
  // /createtask is always single-slot now. Multi-slot drops go through /bulktask
  // (CSV `slots` column). We still encode it in the customId / pass to the modal
  // handler so the existing modal handler signature is unchanged.
  const slots = 1;
  const timeLimit = interaction.options.getInteger("time_limit") ?? 60;
  const holdHours = interaction.options.getInteger("hold_hours") ?? 168;
  const minTrust = interaction.options.getInteger("min_trust") ?? 0;
  // Default true — explicit `false` opts the task out of the cooldown gate.
  const cooldownEnabledOpt = interaction.options.getBoolean("cooldown_enabled") ?? true;
  const imageAttachment = interaction.options.getAttachment("image");

  // Always purge any leftover pending image from a previous (canceled) modal
  // so we can never accidentally apply a stale image to this new task.
  clearStaleImagesForUser(interaction.user.id);

  // Per-modal nonce tying the pending image (if any) to exactly this modal session.
  const nonce = newImageNonce();

  if (imageAttachment) {
    if (!imageAttachment.contentType?.startsWith("image/")) {
      await interaction.reply({ content: "❌ The `image` option must be an image file (png, jpg, gif, webp).", flags: 64 });
      return;
    }
    setPendingImage(interaction.user.id, nonce, imageAttachment.url);
  }

  const twitterTask = isTwitterTask(type);
  const quoraTask = isQuoraTask(type);
  const redditPostTask = type === "post";
  const platform = getPlatformLabel(type);

  // customId stays well under Discord's 100-char limit (nonce adds 9 chars).
  const modal = new ModalBuilder()
    .setCustomId(`task:create:${type}:${reward}:${slots}:${timeLimit}:${holdHours}:${minTrust}:${cooldownEnabledOpt ? 1 : 0}:${nonce}`)
    .setTitle(`Create ${platform} Task`);

  if (redditPostTask) {
    // Reddit POST: title is REQUIRED (used as the actual Reddit post title).
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("title").setLabel("Title (used as the Reddit post title)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("link").setLabel("Subreddit (e.g. r/somesub or full URL)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("instructions").setLabel("Instructions (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("post_body").setLabel("Post Body (pre-written content)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1400)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("flair").setLabel("Flair (optional, e.g. News, Discussion)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)
      )
    );
  } else {
    const linkLabel = twitterTask
      ? "Twitter Link (twitter.com or x.com)"
      : quoraTask
      ? "Quora Link (quora.com URL)"
      : "Reddit Link";
    const commentLabel = twitterTask
      ? "Tweet Text / Script (optional)"
      : quoraTask
      ? "Answer Script / Draft (optional)"
      : "Pre-written Comment (optional)";

    // For everything except "post", the title is OPTIONAL — we auto-generate
    // one from the type + link (e.g. "Comment on r/AskReddit") if blank.
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("title").setLabel("Title (optional — auto-generated if blank)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("link").setLabel(linkLabel).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(300)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("instructions").setLabel("Instructions (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("comment").setLabel(commentLabel).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000)
      )
    );
  }

  await interaction.showModal(modal);
}

export async function handleTaskCreateModal(
  interaction: ModalSubmitInteraction,
  type: string,
  reward: number,
  slots: number,
  timeLimit: number,
  holdHours: number,
  minTrust: number,
  cooldownEnabled: boolean,
  imageNonce?: string
) {
  await interaction.deferReply({ flags: 64 });

  const title = (interaction.fields.getTextInputValue("title") || "").trim();
  const link = interaction.fields.getTextInputValue("link");
  const instructions = interaction.fields.getTextInputValue("instructions");
  const redditPostTask = type === "post";

  const postBody = redditPostTask ? (interaction.fields.getTextInputValue("post_body") || "").trim() : null;
  const flair = redditPostTask ? (interaction.fields.getTextInputValue("flair") || "").trim() : null;
  const comment = redditPostTask ? null : (interaction.fields.getTextInputValue("comment") || "").trim();

  // Only the modal carrying this exact nonce can claim the cached image.
  const imageUrl = takePendingImage(interaction.user.id, imageNonce);

  const norm = normalizeTaskInput({
    type, title, link, instructions,
    prewrittenComment: comment,
    postBody, flair,
    reward, slots,
    timeLimitMinutes: timeLimit,
    holdHours, minTrustScore: minTrust,
    imageUrl,
    cooldownEnabled,
    creatorDiscordId: interaction.user.id,
  });
  if (!norm.ok) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ ${norm.error}`)],
    });
  }

  try {
    const guild = interaction.guild!;
    const { tasksChannel } = await setupGuild(guild);
    const task = await createTaskAndPost(norm.task, guild);
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ Task #${task.id} created and posted in <#${tasksChannel.id}>!`)],
    });
    logger.info({ taskId: task.id, creator: interaction.user.id, hasImage: Boolean(imageUrl) }, "Task created");
  } catch (err: any) {
    logger.error({ err }, "Create task via slash modal failed");
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ ${err?.message ?? "Failed to create task."}`)],
    });
  }
}

/** Single-embed (merge-mode) bulktask claim router. Looks at every sub-task
 *  in this campaign, atomically picks the next one the user is eligible for
 *  (status=open, slot available, no prior submission/claim/block from this
 *  user), then delegates to handleTaskClaim which runs the normal claim
 *  pipeline (verify gate, cooldown, slot CAS, workspace card). On reject the
 *  slot reopens automatically and the next campaign:claimnext click skips
 *  this sub-task for the rejected user (submissions row excludes them). */
export async function handleCampaignClaimNext(interaction: ButtonInteraction, campaignId: number) {
  if (!interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferReply({ flags: 64 });
    } catch (err: any) {
      if (err?.code !== 40060) throw err;
      logger.warn({ campaignId, userId: interaction.user.id }, "handleCampaignClaimNext: duplicate interaction, ignoring");
      return;
    }
  }

  const discordId = interaction.user.id;

  // Pick the next eligible sub-task: oldest open slot the user hasn't already
  // claimed, submitted on, or been blocked from. Single ORDER BY id ASC keeps
  // assignment deterministic and avoids row-skew.
  const pick = await db.execute<{ id: number }>(
    sql`SELECT t.id
          FROM tasks t
         WHERE t.campaign_id = ${campaignId}
           AND t.is_merged_subtask = TRUE
           AND t.status = 'open'
           AND t.slots_filled < t.max_slots
           AND NOT EXISTS (
             SELECT 1 FROM submissions s
              WHERE s.task_id = t.id AND s.discord_id = ${discordId}
           )
           AND NOT EXISTS (
             SELECT 1 FROM claims c
              WHERE c.task_id = t.id AND c.discord_id = ${discordId} AND c.status = 'claimed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_claim_blocks b
              WHERE b.task_id = t.id AND b.discord_id = ${discordId}
           )
         ORDER BY t.id ASC
         LIMIT 1`
  );

  const nextId = pick.rows[0]?.id;
  if (!nextId) {
    // Either all sub-tasks are taken, or every remaining one has been
    // claimed/submitted/blocked by THIS user. Distinguish the two so the
    // message isn't misleading.
    const anyOpen = await db.execute<{ c: string }>(
      sql`SELECT COUNT(*)::text AS c FROM tasks
           WHERE campaign_id = ${campaignId} AND is_merged_subtask = TRUE
             AND status = 'open' AND slots_filled < max_slots`
    );
    const openCount = parseInt(anyOpen.rows[0]?.c ?? "0");
    const msg = openCount > 0
      ? "✅ You've already claimed or submitted every task you're eligible for in this campaign. Nice work — wait for the next drop!"
      : "❌ All tasks in this campaign have been claimed.";
    return interaction.editReply({ embeds: [makeEmbed(COLORS.MUTED).setDescription(msg)] });
  }

  return handleTaskClaim(interaction, nextId, { alreadyDeferred: true });
}

export async function handleTaskClaim(
  interaction: ButtonInteraction,
  taskId: number,
  opts: { alreadyDeferred?: boolean } = {},
) {
  // Race-safe defer: Discord sometimes re-delivers the same interaction
  // (network glitch / gateway retry) or the user double-taps the button.
  // Without this guard the second call throws DiscordAPIError[40060]
  // "Interaction has already been acknowledged", which spams error logs
  // and shows the user a generic "interaction failed" toast even though
  // their first claim succeeded. We swallow only the 40060 code; any
  // other error (timeout, network, etc.) still bubbles up.
  //
  // `alreadyDeferred` lets internal callers (e.g. handleCampaignClaimNext)
  // defer themselves first and delegate without tripping the duplicate guard.
  if (opts.alreadyDeferred) {
    // Caller has already deferred — proceed straight to claim logic. We
    // still use editReply throughout so all reply paths are consistent.
  } else if (!interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferReply({ flags: 64 });
    } catch (err: any) {
      if (err?.code !== 40060) throw err;
      logger.warn({ taskId, userId: interaction.user.id }, "handleTaskClaim: duplicate interaction delivery, ignoring");
      return;
    }
  } else {
    logger.warn({ taskId, userId: interaction.user.id }, "handleTaskClaim: interaction already acknowledged (likely duplicate), ignoring");
    return;
  }

  const guild = interaction.guild!;
  const discordId = interaction.user.id;

  // Fan-out all independent reads in parallel — was the biggest source of latency.
  const [member, user, activeClaimsRes, task, existingClaimRows] = await Promise.all([
    guild.members.fetch(discordId),
    getUserByDiscordId(discordId),
    db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text as count FROM claims WHERE discord_id = ${discordId} AND status = 'claimed'`
    ),
    getTaskByIdCached(taskId),
    db.execute<{ id: number; status: string; expires_at: string | null }>(
      sql`SELECT id, status, expires_at FROM claims WHERE task_id = ${taskId} AND discord_id = ${discordId} AND status = 'claimed'`
    ),
  ]);

  // Check Discord role first; fall back to the DB `verified` flag so users
  // who were manually verified (role may have failed to assign) can still claim.
  if (!hasVerifiedRole(member, guild) && !user?.verified) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You must be verified to claim tasks. Run `/verify` first.")],
    });
  }

  if (!user) return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ User not found.")] });

  if (user.flagged) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Your account is flagged. Contact an admin.")] });
  }

  // ---- Cooldown gate (Phase 2) ------------------------------------------
  // Three-layer policy:
  //   1. Global setting (admin can disable cooldowns entirely from dashboard).
  //   2. Per-task `cooldown_enabled` flag (admin can mark a single task as
  //      cooldown-free for special drops).
  //   3. For Reddit tasks: per-Reddit-account cooldown — if the user has
  //      multiple verified Reddit accounts, only the one they actually USED
  //      goes on cooldown. Other accounts can claim immediately.
  //   4. For non-Reddit tasks (Twitter, Quora): fall back to user-level
  //      cooldown stamped on `users.last_task_completed_at` because there is
  //      no per-account ledger for those platforms yet.
  const cooldownCfg = await getCooldownConfig();
  const taskCooldownEnabled = ((task as any)?.cooldownEnabled ?? true) === true;
  const cooldownActive = cooldownCfg.enabled && taskCooldownEnabled && cooldownCfg.minutes > 0;
  if (cooldownActive) {
    const cooldownMs = cooldownCfg.minutes * 60 * 1000;
    const taskType = (task?.type ?? "").toLowerCase();
    const isRedditTask = !isTwitterTask(taskType) && !isQuoraTask(taskType);
    if (isRedditTask) {
      // Look at every Reddit account this Discord user has linked. The claim
      // is allowed if AT LEAST ONE account is off cooldown (last_used_at is
      // NULL or older than cooldown window). The submit handler will stamp
      // the specific account that was used.
      const accountsRes = await db.execute<{ reddit_username: string; last_used_at: string | null }>(
        sql`SELECT reddit_username, last_used_at
              FROM reddit_accounts
              WHERE discord_id = ${discordId}`
      );
      if (accountsRes.rows.length === 0) {
        // No multi-account row yet (legacy user). Fall back to the user-level
        // cooldown so the gate still applies.
        if (user.lastTaskCompletedAt) {
          const msSinceLast = Date.now() - new Date(user.lastTaskCompletedAt).getTime();
          if (msSinceLast < cooldownMs) {
            const readyAt = new Date(new Date(user.lastTaskCompletedAt).getTime() + cooldownMs);
            const unixReady = Math.floor(readyAt.getTime() / 1000);
            return interaction.editReply({
              embeds: [makeEmbed(COLORS.WARNING).setDescription(`⏳ Task cooldown active. You can claim again <t:${unixReady}:R>.`)],
            });
          }
        }
      } else {
        const now = Date.now();
        const available = accountsRes.rows.filter((r) => {
          if (!r.last_used_at) return true;
          return now - new Date(r.last_used_at).getTime() >= cooldownMs;
        });
        if (available.length === 0) {
          // All accounts on cooldown → block; show earliest readyAt AND which
          // specific Reddit account will free up first so the user knows
          // which one to wait for.
          const sorted = accountsRes.rows
            .map((r) => ({
              name: r.reddit_username,
              readyAt: new Date(r.last_used_at!).getTime() + cooldownMs,
            }))
            .sort((a, b) => a.readyAt - b.readyAt);
          const next = sorted[0]!;
          const unixReady = Math.floor(next.readyAt / 1000);
          return interaction.editReply({
            embeds: [makeEmbed(COLORS.WARNING).setDescription(
              `⏳ All your Reddit accounts (${accountsRes.rows.length}) are on cooldown.\n\n` +
              `Next to free up: **u/${next.name}** — <t:${unixReady}:R>`
            )],
          });
        }
        // At least one account is free → allow claim. The actual account
        // used is determined at submit time from the proof URL author.
      }
    } else {
      // Non-Reddit task → user-level cooldown.
      if (user.lastTaskCompletedAt) {
        const msSinceLast = Date.now() - new Date(user.lastTaskCompletedAt).getTime();
        if (msSinceLast < cooldownMs) {
          const readyAt = new Date(new Date(user.lastTaskCompletedAt).getTime() + cooldownMs);
          const unixReady = Math.floor(readyAt.getTime() / 1000);
          return interaction.editReply({
            embeds: [makeEmbed(COLORS.WARNING).setDescription(`⏳ Task cooldown active. You can claim again <t:${unixReady}:R>.`)],
          });
        }
      }
    }
  }

  if (parseInt(activeClaimsRes.rows[0]?.count ?? "0") >= MAX_CONCURRENT_CLAIMS) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.WARNING).setDescription(
        MAX_CONCURRENT_CLAIMS === 1
          ? `⚠️ You already have an active claim. Submit your proof for it before claiming another task.`
          : `⚠️ You can only hold **${MAX_CONCURRENT_CLAIMS}** active claims at once. Submit or wait for existing ones to expire.`
      )],
    });
  }

  if (!task) return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Task not found.")] });

  if (task.status !== "open") {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ This task is no longer open.")] });
  }

  if (task.slotsFilled >= task.maxSlots) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ All slots for this task have been filled.")] });
  }

  if (user.trustScore < task.minTrustScore) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Trust score too low (${user.trustScore}). This task requires at least ${task.minTrustScore}.`)],
    });
  }

  // Per-task karma + account-age gates. Default 0/0 means "no gate".
  const taskRow = task as typeof task & { minKarma?: number; minAccountAgeDays?: number };
  const minKarma = taskRow.minKarma ?? 0;
  const minAge = taskRow.minAccountAgeDays ?? 0;
  if (minKarma > 0 || minAge > 0) {
    const userKarma = (user.redditPostKarma ?? 0) + (user.redditCommentKarma ?? 0);
    const userAge = user.redditAccountAgeDays ?? 0;
    const fails: string[] = [];
    if (minKarma > 0 && userKarma < minKarma) fails.push(`Karma: **${userKarma.toLocaleString()}** / ${minKarma.toLocaleString()} required`);
    if (minAge > 0 && userAge < minAge) fails.push(`Account age: **${userAge}** / ${minAge} days required`);
    if (fails.length > 0) {
      return interaction.editReply({
        embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ This task has Reddit gates you don't meet:\n\n${fails.map((f) => `• ${f}`).join("\n")}`)],
      });
    }
  }

  // Block users from claiming the same task more than once via DIFFERENT proofs.
  // (We already block exact-URL dupes on submit; this catches "claim, submit,
  // claim again, submit a slightly different proof".)
  // BYPASS: tasks created in a campaign with allow_multi_claim=true intentionally
  // permit the same user to claim/submit multiple times. The MAX_CONCURRENT_CLAIMS
  // and TASK_COOLDOWN_MINUTES guards above still apply to prevent spam.
  const taskAllowsMulti = (task as typeof task & { allowMultiClaim?: boolean }).allowMultiClaim === true;
  const maxClaimsPerUser: number = (task as any).maxClaimsPerUser ?? 1;

  if (!taskAllowsMulti) {
    const priorOnTask = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM submissions WHERE discord_id = ${discordId} AND task_id = ${taskId}`
    );
    const priorCount = parseInt(priorOnTask.rows[0]?.count ?? "0");

    if (maxClaimsPerUser > 1) {
      // Per-user cap is greater than 1 (set via /bulktask max_claims_per_user).
      if (priorCount >= maxClaimsPerUser) {
        return interaction.editReply({
          embeds: [makeEmbed(COLORS.WARNING).setDescription(`⚠️ You've reached the maximum of **${maxClaimsPerUser}** submissions for this task.`)],
        });
      }
    } else {
      // Default: one-per-user
      if (priorCount > 0) {
        return interaction.editReply({
          embeds: [makeEmbed(COLORS.WARNING).setDescription("⚠️ You've already submitted proof for this task. Each task is one-per-user.")],
        });
      }
    }
  }

  // CAMPAIGN-WIDE per-user cap.
  // ---------------------------------------------------------------------
  // The dashboard label is "Allow same user to claim multiple tasks IN THIS
  // CAMPAIGN" — i.e. the cap is meant to apply across all tasks within a
  // single bulk-created campaign (operator picks "2" and one Discord user
  // should be able to do at most 2 tasks in that campaign, not 2 per task).
  // Previously we only enforced the per-task cap, so users could rack up
  // (cap × N tasks) submissions in one campaign. This gate fixes that.
  //
  // Rules:
  //   * Only runs for tasks that belong to a campaign (campaignId != null).
  //   * Only runs when the campaign was created with allow_multiple_claims=true
  //     (the operator opted into the multi-claim mode). Single-claim campaigns
  //     are already covered by the per-task block above.
  //   * cap = campaigns.max_claims_per_user; 0 means UNLIMITED (skip).
  //   * Count = distinct submissions by this discord_id across all tasks of
  //     the campaign. We count submissions (not claims) so an expired claim
  //     with no proof doesn't burn a slot.
  const taskCampaignId = (task as typeof task & { campaignId?: number | null }).campaignId ?? null;
  if (taskCampaignId != null) {
    const campRes = await db.execute<{ max_claims_per_user: number; allow_multiple_claims: boolean }>(
      sql`SELECT max_claims_per_user, allow_multiple_claims FROM campaigns WHERE id = ${taskCampaignId} LIMIT 1`
    );
    const camp = campRes.rows[0];
    if (camp && camp.allow_multiple_claims && camp.max_claims_per_user > 0) {
      const campCap = camp.max_claims_per_user;
      const priorInCampaignRes = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count
              FROM submissions s
              JOIN tasks t ON t.id = s.task_id
              WHERE s.discord_id = ${discordId}
                AND t.campaign_id = ${taskCampaignId}`
      );
      const priorInCampaign = parseInt(priorInCampaignRes.rows[0]?.count ?? "0");
      if (priorInCampaign >= campCap) {
        return interaction.editReply({
          embeds: [makeEmbed(COLORS.WARNING).setDescription(
            `⚠️ You've already claimed the maximum of **${campCap}** task${campCap === 1 ? "" : "s"} in this campaign. Wait for the next campaign to drop.`
          )],
        });
      }
    }
  }

  const now = Date.now();
  const hasActiveOnThisTask = existingClaimRows.rows.some(
    (c: any) => c.expires_at == null || new Date(c.expires_at).getTime() > now
  );
  if (hasActiveOnThisTask && !taskAllowsMulti) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.WARNING).setDescription("⚠️ You already have an active claim on this task.")],
    });
  }

  // Permanent re-claim block. If this user previously claimed this task and
  // let the 15-min window expire, claimExpirer wrote a row to task_claim_blocks
  // and this user can NEVER reclaim this specific task again (admin override
  // via DELETE /admin/claim-blocks/:taskId/:discordId). Bypass for tasks that
  // explicitly allow multi-claim — that's an intentional power-user mode.
  if (!taskAllowsMulti) {
    const blockRes = await db.execute<{ reason: string }>(
      sql`SELECT reason FROM task_claim_blocks WHERE task_id = ${taskId} AND discord_id = ${discordId} LIMIT 1`
    );
    if (blockRes.rows.length > 0) {
      return interaction.editReply({
        embeds: [makeEmbed(COLORS.DANGER).setDescription(
          "🚫 You let the 15-minute claim window expire on this task earlier, so you can't claim it again. Other tasks are unaffected — pick a different one."
        )],
      });
    }
  }

  // Hard cap claim hold at 15 minutes regardless of task.timeLimitMinutes —
  // if the user hasn't submitted by then, the slot returns to #tasks.
  const expiresAt = new Date(Date.now() + CLAIM_TIMEOUT_MINUTES * 60 * 1000);

  // Atomic slot reservation: the conditional UPDATE is the source of truth.
  // If two users race here, only one will reserve the last slot — the other gets rowCount=0.
  //
  // Also RE-CHECK MAX_CONCURRENT_CLAIMS inside the transaction. The check at
  // L368 above reads activeClaimsRes from BEFORE this transaction begins, so
  // a user spamming /claim across multiple tasks in parallel could pass that
  // check on each parallel invocation and end up holding more than the cap.
  // The "claimed" + not-expired filter mirrors that earlier query so the
  // result is consistent. On overflow we roll the slot increment back via
  // throw → drizzle aborts the txn.
  const reservation = await db.transaction(async (tx: any) => {
    const updated = await tx.execute(
      sql`UPDATE tasks SET slots_filled = slots_filled + 1
          WHERE id = ${taskId} AND status = 'open' AND slots_filled < max_slots
          RETURNING *`
    );
    if (updated.rowCount === 0) return null;
    const activeInTxn = await tx.execute(
      sql`SELECT COUNT(*)::text AS count
            FROM claims
           WHERE discord_id = ${discordId}
             AND status = 'claimed'
             AND (expires_at IS NULL OR expires_at > NOW())`
    ) as any;
    if (parseInt(activeInTxn.rows[0]?.count ?? "0") >= MAX_CONCURRENT_CLAIMS) {
      throw new Error("CONCURRENT_CAP_EXCEEDED");
    }
    const [c] = await tx.insert(claims).values({
      taskId,
      userId: user.id,
      discordId,
      status: "claimed",
      expiresAt,
    }).returning();
    return { claim: c, updatedTaskRow: updated.rows[0]! };
  }).catch((err: any) => {
    if (err?.message === "CONCURRENT_CAP_EXCEEDED") return "CAP_EXCEEDED" as const;
    throw err;
  });

  if (reservation === "CAP_EXCEEDED") {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.WARNING).setDescription(
        MAX_CONCURRENT_CLAIMS === 1
          ? `⚠️ You already have an active claim. Submit your proof for it before claiming another task.`
          : `⚠️ You can only hold **${MAX_CONCURRENT_CLAIMS}** active claims at once.`
      )],
    });
  }

  invalidateTask(taskId);

  if (!reservation) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ All slots filled while you were claiming. Try another task!")],
    });
  }

  const claim = reservation.claim;
  if (!claim) return interaction.editReply({ content: "❌ Failed to create claim." });

  // Map the snake_case row from execute() back to camelCase shape used by the rest of the handler.
  const r = reservation.updatedTaskRow as any;
  const updatedTask: any = {
    ...task,
    slotsFilled: Number(r.slots_filled),
    maxSlots: Number(r.max_slots),
    status: r.status as string,
    channelMessageId: r.channel_message_id as string | null,
    isHot: !!r.is_hot,
    hotMarkedAt: r.hot_marked_at ?? null,
  };

  // Feature #3 — hot task auto-marker. Promote a task to "hot" when fills
  // are coming in fast: >=50% in <15 min, or >=80% in <30 min. One-way:
  // tasks never un-hot. Best-effort; never blocks the claim flow.
  try {
    if (!updatedTask.isHot && updatedTask.maxSlots > 1) {
      const fillRatio = updatedTask.slotsFilled / updatedTask.maxSlots;
      const ageMin = (Date.now() - new Date((task as any).createdAt).getTime()) / 60000;
      const qualifies = (fillRatio >= 0.5 && ageMin < 15) || (fillRatio >= 0.8 && ageMin < 30);
      if (qualifies) {
        const upd = await db.execute(
          sql`UPDATE tasks SET is_hot = true, hot_marked_at = NOW()
              WHERE id = ${taskId} AND is_hot = false
              RETURNING is_hot, hot_marked_at`
        );
        if (upd.rowCount && upd.rowCount > 0) {
          updatedTask.isHot = true;
          updatedTask.hotMarkedAt = (upd.rows[0] as any).hot_marked_at;
          logger.info({ taskId, fillRatio, ageMin }, "Task auto-marked as HOT");
        }
      }
    }
  } catch (err) {
    logger.warn({ err, taskId }, "Hot-task auto-marker failed (non-fatal)");
  }

  // Merge-mode campaign summary refresh — sub-tasks don't have their own
  // public message, so the only place workers see the new claim is on the
  // single summary embed. Fire-and-forget; never blocks the claim reply.
  void refreshCampaignSummary(updatedTask.campaignId);

  if (updatedTask.channelMessageId) {
    const { tasksChannel } = await setupGuild(guild);
    try {
      const msg = await tasksChannel.messages.fetch(updatedTask.channelMessageId);
      // Keep the public #tasks embed MINIMAL — never leak instructions/comments.
      // Only Claim button (disabled when full) is shown publicly.
      const isFull = updatedTask.slotsFilled >= updatedTask.maxSlots;
      const cardEmbed = buildPublicTaskEmbed(updatedTask);
      const progressEmbed = updatedTask.campaignId
        ? await buildCampaignProgressEmbed(updatedTask.campaignId)
        : null;
      await msg.edit({
        embeds: progressEmbed ? [cardEmbed, progressEmbed] : [cardEmbed],
        components: [buildPublicButtons(updatedTask.id, isFull || updatedTask.status !== "open")],
      });
    } catch {
      logger.warn({ taskId }, "Could not re-edit task message");
    }
  }

  const workspaceCh = await getOrCreateWorkspaceChannel(guild, member);
  if (!user.workspaceChannelId) {
    await db.update(users).set({ workspaceChannelId: workspaceCh.id }).where(eq(users.discordId, discordId));
  }

  const unixExpiry = Math.floor(expiresAt.getTime() / 1000);
  const twitterTask = isTwitterTask(task.type);
  const quoraTask = isQuoraTask(task.type);
  const platform = getPlatformLabel(task.type);
  const linkLabel = `${platform} Link`;
  const openLabel = `Open ${platform}`;

  // For post-type tasks, the `title` is the actual Reddit post title the
  // worker must use. For other types, `title` is just a Discord-side label
  // and shouldn't be shown as something to copy. Code blocks (```) give mobile
  // Discord a native copy button — critical for phone users.
  const isPostTask = task.type === "post";
  const fence = (s: string) => "```\n" + s.replace(/```/g, "''") + "\n```";

  const wsFields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Type", value: task.type, inline: true },
    { name: "Reward", value: formatMoney(task.reward), inline: true },
    { name: `🔗 ${linkLabel} (tap to open / long-press to copy)`, value: `${fence(task.redditLink)}` },
    // Instructions are optional — only render the field when supplied so Discord
    // doesn't reject the embed (empty field values are invalid).
    ...(task.instructions && task.instructions.trim()
      ? [{ name: "📖 Instructions (what to do)", value: task.instructions }]
      : []),
  ];

  if (isPostTask) {
    wsFields.push({ name: "📝 Post Title — paste this as the Reddit post title", value: fence(task.title.slice(0, 280)) });
    if (task.prewrittenComment) {
      wsFields.push({ name: "📄 Post Body — paste this as the Reddit post body", value: fence(task.prewrittenComment.slice(0, 900)) });
    }
  } else if (task.prewrittenComment) {
    const label = (twitterTask || quoraTask) ? `📜 ${platform} Script — paste this exactly` : "💬 Comment Text — paste this exactly as your reply";
    wsFields.push({ name: label, value: fence(task.prewrittenComment.slice(0, 900)) });
  }

  const wsEmbed = makeEmbed(COLORS.ACCENT)
    .setTitle(`📋 Task Claimed — Task #${task.id}`)
    .setDescription(`You have until <t:${unixExpiry}:R> to complete and submit this task.`)
    .addFields(...wsFields)
    .setFooter({ text: `Claim #${claim.id} — Task #${taskId}` });

  const wsButtons: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId(`claim:submit:${claim.id}`).setLabel("Submit Proof").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setURL(task.redditLink).setLabel(openLabel).setStyle(ButtonStyle.Link),
  ];

  if (isPostTask) {
    wsButtons.push(new ButtonBuilder().setCustomId(`claim:copytitle:${claim.id}`).setLabel("📋 Copy Title").setStyle(ButtonStyle.Secondary));
    if (task.prewrittenComment) {
      wsButtons.push(new ButtonBuilder().setCustomId(`claim:copybody:${claim.id}`).setLabel("📋 Copy Body").setStyle(ButtonStyle.Secondary));
    }
  } else if (task.prewrittenComment) {
    wsButtons.push(new ButtonBuilder().setCustomId(`claim:copy:${claim.id}`).setLabel("📋 Copy Comment").setStyle(ButtonStyle.Secondary));
  }

  // Voluntary reject — claimer changed their mind. Same end-state as a
  // claim-expiry: slot reopens to #tasks, this user gets a permanent
  // block on re-claiming THIS specific task (anti-spam), and the reason
  // is logged to #rejected-tasks.
  wsButtons.push(
    new ButtonBuilder().setCustomId(`claim:reject:${claim.id}`).setLabel("Reject Task").setStyle(ButtonStyle.Danger),
  );

  const wsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(wsButtons);
  const wsMsg = await workspaceCh.send({ embeds: [wsEmbed], components: [wsRow] });
  await db.update(claims).set({ workspaceMessageId: wsMsg.id }).where(eq(claims.id, claim.id));

  // Ephemeral reply to the claimer with FULL task details (instructions,
  // pre-written comment, etc.) — same content as the workspace embed but
  // delivered as a private follow-up so they don't have to context-switch.
  const ephFields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: "Type", value: task.type, inline: true },
    { name: "Reward", value: formatMoney(task.reward), inline: true },
    { name: `🔗 ${linkLabel} (tap to open / long-press to copy)`, value: fence(task.redditLink) },
    ...(task.instructions && task.instructions.trim()
      ? [{ name: "📖 Instructions (what to do)", value: task.instructions.slice(0, 1000) }]
      : []),
  ];
  if (isPostTask) {
    ephFields.push({ name: "📝 Post Title — paste this as the Reddit post title", value: fence(task.title.slice(0, 280)) });
    if (task.prewrittenComment) {
      ephFields.push({ name: "📄 Post Body — paste this as the Reddit post body", value: fence(task.prewrittenComment.slice(0, 1000)) });
    }
  } else if (task.prewrittenComment) {
    const label = (twitterTask || quoraTask) ? `📜 ${platform} Script — paste this exactly` : "💬 Comment Text — paste this exactly as your reply";
    ephFields.push({ name: label, value: fence(task.prewrittenComment.slice(0, 1000)) });
  }

  const ephemeralEmbed = makeEmbed(COLORS.SUCCESS)
    .setTitle(`✅ Task #${task.id} Claimed`)
    .setDescription(
      `You have **${CLAIM_TIMEOUT_MINUTES} minutes** to complete and submit. Expires <t:${unixExpiry}:R>.\n` +
      `Workspace: <#${workspaceCh.id}> (use the Submit Proof button there).`
    )
    .addFields(...ephFields)
    .setFooter({ text: `Claim #${claim.id} — Task #${taskId}` });

  await interaction.editReply({ embeds: [ephemeralEmbed] });

  logger.info({ claimId: claim.id, taskId, discordId }, "Task claimed");
}

export async function handleTaskDetails(interaction: ButtonInteraction, taskId: number) {
  await interaction.deferReply({ flags: 64 });
  const task = await getTaskByIdCached(taskId);
  if (!task) return interaction.editReply({ content: "❌ Task not found." });
  await interaction.editReply({ embeds: [buildTaskEmbed(task)] });
}

export async function handleClaimSubmit(interaction: ButtonInteraction, claimId: number) {
  // CRITICAL: showModal() must be the FIRST interaction response within 3 seconds.
  // We do NOT make any DB calls here — full validation happens in handleClaimSubmitModal.
  const modal = new ModalBuilder()
    .setCustomId(`claim:submitmodal:${claimId}`)
    .setTitle("Submit Proof");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("proof_link")
        .setLabel("Proof Link (URL of your post / comment)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(500)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("screenshot_url")
        .setLabel("Screenshot URL (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(500)
    )
  );

  await interaction.showModal(modal);
}

/**
 * Reject button — opens a modal asking for a reason. The actual rejection
 * happens in handleClaimRejectModal so the user has a chance to explain.
 */
export async function handleClaimReject(interaction: ButtonInteraction, claimId: number) {
  const modal = new ModalBuilder()
    .setCustomId(`claim:rejectmodal:${claimId}`)
    .setTitle("Reject this task");
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Why are you rejecting it?")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMinLength(5)
        .setMaxLength(500)
        .setPlaceholder("e.g. Link is broken, instructions unclear, can't access subreddit…"),
    ),
  );
  await interaction.showModal(modal);
}

/**
 * Reject-modal submit. Mirrors the claim-expiry flow:
 *  - atomic transition claims.status 'claimed' → 'expired' (only for THIS user)
 *  - decrement tasks.slots_filled exactly once
 *  - INSERT into task_claim_blocks so they can't reclaim THIS task
 *  - refresh the public #tasks card so the slot is visibly available
 *  - log the reason to #rejected-tasks (mod-only)
 *  - disable the workspace buttons on the original claim message
 *
 * All post-DB work is best-effort and never reverses the rejection.
 */
export async function handleClaimRejectModal(interaction: ModalSubmitInteraction, claimId: number) {
  await interaction.deferReply({ flags: 64 });
  const reason = interaction.fields.getTextInputValue("reason").trim();
  const discordId = interaction.user.id;

  // All three DB writes happen in a single transaction so we can never end
  // up in a partial state (claim flipped to expired but slot still held, or
  // slot freed but no re-claim block). The status-gate inside the UPDATE
  // still guarantees we race-cleanly with the claimExpirer cron: only one
  // transaction can flip 'claimed' → 'expired', the other no-ops.
  const txResult = await db.transaction(async (tx: any) => {
    const r = await tx.execute(
      sql`UPDATE claims
            SET status = 'expired'
          WHERE id = ${claimId}
            AND status = 'claimed'
            AND discord_id = ${discordId}
        RETURNING task_id, workspace_message_id`,
    );
    if (r.rowCount === 0) return null;
    const tId = parseInt((r.rows[0] as any).task_id);
    const wsId = (r.rows[0] as any).workspace_message_id as string | null;

    // Free the slot (single decrement — guaranteed by the atomic gate above).
    await tx.execute(
      sql`UPDATE tasks SET slots_filled = GREATEST(0, slots_filled - 1) WHERE id = ${tId}`,
    );

    // Permanent re-claim block on THIS specific task (same as expiry).
    await tx.execute(
      sql`INSERT INTO task_claim_blocks (task_id, discord_id, reason)
          VALUES (${tId}, ${discordId}, 'rejected_by_user')
          ON CONFLICT (task_id, discord_id) DO NOTHING`,
    );

    return { taskId: tId, workspaceMessageId: wsId };
  });

  if (!txResult) {
    return interaction.editReply({ content: "❌ This claim is no longer active. Nothing to reject." });
  }

  // Refresh merge-mode campaign summary so the freed slot reappears as
  // "available" on the single embed. Best-effort; never blocks the reply.
  try {
    const [tRow] = await db.select({ campaignId: tasks.campaignId }).from(tasks).where(eq(tasks.id, txResult.taskId)).limit(1);
    if (tRow?.campaignId) void refreshCampaignSummary(tRow.campaignId);
  } catch { /* swallow */ }

  const { taskId, workspaceMessageId } = txResult;

  invalidateClaim(claimId);
  invalidateTask(taskId);

  // Best-effort post-processing: refresh public card + log to #rejected-tasks
  // + disable workspace buttons. Wrapped so a failure here can never undo
  // the slot release.
  try {
    const guild = interaction.guild;
    if (guild) {
      const { tasksChannel, rejectedTasksChannel } = await setupGuild(guild);
      const refreshedRows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
      const refreshed = refreshedRows[0];

      // Refresh / repost the public #tasks card so the freed slot is visible.
      if (refreshed && refreshed.status === "open" && refreshed.slotsFilled < refreshed.maxSlots) {
        const reopenEmbed = makeEmbed(COLORS.PRIMARY)
          .setTitle("🔄 Slot Reopened")
          .setDescription(
            `**Task #${refreshed.id}** — **${refreshed.title}**\n\n` +
            `A worker's submission was rejected, so the slot is back. Grab it!`
          );
        let reopenSent = false;
        if (refreshed.channelMessageId) {
          try {
            const msg = await (tasksChannel as any).messages.fetch(refreshed.channelMessageId);
            const cardEmbed2 = buildPublicTaskEmbed(refreshed);
            const progressEmbed2 = refreshed.campaignId
              ? await buildCampaignProgressEmbed(refreshed.campaignId)
              : null;
            await msg.edit({
              embeds: progressEmbed2 ? [cardEmbed2, progressEmbed2] : [cardEmbed2],
              components: [buildPublicButtons(refreshed.id, false)],
            });
            // Reply so members get a clickable jump-link to the actual task.
            await msg.reply({
              embeds: [reopenEmbed],
              allowedMentions: { repliedUser: false, parse: [] },
            }).catch(() => {});
            reopenSent = true;
          } catch (err) {
            logger.warn({ err, taskId }, "Could not refresh public task card after reject");
          }
        }
        if (!reopenSent) {
          await (tasksChannel as any).send({
            embeds: [reopenEmbed],
            allowedMentions: { parse: [] },
          }).catch(() => {});
        }
      }

      // Mod-only audit log.
      const rejectEmbed = makeEmbed(COLORS.WARNING)
        .setTitle("❌ Task Rejected by Worker")
        .setDescription(refreshed?.title ? `**${refreshed.title}**` : `Task #${taskId}`)
        .addFields(
          { name: "Task ID", value: `#${taskId}`, inline: true },
          { name: "Type", value: refreshed?.type ?? "?", inline: true },
          { name: "Reward", value: refreshed ? formatMoney(refreshed.reward) : "?", inline: true },
          { name: "Worker", value: `<@${discordId}>`, inline: true },
          { name: "Reason", value: reason.slice(0, 1000) },
        )
        .setFooter({ text: `Claim #${claimId}` })
        .setTimestamp(new Date());
      await rejectedTasksChannel.send({
        embeds: [rejectEmbed],
        allowedMentions: { parse: [] },
      }).catch((err: unknown) => logger.warn({ err, taskId }, "rejected-tasks channel post failed"));

      // Disable buttons on the workspace claim message.
      if (workspaceMessageId) {
        try {
          const ch = interaction.channel as any;
          if (ch?.messages?.fetch) {
            const wsMsg = await ch.messages.fetch(workspaceMessageId);
            const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`noop:rejected:${claimId}`)
                .setLabel("Task Rejected — slot reopened")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            );
            await wsMsg.edit({ components: [disabledRow] });
          }
        } catch (err) {
          logger.debug({ err, taskId, claimId }, "Could not disable workspace buttons after reject");
        }
      }
    }
  } catch (err) {
    logger.warn({ err, taskId, claimId }, "Reject post-processing failed (non-fatal)");
  }

  await interaction.editReply({
    content:
      `❌ Task #${taskId} rejected. The slot is back in #tasks for someone else.\n` +
      `(You can't reclaim this specific task — pick a different one. Reason logged to mods.)`,
  });
}

export async function handleClaimCopy(
  interaction: ButtonInteraction,
  claimId: number,
  kind: "comment" | "title" | "body" = "comment"
) {
  await interaction.deferReply({ flags: 64 });
  const claim = await getClaimByIdCached(claimId);
  if (!claim) return interaction.editReply({ content: "❌ Claim not found." });

  const task = await getTaskByIdCached(claim.taskId);
  if (!task) return interaction.editReply({ content: "❌ Task not found." });

  let content: string | null = null;
  let label = "comment";
  if (kind === "title") {
    content = task.title || null;
    label = "post title";
  } else if (kind === "body") {
    content = task.prewrittenComment || null;
    label = "post body";
  } else {
    content = task.prewrittenComment || null;
    label = "comment";
  }

  if (!content) return interaction.editReply({ content: `❌ No ${label} set for this task.` });

  // Plain text inside a fenced code block — Discord mobile shows a native
  // copy icon on the block. We escape any stray ``` to prevent breaking out.
  const safe = content.replace(/```/g, "''");
  await interaction.editReply({ content: `📋 **Copy this ${label}** (tap the copy icon on mobile):\n\`\`\`\n${safe}\n\`\`\`` });
}

export async function handleClaimSubmitModal(interaction: ModalSubmitInteraction, claimId: number) {
  // Defer FIRST and never let it fail silently. If Discord rejects the defer
  // (3s window expired, unknown interaction, etc.) we log loudly and bail so
  // we don't waste DB cycles on a dead interaction.
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (err) {
    logger.error({ err, claimId }, "handleClaimSubmitModal: deferReply failed (likely 3s window expired)");
    return;
  }

  // Read modal fields DEFENSIVELY. discord.js's getTextInputValue() throws
  // when an optional field row was omitted by the client. We must not let
  // that crash the handler — fall back to empty/null.
  const safeField = (id: string): string => {
    try { return interaction.fields.getTextInputValue(id) ?? ""; }
    catch { return ""; }
  };
  const proofLink = safeField("proof_link").trim();
  const screenshotUrl = safeField("screenshot_url").trim() || null;

  if (!proofLink) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Proof link is required.")] });
  }
  try { new URL(proofLink); } catch {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Proof link must be a valid URL.")] });
  }

  // Detect Reddit app links / share links that can't be validated by the API.
  // share_link_resolvable (/r/sub/s/XXXX) is now handled server-side by the
  // validator (HEAD redirect → canonical URL), so we let those through.
  // All other app-link kinds (app_scheme, app_link, short_link) must be rejected.
  const appUrlKind = detectAppUrl(proofLink);
  if (appUrlKind && appUrlKind !== "share_link_resolvable") {
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.WARNING)
          .setTitle("⚠️ App link detected — can't verify automatically")
          .setDescription(appUrlHelpMessage(appUrlKind))
          .setFooter({ text: "Copy the browser URL and resubmit • " + (interaction.client as any).user?.tag }),
      ],
    });
  }

  // Fan-out independent reads in parallel for fast first-byte response.
  // Normalise the proof URL first: strip query params (UTM tracking, etc.) so
  // the same comment submitted with ?utm_source=share vs no params is still
  // caught as a duplicate. The original URL is kept for display / storage.
  const normalisedProofLink = (() => {
    try {
      const u = new URL(proofLink);
      u.search = "";
      u.hash = "";
      return u.toString().replace(/\/$/, "");
    } catch {
      return proofLink;
    }
  })();

  const [dupProof, claim, user, dupUserOnTaskRes] = await Promise.all([
    // Check BOTH exact URL and normalised URL so neither variant slips through.
    db.select({ id: submissions.id }).from(submissions).where(
      or(
        eq(submissions.proofLink, proofLink),
        eq(submissions.proofLink, normalisedProofLink),
      )
    ).limit(1),
    getClaimByIdCached(claimId),
    getUserByDiscordId(interaction.user.id),
    db.execute<{ count: string; allow_multi_claim: boolean | null }>(
      sql`SELECT COUNT(s.id)::text AS count,
                 BOOL_OR(t.allow_multi_claim) AS allow_multi_claim
          FROM claims c
          INNER JOIN tasks t ON t.id = c.task_id
          LEFT JOIN submissions s ON s.task_id = c.task_id AND s.discord_id = ${interaction.user.id}
          WHERE c.id = ${claimId}`
    ),
  ]);

  if (dupProof.length > 0) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ This exact proof link was already submitted.")],
    });
  }

  // Anti-cheat: same user submitting multiple proofs to the same task.
  // BYPASS: campaigns flagged allow_multi_claim intentionally permit repeat submissions
  // (the 3-active-claim cap and 30-min cooldown enforced at /claim time still apply).
  const submitTaskAllowsMulti = dupUserOnTaskRes.rows[0]?.allow_multi_claim === true;
  if (!submitTaskAllowsMulti && parseInt(dupUserOnTaskRes.rows[0]?.count ?? "0") > 0) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You've already submitted proof for this task. One submission per task per user.")],
    });
  }

  if (!claim || claim.discordId !== interaction.user.id) return interaction.editReply({ content: "❌ Claim not found." });
  // CRITICAL anti-fraud gate: only an actively-claimed claim can be submitted.
  // Without this, a user whose claim was cancelled/expired could still submit
  // proof if the workspace embed lock failed (channel deleted, message gone,
  // permissions glitch, etc.). The DB is the source of truth.
  if (claim.status !== "claimed") {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(
        "❌ This claim is no longer active. It may have been cancelled by an admin, expired, or already submitted."
      )],
    });
  }
  if (!user) return interaction.editReply({ content: "❌ User not found." });

  const task = await getTaskByIdCached(claim.taskId);
  if (!task) return interaction.editReply({ content: "❌ Task not found." });

  const twitterTask = isTwitterTask(task.type);
  const quoraTask = isQuoraTask(task.type);
  const needsManualReview = twitterTask || quoraTask;
  let validation: Awaited<ReturnType<typeof validateRedditProof>> | null = null;

  if (!needsManualReview) {
    // CRITICAL anti-cheat check: user must have a verified Reddit username on file.
    // Without this, the validator's author check is skipped (expectedAuthor === "") and
    // anyone could submit anyone else's Reddit post as proof.
    if (!user.redditUsername) {
      return interaction.editReply({
        embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You must link your Reddit account first. Run `/verify` to link it before submitting Reddit proofs.")],
      });
    }
    // Multi-Reddit-account: the proof author is acceptable if it matches ANY
    // of this Discord user's verified Reddit accounts. We always include the
    // primary `users.reddit_username` (legacy + still authoritative for
    // backfill) and append everything in `reddit_accounts`.
    const accountsRes = await db.execute<{ reddit_username: string }>(
      sql`SELECT reddit_username FROM reddit_accounts WHERE discord_id = ${interaction.user.id}`
    );
    const expectedAuthors = Array.from(new Set([
      user.redditUsername.toLowerCase(),
      ...accountsRes.rows.map((r) => (r.reddit_username ?? "").toLowerCase()),
    ].filter((u) => u.length > 0)));
    const authorDisplay = expectedAuthors.length <= 1
      ? `u/${expectedAuthors[0] ?? user.redditUsername}`
      : expectedAuthors.map((u) => `u/${u}`).join(" or ");
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.PRIMARY).setDescription(`🔍 Verifying proof is in the right subreddit and posted by **${authorDisplay}**…`)],
    });
    validation = await validateRedditProof(proofLink, expectedAuthors, task.redditLink, {
      taskCreatedAt: task.createdAt ?? undefined,
      taskType: task.type,
    });
  } else {
    const platformName = twitterTask ? "Twitter" : "Quora";
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.PRIMARY).setDescription(`📩 Submitting your ${platformName} proof for manual review…`)],
    });
  }

  // ATOMIC CAS — flip the claim row claimed→submitted in a single statement
  // FIRST. The check at L1029 above (claim.status !== "claimed") is read from
  // a stale cached copy, so two parallel /submit interactions on the same
  // claim could both pass it and end up creating two submission rows for one
  // claim. Gating on the conditional UPDATE here ensures exactly one
  // interaction wins; the loser bails out cleanly instead of double-paying
  // when the reviewer accepts.
  const claimCas = await db.execute<{ id: number }>(
    sql`UPDATE claims SET status = 'submitted' WHERE id = ${claimId} AND status = 'claimed' RETURNING id`
  );
  if (claimCas.rows.length === 0) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(
        "❌ This claim was already submitted or is no longer active. Refresh and try a fresh task."
      )],
    });
  }

  const [sub] = await db.insert(submissions).values({
    claimId,
    taskId: claim.taskId,
    userId: user.id,
    discordId: interaction.user.id,
    proofLink,
    screenshotUrl,
    reward: task.reward,
    reviewStatus: "pending",
  }).returning();

  if (!sub) {
    // Roll the CAS back so the worker isn't stuck with a "submitted" claim
    // and no submission row.
    await db.execute(sql`UPDATE claims SET status = 'claimed' WHERE id = ${claimId} AND status = 'submitted'`).catch(() => {});
    return interaction.editReply({ content: "❌ Failed to create submission." });
  }
  invalidateClaim(claimId);

  // Lock the workspace embed for this claim immediately on submit, so the
  // Submit Proof button can't be clicked again and the user sees a clear
  // "submitted, awaiting review" state. Fire-and-forget; failures are logged
  // but do not break the submission flow.
  if (claim.workspaceMessageId) {
    (async () => {
      try {
        // Always look the workspace channel up from users.workspace_channel_id
        // because (a) modal interactions can have null channel and (b) the
        // claims table has no workspace_channel_id column.
        let ch: any = interaction.channel ?? null;
        if (!ch || !("messages" in ch)) {
          const userRow = await db.execute<{ workspace_channel_id: string | null }>(
            sql`SELECT workspace_channel_id FROM users WHERE discord_id = ${interaction.user.id} LIMIT 1`
          );
          const wsChannelId = userRow.rows[0]?.workspace_channel_id;
          if (wsChannelId && interaction.guild) {
            ch = await interaction.guild.channels.fetch(wsChannelId).catch(() => null);
          }
        }
        if (ch && "messages" in ch) {
          const wsMsg = await (ch as any).messages.fetch(claim.workspaceMessageId).catch(() => null);
          if (wsMsg) {
            await wsMsg.edit({
              embeds: [
                makeEmbed(COLORS.MUTED)
                  .setTitle(`📨 Task #${claim.taskId} — Proof Submitted`)
                  .setDescription(`Your proof has been received and is awaiting verification. You'll be notified once it clears.`)
              ],
              components: [],
            });
          }
        }
      } catch (err) {
        logger.warn({ err, claimId }, "Could not lock workspace embed on submit");
      }
    })();
  }

  // Cooldown begins at submit (not at admin accept). For non-Reddit tasks
  // the cooldown lives on users.last_task_completed_at. For Reddit tasks we
  // ALSO stamp the specific reddit_accounts row that was used, so only that
  // account is gated for the next cooldown window — the user's other linked
  // Reddit accounts remain free to claim immediately.
  await db.execute(sql`UPDATE users SET last_task_completed_at = NOW() WHERE id = ${user.id}`);

  try {
    const submitTaskType = (task?.type ?? "").toLowerCase();
    const submitIsReddit = !isTwitterTask(submitTaskType) && !isQuoraTask(submitTaskType);
    if (submitIsReddit) {
      // Prefer the author the validator actually saw on the proof URL; fall
      // back to the user's primary linked username so a missing validator
      // result still stamps something sensible.
      const usedAuthor = (validation?.authorFound ?? user.redditUsername ?? "").toString().replace(/^u\//i, "").trim();
      if (usedAuthor) {
        await db.execute(
          sql`UPDATE submissions SET reddit_username_used = ${usedAuthor} WHERE id = ${sub.id}`
        ).catch(() => {});
        // Lower() for case-insensitive match — Reddit usernames are stored
        // as the user typed them but compared case-insensitively elsewhere.
        await db.execute(
          sql`UPDATE reddit_accounts
                SET last_used_at = NOW()
                WHERE discord_id = ${interaction.user.id}
                  AND LOWER(reddit_username) = LOWER(${usedAuthor})`
        ).catch(() => {});
      }
    }
  } catch (err) {
    logger.warn({ err, submissionId: sub.id }, "Per-Reddit-account cooldown stamp failed (non-fatal)");
  }

  invalidateUser(interaction.user.id, user.id);

  // Fire-and-forget mirror to Google Sheets — DB-driven so it picks up the
  // per-campaign webhook URL automatically (falls back to global env var).
  // Wrapped + non-awaited so it CANNOT slow down or break this submission.
  logSubmissionEvent(sub.id, "submitted");

  // ---- #6 Anti-fraud auto-flag -------------------------------------------
  // Flags the user (does NOT block this submission) when:
  //  (a) they submitted >= BURST_MAX in the last BURST_WINDOW_SECONDS, OR
  //  (b) their linked Reddit account is younger than MIN_REDDIT_ACCOUNT_AGE_DAYS.
  // Failures are swallowed so the submission flow is never broken.
  try {
    if (!user.flagged) {
      const burstRes = await db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count FROM submissions
            WHERE discord_id = ${interaction.user.id}
              AND submitted_at >= NOW() - (${ANTI_FRAUD.BURST_WINDOW_SECONDS} || ' seconds')::interval`
      );
      const burstCount = parseInt(burstRes.rows[0]?.count ?? "0");
      const tooYoung =
        typeof user.redditAccountAgeDays === "number" &&
        user.redditAccountAgeDays > 0 &&
        user.redditAccountAgeDays < ANTI_FRAUD.MIN_REDDIT_ACCOUNT_AGE_DAYS;
      const burstHit = burstCount >= ANTI_FRAUD.BURST_MAX_SUBMISSIONS;
      if (burstHit || tooYoung) {
        const reason = burstHit
          ? `auto-flag: ${burstCount} submissions within ${ANTI_FRAUD.BURST_WINDOW_SECONDS}s`
          : `auto-flag: Reddit account age ${user.redditAccountAgeDays}d < ${ANTI_FRAUD.MIN_REDDIT_ACCOUNT_AGE_DAYS}d`;
        await db.update(users).set({ flagged: true }).where(eq(users.id, user.id));
        await db.insert(trustLogs).values({
          userId: user.id,
          discordId: interaction.user.id,
          delta: 0,
          reason,
          relatedSubmissionId: sub.id,
        }).catch(() => {});
        invalidateUser(interaction.user.id, user.id);
        logger.info({ discordId: interaction.user.id, burstCount, redditAgeDays: user.redditAccountAgeDays }, "Anti-fraud auto-flag triggered");
      }
    }
  } catch (err) {
    logger.warn({ err, discordId: interaction.user.id }, "Anti-fraud check failed");
  }
  // ------------------------------------------------------------------------

  const guild = interaction.guild!;
  const { taskLogsChannel } = await setupGuild(guild);

  if (!needsManualReview && validation?.autoApproved) {
    // Proof passed initial Reddit validation. Place the submission in a
    // "pending_hold" state — the reward is NOT credited yet. The pending
    // processor re-checks Reddit after the hold period expires; only if the
    // comment is still live at that point does the reward pay out. This
    // ensures the hold window is a genuine "comment must stay live" gate, not
    // just a delay before an irreversible credit.
    //
    // Minimum 10-minute hold so there is always a window to catch immediate
    // deletions even on tasks configured with pendingDelayHours = 0.
    const MIN_HOLD_MS = 10 * 60 * 1000;
    const availableAt = new Date(Math.max(
      Date.now() + task.pendingDelayHours * 60 * 60 * 1000,
      Date.now() + MIN_HOLD_MS
    ));

    await db.update(submissions).set({
      reviewStatus: "pending_hold",
      reviewedAt: new Date(),
      availableAt,
      reviewReason: `Auto-validated via ${validation.verifiedVia ?? "reddit"} — awaiting hold`,
      reviewerDiscordId: "system",
      liveStatus: "live",
      lastCheckedAt: new Date(),
      liveStatusChangedAt: new Date(),
      proofVerifiedVia: validation.verifiedVia ?? null,
    }).where(eq(submissions.id, sub.id));

    await db.update(claims).set({ status: "accepted" }).where(eq(claims.id, claimId));
    invalidateClaim(claimId);

    // Balance and trust are credited only after the hold-end liveness
    // re-check passes — see pendingProcessor.ts (pending_hold branch).

    invalidateUser(user.discordId, user.id);
    invalidateLeaderboard(guild.id);
    invalidateStreak(user.discordId);

    const unixAvail = Math.floor(availableAt.getTime() / 1000);
    const holdHoursDisplay = task.pendingDelayHours > 0
      ? `${task.pendingDelayHours}h`
      : "10 minutes";
    const v = validation!;
    const upsLabel = typeof v.upvotes === "number" ? `${v.upvotes} ups` : "—";
    const ageLabel = typeof v.ageMinutes === "number"
      ? (v.ageMinutes < 60 ? `${v.ageMinutes}m old` : `${Math.floor(v.ageMinutes / 60)}h old`)
      : "—";

    await taskLogsChannel.send({
      embeds: [
        makeEmbed(COLORS.WARNING)
          .setTitle(`${v.statusEmoji} Validated — Pending Hold (${holdHoursDisplay})`)
          .addFields(
            { name: "Worker", value: `<@${interaction.user.id}>\n[💬 Open Profile / DM](https://discord.com/users/${interaction.user.id})${user.workspaceChannelId ? `\n📂 Workspace: <#${user.workspaceChannelId}>` : ""}`, inline: true },
            { name: "Task", value: `#${task.id} — ${task.title}`, inline: true },
            { name: "Reward", value: formatMoney(task.reward), inline: true },
            { name: "Proof Link", value: proofLink },
            { name: "Reddit Status", value: `${v.statusEmoji} **${v.statusLabel}** • ${upsLabel} • ${ageLabel}\nu/${v.authorFound} in r/${v.subredditFound}` },
          )
          .setFooter({ text: `Submission #${sub.id} — pending hold | re-checked <t:${unixAvail}:R>` }),
      ],
    });

    await interaction.editReply({
      embeds: [
        makeEmbed(COLORS.WARNING)
          .setTitle(`${v.statusEmoji} Proof Validated — Hold Period Started`)
          .setDescription(
            `Your comment is **${v.statusLabel.toLowerCase()}** with **${upsLabel}**.\n\n` +
            `Your proof is in the **${holdHoursDisplay} verification hold**. Keep your comment live — ` +
            `it will be re-checked at <t:${unixAvail}:F>. If it is still live then, **${formatMoney(task.reward)}** will be paid out automatically.`
          ),
      ],
    });

    try {
      await member_dm(guild, user.discordId, makeEmbed(COLORS.WARNING)
        .setTitle("⏳ Proof Validated — Verification Hold")
        .setDescription(
          `Your submission for **${task.title}** passed initial validation!\n\n` +
          `**Keep your comment live.** It will be re-checked at <t:${unixAvail}:F>.\n` +
          `If it is still live at that point, **${formatMoney(sub.reward)}** will be added to your balance automatically.`
        ));
    } catch {}

    logger.info({ subId: sub.id, claimId, discordId: interaction.user.id, availableAt, holdHours: task.pendingDelayHours }, "Submission placed in pending_hold");

    return;
  }

  const platformName = twitterTask ? "Twitter" : quoraTask ? "Quora" : "Reddit";
  const validationHeader = !needsManualReview && validation
    ? `${validation.statusEmoji} **${validation.statusLabel}**`
    : "";
  const failureText = needsManualReview
    ? `${platformName} task — requires manual review by an admin.`
    : validation && validation.failures.length > 0
      ? `${validationHeader}\n${validation.failures.join("\n")}`
      : "Validation inconclusive — queued for manual review.";

  const reviewTitle = needsManualReview
    ? `📥 ${platformName} Submission Review`
    : validation
      ? `${validation.statusEmoji} Submission — ${validation.statusLabel}`
      : "📥 Submission Review";

  const reviewEmbed = makeEmbed(COLORS.WARNING)
    .setTitle(reviewTitle)
    .addFields(
      // See "Worker" comment in the auto-validated embed above — same
      // mention + direct profile-URL fallback so the operator can
      // always reach the worker even when Discord renders the mention
      // as a raw ID and refuses to open it on mobile.
      { name: "Worker", value: `<@${interaction.user.id}>\n[💬 Open Profile / DM](https://discord.com/users/${interaction.user.id})${user.workspaceChannelId ? `\n📂 Workspace: <#${user.workspaceChannelId}>` : ""}`, inline: true },
      { name: "Task", value: `#${task.id} — ${task.title}`, inline: true },
      { name: "Reward", value: formatMoney(task.reward), inline: true },
      { name: "Task Created by", value: formatTaskCreator(task.creatorDiscordId), inline: true },
      { name: needsManualReview ? `${platformName} Proof` : "Proof Link", value: proofLink },
      ...(screenshotUrl ? [{ name: "Screenshot", value: screenshotUrl }] : []),
      { name: needsManualReview ? "📋 Review Needed" : "🔍 Validation Result", value: `⚠️ **Requires Manual Review**\n${failureText}` },
    )
    .setFooter({ text: `Submission #${sub.id} | Claim #${claimId} • Bot auto-decides after 24h if no action (re-checks Reddit; accepts if live, rejects if still removed)` });

  const reviewRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`sub:accept:${sub.id}`).setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sub:reject:${sub.id}`).setLabel("Reject").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`sub:flag:${sub.id}`).setLabel("Flag").setStyle(ButtonStyle.Secondary)
  );

  const logMsg = await taskLogsChannel.send({ embeds: [reviewEmbed], components: [reviewRow] });
  await db.update(submissions).set({ logMessageId: logMsg.id }).where(eq(submissions.id, sub.id));

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.WARNING)
        .setTitle("⏳ Submission Queued for Review")
        .setDescription(`Submission #${sub.id} requires manual review.\n\n**Reason:**\n${failureText}`),
    ],
  });

  logger.info({ subId: sub.id, claimId, discordId: interaction.user.id, autoApproved: false, failures: validation?.failures ?? [] }, "Submission queued for manual review");
}

async function member_dm(guild: any, discordId: string, embed: EmbedBuilder) {
  const m = await guild.members.fetch(discordId).catch(() => null);
  if (m) await m.send({ embeds: [embed] }).catch(() => {});
}

async function handleReferralAndLeaderboard(guild: any, discordId: string, userId: number) {
  try {
    const ref = await tryCompleteReferral(discordId, userId);
    if (ref.completed && ref.referrerDiscordId) {
      await member_dm(guild, ref.referrerDiscordId, makeEmbed(COLORS.SUCCESS)
        .setTitle("🎉 Referral Completed!")
        .setDescription(`One of your referrals just completed their first task! **+$0.40** has been added to your available balance.`));
    }
  } catch (err) {
    logger.error({ err, discordId }, "Referral completion error");
  }
  await refreshLeaderboard(guild).catch(() => {});
}

export async function handleSubAccept(interaction: ButtonInteraction, subId: number) {
  await interaction.deferUpdate();

  const subRows = await db.select().from(submissions).where(eq(submissions.id, subId)).limit(1);
  const sub = subRows[0];
  if (!sub) return interaction.followUp({ content: "❌ Submission not found.", flags: 64 });
  if (sub.reviewStatus !== "pending") return interaction.followUp({ content: "❌ Already reviewed.", flags: 64 });

  const taskRows = await db.select().from(tasks).where(eq(tasks.id, sub.taskId)).limit(1);
  const task = taskRows[0];
  if (!task) return interaction.followUp({ content: "❌ Task not found.", flags: 64 });

  const user = await getUserByDiscordId(sub.discordId);
  if (!user) return interaction.followUp({ content: "❌ User not found.", flags: 64 });

  // Enforce 10-minute minimum hold so early liveness check runs before payout.
  const MIN_HOLD_MS = 10 * 60 * 1000;
  const availableAt = new Date(Math.max(
    Date.now() + task.pendingDelayHours * 60 * 60 * 1000,
    Date.now() + MIN_HOLD_MS
  ));

  // ATOMIC CAS — the pending-status check above is a read, then this UPDATE
  // is a separate write. Two reviewers clicking Accept at the same instant
  // (or Accept on the bot card while another admin clicks Approve on the
  // dashboard) would BOTH pass the pending check and BOTH credit the
  // reward → double-pay. The WHERE review_status = 'pending' gate makes
  // sure only one of them gets rowCount=1; the other falls through and
  // we bail before crediting balance_pending again.
  const acceptCas = await db.execute<{ id: number }>(
    sql`UPDATE submissions SET
            review_status = 'accepted',
            reviewer_discord_id = ${interaction.user.id},
            reviewed_at = NOW(),
            available_at = ${availableAt},
            live_status = 'live',
            last_checked_at = NOW(),
            live_status_changed_at = NOW()
          WHERE id = ${subId} AND review_status = 'pending'
          RETURNING id`
  );
  if (acceptCas.rows.length === 0) {
    return interaction.followUp({ content: "❌ Already reviewed by someone else.", flags: 64 });
  }

  await db.update(claims).set({ status: "accepted" }).where(eq(claims.id, sub.claimId));
  invalidateClaim(sub.claimId);

  await db.execute(
    // total_earned ("Lifetime Earnings") is credited only when pending → available.
    sql`UPDATE users SET balance_pending = balance_pending + ${sub.reward}::numeric, last_task_completed_at = NOW() WHERE id = ${user.id}`
  );
  await db.execute(sql`UPDATE users SET trust_score = GREATEST(0, trust_score + 2) WHERE id = ${user.id}`);
  await db.insert(trustLogs).values({ userId: user.id, discordId: sub.discordId, delta: 2, reason: "submission accepted", relatedSubmissionId: subId }).catch(() => {});
  invalidateUser(user.discordId, user.id);
  invalidateLeaderboard(interaction.guild!.id);
  invalidateStreak(user.discordId);
  safeSyncEarnerRoles(user.discordId);

  const unixAvail = Math.floor(availableAt.getTime() / 1000);
  const originalEmbed = interaction.message.embeds[0];
  const updatedEmbed = EmbedBuilder.from(originalEmbed).setColor(COLORS.SUCCESS)
    .setFooter({ text: `Accepted by ${interaction.user.username} — available <t:${unixAvail}:R>` });
  await interaction.message.edit({ embeds: [updatedEmbed], components: [] });

  const guild = interaction.guild!;
  await member_dm(guild, sub.discordId, makeEmbed(COLORS.SUCCESS)
    .setTitle("✅ Task Accepted!")
    .setDescription(`Your submission for **${task.title}** was accepted!\n\n**${formatMoney(sub.reward)}** added to pending balance. Available <t:${unixAvail}:R>.`));

  await handleReferralAndLeaderboard(guild, sub.discordId, user.id);

  // Mirror the accept event to the accountant's Google Sheet (per-campaign
  // URL → env fallback → no-op). Fire-and-forget; can never block or break.
  logSubmissionEvent(subId, "accepted");

  logger.info({ subId, reviewer: interaction.user.id }, "Submission accepted");
}

export async function handleSubReject(interaction: ButtonInteraction, subId: number) {
  const modal = new ModalBuilder()
    .setCustomId(`sub:reason:reject:${subId}`)
    .setTitle("Reject Submission");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Rejection reason").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
    )
  );

  await interaction.showModal(modal);
}

export async function handleSubFlag(interaction: ButtonInteraction, subId: number) {
  const modal = new ModalBuilder()
    .setCustomId(`sub:reason:flag:${subId}`)
    .setTitle("Flag Submission");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Flag reason").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
    )
  );

  await interaction.showModal(modal);
}

export async function handleSubReviewReason(
  interaction: ModalSubmitInteraction,
  action: "reject" | "flag",
  subId: number
) {
  await interaction.deferUpdate();

  const reason = interaction.fields.getTextInputValue("reason");
  const subRows = await db.select().from(submissions).where(eq(submissions.id, subId)).limit(1);
  const sub = subRows[0];
  if (!sub) return interaction.followUp({ content: "❌ Submission not found.", flags: 64 });
  if (sub.reviewStatus !== "pending") return interaction.followUp({ content: "❌ Already reviewed.", flags: 64 });

  const trustDelta = action === "flag" ? -10 : -3;
  const newStatus = action === "flag" ? "flagged" : "rejected";

  // ATOMIC CAS — same TOCTOU concern as handleSubAccept. Two reviewers
  // double-clicking Reject would both pass the pending check above and
  // both apply the trust penalty + slots_filled decrement, leaving the
  // user double-penalized and the slot count under-counted.
  const rejectCas = await db.execute<{ id: number }>(
    sql`UPDATE submissions SET
            review_status = ${newStatus},
            reviewer_discord_id = ${interaction.user.id},
            review_reason = ${reason},
            reviewed_at = NOW()
          WHERE id = ${subId} AND review_status = 'pending'
          RETURNING id`
  );
  if (rejectCas.rows.length === 0) {
    return interaction.followUp({ content: "❌ Already reviewed by someone else.", flags: 64 });
  }

  await db.update(claims).set({ status: newStatus }).where(eq(claims.id, sub.claimId));
  invalidateClaim(sub.claimId);
  await db.execute(sql`UPDATE tasks SET slots_filled = GREATEST(0, slots_filled - 1) WHERE id = ${sub.taskId}`);
  invalidateTask(sub.taskId);

  // Refresh merge-mode campaign summary (slot just freed up).
  try {
    const [tRow] = await db.select({ campaignId: tasks.campaignId }).from(tasks).where(eq(tasks.id, sub.taskId)).limit(1);
    if (tRow?.campaignId) void refreshCampaignSummary(tRow.campaignId);
  } catch { /* swallow */ }

  // Public #tasks notice: refresh the task card and reply to it so members
  // see a freed slot land with a clickable jump-link. Wrapped — never blocks
  // the review flow. Only fires on reject (slot is genuinely back); flags
  // also free the slot but the user is being removed for abuse, so we skip
  // the celebratory "grab it!" ping in that case.
  if (action === "reject" && interaction.guild) {
    try {
      const { tasksChannel } = await setupGuild(interaction.guild);
      const [refreshedT] = await db.select().from(tasks).where(eq(tasks.id, sub.taskId)).limit(1);
      if (refreshedT && refreshedT.status === "open" && refreshedT.slotsFilled < refreshedT.maxSlots) {
        const reopenEmbed = makeEmbed(COLORS.PRIMARY)
          .setTitle("🔄 Slot Reopened")
          .setDescription(
            `**Task #${refreshedT.id}** — **${refreshedT.title}**\n\n` +
            `A submission was rejected, so the slot is back. Grab it!`
          );
        let reopenSent = false;
        if (refreshedT.channelMessageId) {
          try {
            const msg = await (tasksChannel as any).messages.fetch(refreshedT.channelMessageId);
            const card = buildPublicTaskEmbed(refreshedT);
            const prog = refreshedT.campaignId
              ? await buildCampaignProgressEmbed(refreshedT.campaignId)
              : null;
            await msg.edit({
              embeds: prog ? [card, prog] : [card],
              components: [buildPublicButtons(refreshedT.id, false)],
            }).catch(() => {});
            await msg.reply({
              embeds: [reopenEmbed],
              allowedMentions: { repliedUser: false, parse: [] },
            }).catch(() => {});
            reopenSent = true;
          } catch (err) {
            logger.warn({ err, taskId: sub.taskId }, "Could not refresh public task card after submission review");
          }
        }
        if (!reopenSent) {
          await (tasksChannel as any).send({
            embeds: [reopenEmbed],
            allowedMentions: { parse: [] },
          }).catch(() => {});
        }
      }
    } catch (err) {
      logger.warn({ err, taskId: sub.taskId }, "Failed to post slot-reopened notice after submission review");
    }
  }
  await db.execute(sql`UPDATE users SET trust_score = GREATEST(0, trust_score + ${trustDelta}) WHERE discord_id = ${sub.discordId}`);
  invalidateUser(sub.discordId);

  if (action === "flag") {
    await db.execute(sql`UPDATE users SET flagged = true WHERE discord_id = ${sub.discordId}`);
    invalidateUser(sub.discordId);
  }

  const user = await getUserByDiscordId(sub.discordId);
  if (user) {
    await db.insert(trustLogs).values({
      userId: user.id, discordId: sub.discordId, delta: trustDelta,
      reason: `submission ${action}ed`, relatedSubmissionId: subId,
    }).catch(() => {});
  }

  const originalEmbed = interaction.message?.embeds[0];
  if (originalEmbed) {
    const color = action === "flag" ? COLORS.MUTED : COLORS.DANGER;
    const updatedEmbed = EmbedBuilder.from(originalEmbed).setColor(color)
      .setFooter({ text: `${action === "flag" ? "Flagged" : "Rejected"} by ${interaction.user.username}: ${reason}` });
    await interaction.message?.edit({ embeds: [updatedEmbed], components: [] });
  }

  const guild = interaction.guild;
  if (!guild) {
    // Should never happen for a guild-scoped review interaction, but the
    // earlier `interaction.guild!` non-null assertion would crash the
    // process if Discord ever delivered a stale interaction without a
    // resolved guild. Bail cleanly instead — DB state is already committed.
    logger.warn({ subId }, "handleSubReviewReason: missing interaction.guild after DB commit");
    return;
  }
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, sub.taskId)).limit(1);
  const task = taskRows[0];
  await member_dm(guild, sub.discordId, makeEmbed(COLORS.DANGER)
    .setTitle(action === "flag" ? "🚩 Submission Flagged" : "❌ Submission Rejected")
    .setDescription(`Your submission for **${task?.title ?? "Unknown Task"}** was ${action}ed.\n\n**Reason:** ${reason}`));

  // Post the rejection/flag notice as a REPLY to the original task embed
  // in the worker's private workspace channel so they see the verdict
  // right under the task card they originally claimed (instead of having
  // to hunt for the DM). Fire-and-forget — DB state is already committed
  // and the DM above is the primary channel, so a workspace post failure
  // (channel deleted, no permissions, original message gone) must not
  // break the review flow.
  (async () => {
    try {
      const claimRow = await db.select().from(claims).where(eq(claims.id, sub.claimId)).limit(1);
      const wsMessageId = claimRow[0]?.workspaceMessageId;
      const wsChannelId = user?.workspaceChannelId;
      if (!wsMessageId || !wsChannelId) return;
      const ch = await guild.channels.fetch(wsChannelId).catch(() => null);
      if (!ch || !("messages" in ch)) return;
      const original = await (ch as any).messages.fetch(wsMessageId).catch(() => null);
      const replyEmbed = makeEmbed(action === "flag" ? COLORS.MUTED : COLORS.DANGER)
        .setTitle(action === "flag" ? "🚩 Submission Flagged" : "❌ Submission Rejected")
        .setDescription(
          `Your submission for **${task?.title ?? `Task #${sub.taskId}`}** was ${action}ed.\n\n` +
          `**Reason:** ${reason}\n\n` +
          (action === "reject"
            ? `The slot has been reopened in #tasks — you can grab a fresh task there.`
            : `Your account has been flagged for review. Reach out to staff if you think this is a mistake.`)
        );
      if (original) {
        await original.reply({ embeds: [replyEmbed], allowedMentions: { repliedUser: false } });
      } else {
        // Original task card was deleted (channel cleanup, etc) — still
        // post the notice into the workspace channel so the worker has
        // a record of WHY they didn't get paid.
        await (ch as any).send({ content: `<@${sub.discordId}>`, embeds: [replyEmbed] });
      }
    } catch (err) {
      logger.warn({ err, subId, claimId: sub.claimId }, "Could not post reject/flag notice to workspace channel");
    }
  })();

  // Mirror reject/flag to the accountant's sheet so they have a record of
  // every rejected proof too (not just paid ones). Fire-and-forget.
  logSubmissionEvent(subId, action === "flag" ? "flagged" : "rejected");

  logger.info({ subId, action, reviewer: interaction.user.id }, `Submission ${action}ed`);
}
