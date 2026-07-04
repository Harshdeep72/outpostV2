import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type TextChannel,
} from "discord.js";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { tasks, campaigns, campaignQueue } from "@workspace/db";
import { setupGuild } from "./setup.js";
import { makeEmbed, formatMoney } from "./util.js";
import {
  COLORS,
  TASK_TYPES,
  isTwitterTask,
  isQuoraTask,
  getPlatformLabel,
  TASK_PING_DELAY_MS,
  type TaskType,
} from "./constants.js";
import { extractTaskSubreddit } from "./reddit-validator.js";
import { logger } from "../lib/logger.js";

const VALID_TYPES = new Set(TASK_TYPES as readonly string[]);

/**
 * Build the "📦 Campaign progress" mini-embed that goes underneath each bulk
 * task's public #tasks card. Returns null when the campaign doesn't exist or
 * has zero tasks, in which case callers fall back to embedding the task card
 * by itself.
 *
 * Counters:
 *   - ✅ done       — tasks fully claimed (slots_filled >= max_slots) OR closed
 *   - 🟡 in progress — at least one slot claimed but not full and still open
 *   - ⏳ unclaimed   — zero claims and still open
 *   - 📋 total       — every task in the campaign (any status)
 *
 * Cheap: a single aggregate query against the indexed `campaign_id` column.
 * Tolerates DB errors (returns null) so a transient hiccup never breaks the
 * task post — the task card itself is always sent.
 */
/** Public summary embed for a single-embed (merge-mode) campaign. Shows
 *  remaining/total slot counts so workers know whether tasks are still
 *  available without opening the campaign details. */
export async function buildCampaignSummaryEmbed(
  campaignId: number,
  fallbackTitle: string,
): Promise<EmbedBuilder> {
  let title = fallbackTitle;
  let total = 0;
  let claimed = 0;
  let remaining = 0;
  let creatorDiscordId: string | null = null;
  try {
    const r = await db.execute<{
      title: string | null;
      creator_discord_id: string | null;
      total: string;
      claimed: string;
      remaining: string;
    }>(
      sql`SELECT
            (SELECT title FROM campaigns WHERE id = ${campaignId})              AS title,
            (SELECT creator_discord_id FROM campaigns WHERE id = ${campaignId}) AS creator_discord_id,
            COUNT(*)                                                AS total,
            COUNT(*) FILTER (WHERE slots_filled >= max_slots OR status = 'closed') AS claimed,
            COUNT(*) FILTER (WHERE slots_filled = 0 AND status = 'open')           AS remaining
          FROM tasks
          WHERE campaign_id = ${campaignId} AND is_merged_subtask = TRUE`
    );
    const row: any = (r as any).rows?.[0] ?? null;
    if (row) {
      if (row.title) title = String(row.title);
      creatorDiscordId = row.creator_discord_id ?? null;
      total = Number(row.total) || 0;
      claimed = Number(row.claimed) || 0;
      remaining = Number(row.remaining) || 0;
    }
  } catch (err) {
    logger.debug({ err, campaignId }, "buildCampaignSummaryEmbed query failed");
  }
  const isOpen = remaining > 0;
  return makeEmbed(isOpen ? COLORS.PRIMARY : COLORS.MUTED)
    .setTitle(`📦 Campaign: ${title.slice(0, 200)}`)
    .setDescription(
      isOpen
        ? `**${remaining}** task${remaining === 1 ? "" : "s"} available · ${claimed}/${total} claimed\n\n` +
          `Click **🎯 Claim Next Task** below — each click gives you a different task you haven't done yet.`
        : `✅ All **${total}** tasks have been claimed. Thanks team!`
    )
    .addFields({ name: "👤 Created by", value: formatTaskCreator(creatorDiscordId), inline: true })
    .setFooter({ text: `Campaign #${campaignId}` });
}

/**
 * Best-effort refresh of a merge-mode campaign's summary embed in #tasks.
 * Called from every slot-mutation site (claim/expire/reject) so the
 * "X/Y claimed · Z available" counter stays accurate as workers grab and
 * release sub-tasks. Silent edit — no @here ping (the initial post already
 * pinged when the campaign was created).
 *
 * Resolves channel+message via campaigns.summary_message_id /
 * summary_channel_id which are stamped at campaign creation. No-op when
 * either is missing (campaign isn't merge-mode, or summary post failed).
 *
 * Wrapped in try/catch end-to-end: a Discord 404 (message deleted), missing
 * permissions, or DB hiccup must NEVER reverse the slot mutation that
 * triggered the refresh. The summary will self-correct on the next mutation.
 */
export async function refreshCampaignSummary(campaignId: number | null | undefined): Promise<void> {
  if (!campaignId || !Number.isFinite(campaignId)) return;
  try {
    const r = await db.execute<{
      summary_message_id: string | null;
      summary_channel_id: string | null;
      title: string | null;
      merge_mode: boolean | null;
    }>(
      sql`SELECT summary_message_id, summary_channel_id, title, merge_mode
            FROM campaigns WHERE id = ${campaignId} LIMIT 1`
    );
    const row: any = (r as any).rows?.[0];
    if (!row || !row.summary_message_id || !row.summary_channel_id) return;
    if (row.merge_mode === false) return;

    const { getPrimaryGuild } = await import("./discord-client.js");
    const guild = getPrimaryGuild();
    if (!guild) return;

    const channel = await guild.channels.fetch(String(row.summary_channel_id)).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const msg = await (channel as TextChannel).messages.fetch(String(row.summary_message_id)).catch(() => null);
    if (!msg) return;

    const embed = await buildCampaignSummaryEmbed(campaignId, String(row.title ?? "Campaign"));
    await msg.edit({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    logger.debug({ err, campaignId }, "refreshCampaignSummary failed (non-fatal)");
  }
}

export async function buildCampaignProgressEmbed(
  campaignId: number,
): Promise<EmbedBuilder | null> {
  try {
    const r = await db.execute<{
      title: string | null;
      total: string;
      done: string;
      in_progress: string;
      unclaimed: string;
    }>(
      sql`SELECT
            (SELECT title FROM campaigns WHERE id = ${campaignId})           AS title,
            COUNT(*)                                                          AS total,
            COUNT(*) FILTER (WHERE slots_filled >= max_slots OR status = 'closed') AS done,
            COUNT(*) FILTER (WHERE slots_filled > 0 AND slots_filled < max_slots AND status = 'open') AS in_progress,
            COUNT(*) FILTER (WHERE slots_filled = 0 AND status = 'open')      AS unclaimed
          FROM tasks
          WHERE campaign_id = ${campaignId}`
    );
    const row: any = (r as any).rows?.[0] ?? (Array.isArray(r) ? r[0] : null);
    if (!row || !row.title) return null;
    const total = Number(row.total);
    if (!Number.isFinite(total) || total === 0) return null;
    const done = Number(row.done);
    const inProgress = Number(row.in_progress);
    const unclaimed = Number(row.unclaimed);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: `📦 Campaign: ${String(row.title).slice(0, 200)}` })
      .setDescription(
        `✅ **${done}** done   ·   🟡 **${inProgress}** in progress   ·   ` +
          `⏳ **${unclaimed}** unclaimed   ·   📋 **${total}** total   (${pct}%)`,
      );
  } catch (err) {
    logger.debug({ err, campaignId }, "buildCampaignProgressEmbed failed");
    return null;
  }
}

export interface CreateTaskInput {
  type: string;
  /** Optional for all types EXCEPT "post" (Reddit post needs a title for the post itself). */
  title?: string;
  /** For Reddit "post": subreddit (r/foo or full URL). Otherwise: full post/tweet URL. */
  link: string;
  instructions: string;
  /** For Reddit "post": ignored — use postBody/flair instead. */
  prewrittenComment?: string | null;
  /** Only for Reddit "post". */
  postBody?: string | null;
  /** Only for Reddit "post". */
  flair?: string | null;
  reward: number;
  slots: number;
  timeLimitMinutes?: number;
  holdHours?: number;
  minTrustScore?: number;
  /** Optional public URL of an attached image. Shown in the Discord task embed. */
  imageUrl?: string | null;
  /** When true, multiple Discord users restrictions are relaxed: a single user
   *  may claim and submit proof for this task more than once. Set per-campaign
   *  via the bulk import / Sheets import flow. Default false. */
  allowMultiClaim?: boolean;
  /** Maximum number of times a single user can claim tasks in this campaign/task.
   *  0 means unlimited (same as allowMultiClaim=true). Default 1 (one per user). */
  maxClaimsPerUser?: number;
  /** Per-task cooldown override. When false, this task ignores the global
   *  task-cooldown gate (still respects MAX_CONCURRENT_CLAIMS). Default true. */
  cooldownEnabled?: boolean;
  creatorDiscordId: string;
}

export interface NormalizedTask {
  type: string;
  title: string;
  redditLink: string;
  instructions: string;
  prewrittenComment: string | null;
  reward: number;
  slots: number;
  timeLimitMinutes: number;
  holdHours: number;
  minTrustScore: number;
  imageUrl: string | null;
  allowMultiClaim: boolean;
  maxClaimsPerUser: number;
  cooldownEnabled: boolean;
  creatorDiscordId: string;
  /**
   * When true, the unclaimedNotifier scheduler is allowed to repeatedly delete
   * + re-post this task's channel message with an @here ping while it stays
   * fully unclaimed. Carried on NormalizedTask so the drip-queue payload
   * preserves the flag across serialization. Default false (only set true by
   * bulk-task creation paths).
   */
  enableUnclaimedNotify?: boolean;
  /**
   * Backref to the parent campaign (NULL for one-off tasks). When set,
   * createTaskAndPost stamps `tasks.campaign_id` so the campaign-progress
   * mini-embed renders at the bottom of every public #tasks card for this task.
   * Carried on NormalizedTask so the drip-queue JSON payload preserves it.
   */
  campaignId?: number;
}

/** Auto-generate a friendly title when the admin leaves the field blank. */
function autoTitle(type: string, link: string): string {
  // Reddit (non-post)
  if (["comment", "thread_reply", "op_reply", "upvote", "share", "join"].includes(type)) {
    const sub = extractTaskSubreddit(link);
    const verb =
      type === "comment" ? "Comment" :
      type === "thread_reply" ? "Reply in thread" :
      type === "op_reply" ? "OP reply" :
      type === "upvote" ? "Upvote" :
      type === "share" ? "Share" :
      "Join";
    return sub ? `${verb} on r/${sub}` : `Reddit ${type} task`;
  }
  if (type.startsWith("twitter_")) {
    const action = type.slice("twitter_".length).replace(/_/g, " ");
    return `Twitter ${action} task`;
  }
  if (type.startsWith("quora_")) {
    const action = type.slice("quora_".length).replace(/_/g, " ");
    return `Quora ${action} task`;
  }
  return `${type} task`;
}

/** Validates raw input and returns a normalized task or an error message. */
export function normalizeTaskInput(input: CreateTaskInput): { ok: true; task: NormalizedTask } | { ok: false; error: string } {
  const type = (input.type ?? "").toLowerCase().trim();
  if (!VALID_TYPES.has(type)) return { ok: false, error: `Invalid task type "${type}".` };

  let title = (input.title ?? "").trim();
  if (!title) {
    if (type === "post") return { ok: false, error: "Title is required for Reddit post tasks (it's used as the post title)." };
    title = autoTitle(type, (input.link ?? "").trim());
  }
  if (title.length > 1000) return { ok: false, error: "Title must be 1000 characters or fewer." };

  const imageUrlRaw = (input.imageUrl ?? "").trim();
  let imageUrl: string | null = null;
  if (imageUrlRaw) {
    if (!/^https?:\/\//i.test(imageUrlRaw)) {
      return { ok: false, error: "Image URL must start with http:// or https://" };
    }
    if (imageUrlRaw.length > 2000) {
      return { ok: false, error: "Image URL is too long." };
    }
    imageUrl = imageUrlRaw;
  }

  // Instructions are OPTIONAL. When blank we still store an empty string in
  // the (NOT NULL) DB column and the embed renderers skip the Instructions
  // field entirely (Discord rejects empty field values, so a guard is required
  // at every render site — see buildSharedTaskEmbed + workspace/ephemeral embeds
  // in handlers/tasks.ts). Length cap is still enforced when supplied.
  const instructions = (input.instructions ?? "").trim();
  if (instructions.length > 1000) return { ok: false, error: "Instructions must be 1000 characters or fewer." };

  const reward = Number(input.reward);
  if (!Number.isFinite(reward) || reward < 0.01 || reward > 1000) {
    return { ok: false, error: "Reward must be a number between 0.01 and 1000." };
  }

  const slots = Number(input.slots);
  if (!Number.isInteger(slots) || slots < 1 || slots > 1000) {
    return { ok: false, error: "Slots must be an integer between 1 and 1000." };
  }

  // Cap claim hold at 20 minutes — if the user doesn't submit proof in time,
  // the slot is released back to the #tasks channel automatically.
  // The persisted timeLimitMinutes is informational; CLAIM_TIMEOUT_MINUTES (20)
  // is the actual hold enforced at claim time in handleTaskClaim.
  const timeLimitMinutes = 20;

  // Default verify/hold window changed from 24h → 7 days (168h) per product
  // request. Per-task override is honored when caller passes input.holdHours.
  const holdHours = input.holdHours ?? 168;
  if (!Number.isInteger(holdHours) || holdHours < 0 || holdHours > 720) {
    return { ok: false, error: "Hold hours must be 0–720." };
  }

  const minTrustScore = input.minTrustScore ?? 0;
  if (!Number.isInteger(minTrustScore) || minTrustScore < 0 || minTrustScore > 500) {
    return { ok: false, error: "Min trust score must be 0–500." };
  }

  const maxClaimsPerUser = input.maxClaimsPerUser ?? 1;
  if (!Number.isInteger(maxClaimsPerUser) || maxClaimsPerUser < 0 || maxClaimsPerUser > 100) {
    return { ok: false, error: "Max claims per user must be 0–100 (0 = unlimited)." };
  }

  const rawLink = (input.link ?? "").trim();
  let redditLink = rawLink;
  let prewrittenComment: string | null = null;

  if (type === "post") {
    const sub = extractTaskSubreddit(rawLink);
    if (!sub) return { ok: false, error: "Subreddit must be `r/somesub` or a `reddit.com/r/somesub` URL." };
    redditLink = `https://www.reddit.com/r/${sub}/`;
    const blocks: string[] = [];
    const flair = (input.flair ?? "").trim();
    const body = (input.postBody ?? "").trim();
    if (flair) blocks.push(`**Flair:** ${flair}`);
    if (body) blocks.push(`**Post Body:**\n${body}`);
    prewrittenComment = blocks.length ? blocks.join("\n\n") : null;
  } else if (isTwitterTask(type)) {
    if (!/^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i.test(rawLink)) {
      return { ok: false, error: "Twitter Link must be a valid twitter.com or x.com URL." };
    }
    prewrittenComment = (input.prewrittenComment ?? "").trim() || null;
  } else if (isQuoraTask(type)) {
    if (!/^https?:\/\/(www\.)?quora\.com\//i.test(rawLink)) {
      return { ok: false, error: "Quora Link must be a valid quora.com URL." };
    }
    prewrittenComment = (input.prewrittenComment ?? "").trim() || null;
  } else {
    if (!/^https?:\/\/(www\.|old\.|new\.)?reddit\.com\//i.test(rawLink)) {
      return { ok: false, error: "Reddit Link must be a valid reddit.com URL." };
    }
    prewrittenComment = (input.prewrittenComment ?? "").trim() || null;
  }

  if (prewrittenComment && prewrittenComment.length > 5000) {
    prewrittenComment = prewrittenComment.slice(0, 5000);
  }

  return {
    ok: true,
    task: {
      type, title, redditLink, instructions, prewrittenComment,
      reward, slots, timeLimitMinutes, holdHours, minTrustScore,
      imageUrl,
      allowMultiClaim: !!input.allowMultiClaim || maxClaimsPerUser === 0,
      maxClaimsPerUser,
      // Default true (cooldown ON) when caller doesn't pass it — preserves
      // pre-Phase-2 behavior for any code path that hasn't been updated yet.
      cooldownEnabled: input.cooldownEnabled !== false,
      creatorDiscordId: input.creatorDiscordId,
    },
  };
}

/**
 * Formats a task creator id for display in an embed. Real Discord user ids
 * become a `<@id>` mention (Discord renders the username); dashboard pseudo-ids
 * ("dashboard:alice") become a plain "Dashboard · alice" tag; empty/system
 * creators fall back to "Outpost".
 */
export function formatTaskCreator(creatorDiscordId: string | null | undefined): string {
  const id = (creatorDiscordId ?? "").trim();
  if (!id) return "Outpost";
  if (id.startsWith("dashboard:")) return `Dashboard · ${id.slice("dashboard:".length)}`;
  return `<@${id}>`;
}

/** Visual icon for the task platform, used in the public embed title. */
function platformIcon(type: string): string {
  if (isTwitterTask(type)) return "🐦";
  if (isQuoraTask(type)) return "📝";
  return "👾"; // reddit
}

/** Pretty type label, e.g. "twitter_like" → "Like". */
function prettyTypeLabel(type: string): string {
  if (type.startsWith("twitter_")) return type.slice("twitter_".length).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (type.startsWith("quora_")) return type.slice("quora_".length).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** 10-segment slot progress bar — visual filled/empty indicator. */
function slotBar(filled: number, max: number): string {
  const segs = 10;
  if (max <= 0) return "▱".repeat(segs);
  const ratio = Math.min(1, Math.max(0, filled / max));
  const on = Math.round(ratio * segs);
  return "▰".repeat(on) + "▱".repeat(segs - on);
}

/**
 * Public task card shown in #tasks. Visually rich: platform icon, slot
 * progress bar, color-coded by state (open/hot/closed), and a clean
 * description block.
 *
 * Callers that override the footer (autoBumper, hot-marker re-renders)
 * still work — `.setFooter()` simply replaces what's set here.
 */
export function buildPublicTaskEmbed(task: typeof tasks.$inferSelect): EmbedBuilder {
  const isFull = task.slotsFilled >= task.maxSlots;
  const isOpen = task.status === "open" && !isFull;
  const platform = getPlatformLabel(task.type);
  const redditPostTask = task.type === "post";
  const hot = !!(task as any).isHot && isOpen;

  // Link → human-readable target display.
  let linkDisplay = task.redditLink;
  if (!isTwitterTask(task.type) && !isQuoraTask(task.type)) {
    const sub = extractTaskSubreddit(task.redditLink);
    if (sub) linkDisplay = `r/${sub}`;
  } else {
    try { linkDisplay = new URL(task.redditLink).hostname.replace("www.", ""); } catch {}
  }

  // Color: green when claimable, accent-red when hot, muted when closed.
  const color = !isOpen ? COLORS.MUTED : hot ? COLORS.ACCENT : COLORS.SUCCESS;

  // Status pill in title prefix.
  const statusBadge = !isOpen ? "🔒 CLOSED" : hot ? "🔥 HOT" : "🟢 LIVE";
  const icon = platformIcon(task.type);
  const reward = formatMoney(task.reward);
  const title = task.title?.trim() || `${platform} ${prettyTypeLabel(task.type)} task`;

  // Description: short instruction teaser + link callout.
  const teaserRaw = (task.instructions ?? "").trim();
  const teaser = teaserRaw.length > 220 ? teaserRaw.slice(0, 217) + "…" : teaserRaw;
  const linkLabel = redditPostTask ? "Subreddit" : `${platform} link`;
  const desc =
    `**${statusBadge}**   ·   ${icon}  **${platform}**   ·   💰  **${reward}**\n` +
    (teaser ? `\n${teaser}\n` : "") +
    `\n🔗  **${linkLabel}:** [${linkDisplay}](${task.redditLink})`;

  const embed = makeEmbed(color)
    .setTitle(`${icon}  ${title}`)
    .setDescription(desc)
    .addFields(
      { name: "💵 Reward",   value: reward, inline: true },
      { name: "🎯 Type",     value: prettyTypeLabel(task.type), inline: true },
      { name: "📊 Slots",    value: `${slotBar(task.slotsFilled, task.maxSlots)}\n\`${task.slotsFilled}/${task.maxSlots}\` filled`, inline: true },
      { name: "⏱ Claim window", value: `${task.timeLimitMinutes} min to submit`, inline: true },
      ...(task.minTrustScore > 0 ? [{ name: "🏆 Min trust", value: `≥ ${task.minTrustScore}`, inline: true }] : []),
      { name: "👤 Created by", value: formatTaskCreator(task.creatorDiscordId), inline: true },
    )
    .setFooter({
      text:
        `Task #${task.id}` +
        (!isOpen
          ? " · CLOSED"
          : hot
          ? " · 🔥 filling fast"
          : " · Claim before it fills!"),
    })
    .setTimestamp(task.createdAt ?? new Date());

  if (task.imageUrl) embed.setImage(task.imageUrl);
  return embed;
}

/** Full-detail embed used in workspaces and /taskdetails. */
export function buildSharedTaskEmbed(task: typeof tasks.$inferSelect): EmbedBuilder {
  const isFull = task.slotsFilled >= task.maxSlots;
  const platform = getPlatformLabel(task.type);
  const redditPostTask = task.type === "post";
  const linkLabel = redditPostTask ? "Subreddit" : `${platform} Link`;
  const contentLabel = redditPostTask ? "Post Content" : "Pre-written Content";
  const embed = makeEmbed(task.status === "open" && !isFull ? COLORS.PRIMARY : COLORS.MUTED)
    .setTitle(task.title)
    .addFields(
      { name: "Type", value: task.type, inline: true },
      { name: "Reward", value: formatMoney(task.reward), inline: true },
      { name: "Slots", value: `${task.slotsFilled}/${task.maxSlots}`, inline: true },
      { name: "Time Limit", value: `${task.timeLimitMinutes} min`, inline: true },
      { name: "Hold Period", value: `${task.pendingDelayHours}h`, inline: true },
      { name: "Min Trust", value: String(task.minTrustScore), inline: true },
      { name: "Created by", value: formatTaskCreator(task.creatorDiscordId), inline: false },
      ...(task.instructions && task.instructions.trim()
        ? [{ name: "Instructions", value: task.instructions.slice(0, 1000) }]
        : []),
      { name: linkLabel, value: task.redditLink },
      ...(task.prewrittenComment ? [{ name: contentLabel, value: `||${task.prewrittenComment.slice(0, 900)}||` }] : [])
    )
    .setFooter({ text: `Task #${task.id}${task.status === "closed" || isFull ? " — CLOSED" : ""}` });
  if (task.imageUrl) embed.setImage(task.imageUrl);
  return embed;
}

/** Claim button only (no View Details). */
export function buildPublicButtons(taskId: number, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`task:claim:${taskId}`).setLabel("Claim Task").setStyle(ButtonStyle.Success).setDisabled(disabled)
  );
}

/** Full buttons for workspace/details (kept for backward compat). */
function buildButtons(taskId: number, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`task:claim:${taskId}`).setLabel("Claim Task").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`task:details:${taskId}`).setLabel("View Details").setStyle(ButtonStyle.Secondary)
  );
}

/** Insert a task row, post the task card to #tasks, and schedule the reminder ping.
 *
 * Options:
 *  - `silent: true`  → no @here/@everyone ping on the task card.
 *  - `skipReminder: true`  → do not schedule the per-task 5-min reminder ping.
 */
export async function createTaskAndPost(
  norm: NormalizedTask,
  guild: Guild,
  options: {
    silent?: boolean;
    skipReminder?: boolean;
    // When true: insert the task row but DO NOT post a #tasks card and
    // DO NOT schedule the reminder. Used by single-embed bulktask mode
    // where N sub-tasks are owned by one campaign-level summary embed.
    noPost?: boolean;
    // When set: stamp tasks.is_merged_subtask=true so the row is recognized
    // as part of a merge-mode campaign and excluded from individual lookups.
    mergedSubtask?: boolean;
    // Legacy single-image attach — still honored, kept so older callers
    // (bulk pipeline, drip queue, slash handler) compile without changes.
    imageData?: { buffer: Buffer; filename: string } | null;
    // New multi-attachment path: any mix of images + videos, up to 10.
    // First image (by mimetype heuristic on filename or contentType) is
    // promoted to embed image and persisted to tasks.image_url. Everything
    // else attaches alongside the embed as a Discord gallery.
    mediaItems?: { buffer: Buffer; filename: string; contentType: string | null }[];
  } = {}
): Promise<typeof tasks.$inferSelect> {
  const { tasksChannel } = await setupGuild(guild);

  const [task] = await db.insert(tasks).values({
    creatorDiscordId: norm.creatorDiscordId,
    title: norm.title,
    type: norm.type,
    reward: String(norm.reward),
    instructions: norm.instructions,
    redditLink: norm.redditLink,
    prewrittenComment: norm.prewrittenComment,
    timeLimitMinutes: norm.timeLimitMinutes,
    maxSlots: norm.slots,
    pendingDelayHours: norm.holdHours,
    minTrustScore: norm.minTrustScore,
    imageUrl: norm.imageUrl,
    allowMultiClaim: norm.allowMultiClaim,
    status: "open",
  }).returning();

  if (!task) throw new Error("Failed to insert task");

  // Stamp campaign_id via best-effort UPDATE (matching the rollout-safe pattern
  // used for max_claims_per_user / cooldown_enabled). .catch swallows the error
  // if the bootstrapSchema post-fix hasn't run yet on a fresh deploy — the task
  // still posts, just without the campaign-progress mini-embed.
  if (norm.campaignId != null) {
    await db.execute(
      sql`UPDATE tasks SET campaign_id = ${norm.campaignId} WHERE id = ${task.id}`
    ).catch(() => {});
  }

  // Store max_claims_per_user on the task row (safe schema migration via bootstrapSchema)
  await db.execute(
    sql`UPDATE tasks SET max_claims_per_user = ${norm.maxClaimsPerUser} WHERE id = ${task.id}`
  ).catch(() => {});

  // Stamp is_merged_subtask flag so the campaign-progress / claim-next picker
  // recognizes this row as part of a single-embed merge campaign.
  if (options.mergedSubtask) {
    await db.execute(
      sql`UPDATE tasks SET is_merged_subtask = TRUE WHERE id = ${task.id}`
    ).catch(() => {});
  }

  // Phase 2: persist per-task cooldown override. Column added in
  // bootstrapSchema. .catch swallows the error if the migration hasn't run yet
  // on a fresh deploy (default TRUE in DDL means the gate is still enforced).
  await db.execute(
    sql`UPDATE tasks SET cooldown_enabled = ${norm.cooldownEnabled} WHERE id = ${task.id}`
  ).catch(() => {});

  // Opt-in repeating unclaimed notifier (bulk-task creations only). Seed
  // last_notify_at = NOW() so the scheduler waits a full interval before the
  // first bump instead of firing instantly on its next tick.
  if (norm.enableUnclaimedNotify) {
    await db.execute(
      sql`UPDATE tasks
             SET unclaimed_notify_enabled = TRUE,
                 unclaimed_last_notify_at = NOW()
           WHERE id = ${task.id}`
    ).catch(() => {});
  }

  const files: AttachmentBuilder[] = [];
  let workingTask = task;

  // Normalize both legacy single-image input and new multi-item input into
  // one list. Legacy `imageData` is treated as a single image.
  const incoming: { buffer: Buffer; filename: string; contentType: string | null }[] = [];
  if (options.mediaItems && options.mediaItems.length) {
    incoming.push(...options.mediaItems);
  } else if (options.imageData?.buffer?.length) {
    incoming.push({ buffer: options.imageData.buffer, filename: options.imageData.filename, contentType: null });
  }

  // Helper: detect "image" vs "video" using contentType when provided, else
  // filename extension. Anything unrecognized is treated as a generic file
  // (still attached, never promoted to embed image).
  const isImage = (m: { filename: string; contentType: string | null }) => {
    if (m.contentType?.startsWith("image/")) return true;
    return /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(m.filename);
  };

  // Discord rejects duplicate attachment names within a single message, so we
  // track every name we've assigned and suffix collisions with -1/-2/... until
  // the name is unique. This is robust regardless of input order (e.g. inputs
  // [a.png, 1-a.png, a.png] all get distinct final names).
  const usedNames = new Set<string>();
  const uniqueName = (raw: string): string => {
    if (!usedNames.has(raw)) { usedNames.add(raw); return raw; }
    const dot = raw.lastIndexOf(".");
    const stem = dot > 0 ? raw.slice(0, dot) : raw;
    const ext = dot > 0 ? raw.slice(dot) : "";
    for (let n = 1; n < 1000; n++) {
      const candidate = `${stem}-${n}${ext}`;
      if (!usedNames.has(candidate)) { usedNames.add(candidate); return candidate; }
    }
    // Pathological fallback — should never hit in practice (max 10 files).
    const fallback = `${stem}-${Date.now()}${ext}`;
    usedNames.add(fallback);
    return fallback;
  };

  let firstImageAttachmentName: string | null = null;
  for (let i = 0; i < incoming.length; i++) {
    const m = incoming[i]!;
    const baseSafe = m.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || `file-${i + 1}`;
    const safeName = uniqueName(baseSafe);
    files.push(new AttachmentBuilder(m.buffer, { name: safeName }));
    if (!firstImageAttachmentName && isImage(m)) {
      firstImageAttachmentName = safeName;
    }
  }

  if (firstImageAttachmentName) {
    workingTask = { ...task, imageUrl: `attachment://${firstImageAttachmentName}` };
  }

  // noPost: sub-task in a single-embed merge campaign. Skip the #tasks card
  // and the reminder entirely — the campaign-level summary embed owns the
  // public surface; channelMessageId stays NULL on this row.
  if (options.noPost) {
    return workingTask;
  }

  const embed = buildPublicTaskEmbed(workingTask);
  const buttons = buildPublicButtons(task.id);
  // Append the campaign-progress mini-embed when this task is part of a
  // campaign. embeds[0] stays the task card so the existing image-URL
  // extraction below (`msg.embeds[0]?.image?.url`) keeps working.
  const progressEmbed = norm.campaignId
    ? await buildCampaignProgressEmbed(norm.campaignId)
    : null;
  const msg = await (tasksChannel as TextChannel).send({
    content: options.silent
      ? `🆕 Task #${task.id} — **${task.title}**`
      : "@here @everyone 🆕 **New task available!** Claim a slot before they fill up.",
    embeds: progressEmbed ? [embed, progressEmbed] : [embed],
    components: [buttons],
    allowedMentions: options.silent ? { parse: [] } : { parse: ["everyone"] },
    files: files.length ? files : undefined,
  });

  let finalImageUrl: string | null = norm.imageUrl;
  if (firstImageAttachmentName) {
    // Find the uploaded attachment that matches the image we promoted to the
    // embed (by exact name) and lift its CDN URL into tasks.image_url. Falls
    // back to embed.image.url (Discord's resolved attachment URL) and then to
    // the first attachment so we never lose an image URL we previously had.
    const named = msg.attachments.find((a) => a.name === firstImageAttachmentName);
    finalImageUrl = named?.url ?? msg.embeds[0]?.image?.url ?? msg.attachments.first()?.url ?? null;
  }
  await db.update(tasks).set({
    channelMessageId: msg.id,
    ...(finalImageUrl && finalImageUrl !== norm.imageUrl ? { imageUrl: finalImageUrl } : {}),
  }).where(eq(tasks.id, task.id));
  if (finalImageUrl && finalImageUrl !== task.imageUrl) {
    workingTask = { ...task, imageUrl: finalImageUrl, channelMessageId: msg.id };
  }

  // Skip the one-shot 5-min reminder when:
  //  - caller explicitly opts out (drip queue, silent admin creates)
  //  - the repeating unclaimedNotifier owns this task (avoid double-bump race
  //    at the 5-min mark between the setTimeout below and the scheduler tick).
  if (options.skipReminder || options.silent || norm.enableUnclaimedNotify) return workingTask;

  const savedTask = { ...workingTask, channelMessageId: msg.id };
  setTimeout(async () => {
    try {
      // Re-fetch task to check it's still open before pinging. We also pull
      // channel_message_id so we can delete the original message when the task
      // is *truly* unclaimed (slots_filled === 0) and re-post a fresh card
      // — that bumps it to the top of the channel and re-pings the workers.
      const currentRows = await db.execute<{
        status: string;
        slots_filled: number;
        max_slots: number;
        channel_message_id: string | null;
      }>(
        sql`SELECT status, slots_filled, max_slots, channel_message_id
              FROM tasks WHERE id = ${savedTask.id} LIMIT 1`
      );
      const current = currentRows.rows[0];
      if (!current) return;
      if (current.status !== "open") return;
      const slotsFilled = Number(current.slots_filled);
      const maxSlots = Number(current.max_slots);
      if (slotsFilled >= maxSlots) return;

      const channel = tasksChannel as TextChannel;

      if (slotsFilled === 0) {
        // Truly unclaimed → delete the old card and re-post a fresh one so it
        // appears at the bottom of the channel again with a fresh @here ping.
        const oldId = current.channel_message_id;
        if (oldId) {
          await channel.messages
            .fetch(oldId)
            .then((m) => m.delete())
            .catch((err) => logger.debug({ err, taskId: savedTask.id, oldId }, "Old task message already gone"));
        }
        // Pull the latest typed row so the re-posted embed reflects any edits
        // (e.g. image_url updated after the original post).
        const refreshed = await db.select().from(tasks).where(eq(tasks.id, savedTask.id)).limit(1);
        const t = refreshed[0];
        if (!t) return;
        const reminderProgress = t.campaignId
          ? await buildCampaignProgressEmbed(t.campaignId)
          : null;
        const newMsg = await channel.send({
          content: `@here @everyone ⏰ **Still unclaimed!** Bumping Task #${t.id} — **"${t.title}"** to the top. Grab it before it closes!`,
          embeds: reminderProgress
            ? [buildPublicTaskEmbed(t), reminderProgress]
            : [buildPublicTaskEmbed(t)],
          components: [buildPublicButtons(t.id)],
          allowedMentions: { parse: ["everyone"] },
        });
        await db.update(tasks).set({ channelMessageId: newMsg.id }).where(eq(tasks.id, t.id));
        // Hand-off to the repeating unclaimedNotifier: record that the first
        // bump has happened so the scheduler waits a full interval before the
        // next one (rather than firing immediately on its next tick).
        await db.execute(
          sql`UPDATE tasks
                 SET unclaimed_notify_count = GREATEST(unclaimed_notify_count, 1),
                     unclaimed_last_notify_at = NOW()
               WHERE id = ${t.id}`
        ).catch(() => {});
      } else {
        // Partial claims → keep the original message intact and just nudge the
        // channel with a reminder reply (preserves the existing claim flow on
        // the original card so in-progress workers aren't disrupted).
        await channel.send({
          content: "@here @everyone",
          embeds: [
            makeEmbed(COLORS.WARNING)
              .setTitle("⏰ Priority Reminder")
              .setDescription(
                `**Task #${savedTask.id}** — **"${savedTask.title}"** still has open slots.\n\n` +
                `**${slotsFilled}/${maxSlots}** filled — grab it before it closes!`
              ),
          ],
          allowedMentions: { parse: ["everyone"] },
        });
      }
    } catch (err) {
      logger.warn({ err, taskId: savedTask.id }, "Failed to send task reminder ping");
    }
  }, TASK_PING_DELAY_MS);

  return workingTask;
}

// ---------- CSV parsing (shared with /bulktask) ----------

export interface ParsedTaskRow {
  type: string;
  title: string;
  task_link: string;
  instructions: string;
  reward: number;
  slots: number;
  time_limit?: number;
  hold_hours?: number;
  cooldown_enabled?: boolean;
  min_trust?: number;
  prewritten_comment?: string;
  post_body?: string;
  flair?: string;
  image_url?: string;
  max_claims_per_user?: number;
}

export function parseTaskCsv(raw: string): ParsedTaskRow[] {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV must have a header row and at least one data row.");

  function splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  const headers = splitCsvLine(lines[0]!).map((h) => h.toLowerCase().replace(/[\s-]/g, "_"));
  const rows: ParsedTaskRow[] = [];
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]!);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ""; });

    const lineNum = i + 1;
    const type = (row["type"] ?? "").toLowerCase().trim();
    const title = (row["title"] ?? "").trim();
    const task_link = (row["task_link"] ?? row["twitter_link"] ?? row["reddit_link"] ?? row["subreddit"] ?? row["link"] ?? "").trim();
    const instructions = (row["instructions"] ?? "").trim();
    const rewardRaw = parseFloat(row["reward"] ?? "0");
    const slotsRaw = parseInt(row["slots"] ?? "1");
    const timeLimitRaw = row["time_limit"] ? parseInt(row["time_limit"]) : 60;
    const holdHoursRaw = row["hold_hours"] ? parseInt(row["hold_hours"]) : undefined;
    const minTrustRaw = row["min_trust"] ? parseInt(row["min_trust"]) : 0;
    const maxClaimsRaw = row["max_claims_per_user"] ? parseInt(row["max_claims_per_user"]) : 1;
    // CSV column "cooldown_enabled" — accepts "false"/"0"/"no"/"off" to disable,
    // "true"/"1"/"yes"/"on" to force-enable. If the column is absent or blank we
    // leave `cooldownEnabled` undefined so the campaign-level default wins.
    const cooldownRaw = (row["cooldown_enabled"] ?? "").toLowerCase().trim();
    let cooldownEnabled: boolean | undefined;
    if (["false", "0", "no", "off"].includes(cooldownRaw)) cooldownEnabled = false;
    else if (["true", "1", "yes", "on"].includes(cooldownRaw)) cooldownEnabled = true;
    const prewritten = (row["prewritten_comment"] ?? row["comment"] ?? "").trim() || undefined;
    const postBody = (row["post_body"] ?? row["body"] ?? "").trim() || undefined;
    const flair = (row["flair"] ?? "").trim() || undefined;
    const imageUrl = (row["image_url"] ?? row["image"] ?? "").trim() || undefined;

    if (!VALID_TYPES.has(type)) { errors.push(`Row ${lineNum}: Invalid type "${type}".`); continue; }
    if (!title && type === "post") { errors.push(`Row ${lineNum}: "post" rows require a title (used as the Reddit post title).`); continue; }
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
      errors.push(`Row ${lineNum}: image_url must start with http(s)://`); continue;
    }

    if (type === "post") {
      const sub = extractTaskSubreddit(task_link);
      if (!sub) { errors.push(`Row ${lineNum}: For "post", provide a subreddit (r/foo or reddit.com/r/foo URL).`); continue; }
    } else if (isTwitterTask(type)) {
      if (!task_link || !/^https?:\/\/(www\.)?(twitter\.com|x\.com)\//i.test(task_link)) {
        errors.push(`Row ${lineNum}: Invalid twitter link "${task_link}" — must be twitter.com or x.com.`); continue;
      }
    } else if (isQuoraTask(type)) {
      if (!task_link || !/^https?:\/\/(www\.)?quora\.com\//i.test(task_link)) {
        errors.push(`Row ${lineNum}: Invalid quora link "${task_link}" — must be quora.com.`); continue;
      }
    } else {
      if (!task_link || !/^https?:\/\/(www\.|old\.|new\.)?reddit\.com\//i.test(task_link)) {
        errors.push(`Row ${lineNum}: Invalid reddit link "${task_link}".`); continue;
      }
    }

    // Instructions are optional — no error if blank.
    if (isNaN(rewardRaw) || rewardRaw < 0.01 || rewardRaw > 1000) { errors.push(`Row ${lineNum}: Invalid reward "${row["reward"]}".`); continue; }
    if (isNaN(slotsRaw) || slotsRaw < 1 || slotsRaw > 1000) { errors.push(`Row ${lineNum}: Invalid slots "${row["slots"]}".`); continue; }

    rows.push({
      type, title, task_link, instructions,
      reward: rewardRaw, slots: slotsRaw,
      time_limit: timeLimitRaw, hold_hours: holdHoursRaw, min_trust: minTrustRaw,
      max_claims_per_user: isNaN(maxClaimsRaw) ? 1 : maxClaimsRaw,
      ...(cooldownEnabled === undefined ? {} : { cooldown_enabled: cooldownEnabled }),
      prewritten_comment: prewritten, post_body: postBody, flair,
      image_url: imageUrl,
    });
  }

  if (errors.length > 0 && rows.length === 0) {
    throw new Error(`All rows failed validation:\n${errors.slice(0, 10).join("\n")}`);
  }

  return rows;
}

export async function createTasksFromRows(
  rows: ParsedTaskRow[],
  creatorDiscordId: string,
  campaignId: number,
  guild: Guild,
  outErrors: string[],
  opts: { allowMultiClaim?: boolean; maxClaimsPerUser?: number; cooldownEnabled?: boolean; holdHoursDefault?: number; notifyUnclaimed?: boolean } = {}
): Promise<{ created: number; firstTaskId: number | null; lastTaskId: number | null }> {
  let created = 0;
  let firstTaskId: number | null = null;
  let lastTaskId: number | null = null;

  for (const row of rows) {
    try {
      const maxClaimsPerUser = row.max_claims_per_user ?? opts.maxClaimsPerUser ?? 1;
      const norm = normalizeTaskInput({
        type: row.type, title: row.title, link: row.task_link,
        instructions: row.instructions,
        prewrittenComment: row.prewritten_comment ?? null,
        postBody: row.post_body ?? null, flair: row.flair ?? null,
        reward: row.reward, slots: row.slots,
        timeLimitMinutes: row.time_limit, holdHours: row.hold_hours ?? opts.holdHoursDefault,
        minTrustScore: row.min_trust, imageUrl: row.image_url ?? null,
        allowMultiClaim: !!opts.allowMultiClaim || maxClaimsPerUser === 0,
        maxClaimsPerUser,
        cooldownEnabled: row.cooldown_enabled ?? (opts.cooldownEnabled !== false),
        creatorDiscordId,
      });
      if (!norm.ok) { outErrors.push(`"${row.title || row.task_link || row.type}": ${norm.error}`); continue; }

      if (opts.notifyUnclaimed) norm.task.enableUnclaimedNotify = true;
      norm.task.campaignId = campaignId;
      const task = await createTaskAndPost(norm.task, guild, { silent: true, skipReminder: true });
      await db.execute(
        sql`UPDATE campaigns SET tasks_created = tasks_created + 1 WHERE id = ${campaignId}`
      );
      created++;
      if (firstTaskId === null) firstTaskId = task.id;
      lastTaskId = task.id;
    } catch (err) {
      logger.error({ err, row }, "Failed to create bulk task row");
      outErrors.push(`Failed to create task "${row.title}": ${(err as any)?.message ?? "unknown error"}`);
    }
  }
  return { created, firstTaskId, lastTaskId };
}

export interface CreateBulkResult {
  campaignId: number;
  rowsFound: number;
  created: number;
  scheduled: number;
  intervalMinutes: number;
  errors: string[];
}

export async function createBulkTasksFromCsv(args: {
  csv: string;
  campaignTitle: string;
  sourceType: "csv" | "sheets";
  sourceUrl?: string | null;
  creatorDiscordId: string;
  guild: Guild;
  intervalMinutes?: number;
  allowMultipleClaims?: boolean;
  maxClaimsPerUser?: number;
  cooldownEnabled?: boolean;
  mergeIntoSingleTask?: boolean;
  /** Campaign-level default for verify/hold hours. Per-row hold_hours wins. */
  holdHoursDefault?: number;
  /** Opt-in to the repeating unclaimed-notifier scheduler for every task in
   *  this campaign. Default true at the route layer for bulk creates. */
  notifyUnclaimed?: boolean;
}): Promise<CreateBulkResult> {
  const rows = parseTaskCsv(args.csv);
  // Allow fractional minutes so sub-minute drip intervals work (e.g. 0.5 = 30s).
  const intervalMinutes = Math.max(0, Math.min(1440, args.intervalMinutes ?? 0));
  const allowMultipleClaims = !!args.allowMultipleClaims;
  const maxClaimsPerUser = args.maxClaimsPerUser ?? 1;
  const campaignCooldownDefault = args.cooldownEnabled !== false;
  // Campaign-level hold-hours default (clamped to normalizeTaskInput's 0–720 range).
  // Per-row hold_hours overrides this. Falls back to the system default (168h) when
  // neither is supplied.
  const campaignHoldHours = (() => {
    const v = args.holdHoursDefault;
    if (v == null || !Number.isFinite(v)) return undefined;
    return Math.max(0, Math.min(720, Math.floor(v)));
  })();

  const [campaign] = await db.insert(campaigns).values({
    creatorDiscordId: args.creatorDiscordId,
    title: args.campaignTitle,
    sourceType: args.sourceType,
    sourceUrl: args.sourceUrl ?? null,
    totalTasks: rows.length,
    intervalMinutes,
    allowMultipleClaims,
  }).returning();
  if (!campaign) throw new Error("Failed to create campaign");

  await db.execute(
    sql`UPDATE campaigns SET max_claims_per_user = ${maxClaimsPerUser} WHERE id = ${campaign.id}`
  ).catch(() => {});

  const errors: string[] = [];

  // ── Single-embed mode ────────────────────────────────────────────────────
  // Each CSV row becomes its own task (1 slot, full row data) but does NOT
  // post a #tasks card. Instead, ONE summary embed is posted to #tasks with
  // a "Claim Next Task" button. When a user clicks it, the bot atomically
  // picks the next sub-task this user hasn't claimed/submitted/blocked yet
  // and routes them through the normal claim flow. Reject reopens that
  // specific sub-task's slot for OTHER users (the rejected user is excluded
  // by their submissions row, so they can never get the same sub-task back).
  if (args.mergeIntoSingleTask && rows.length > 0) {
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowMaxClaims = row.max_claims_per_user ?? maxClaimsPerUser;
      const norm = normalizeTaskInput({
        type: row.type, title: row.title, link: row.task_link,
        instructions: row.instructions,
        prewrittenComment: row.prewritten_comment ?? null,
        postBody: row.post_body ?? null, flair: row.flair ?? null,
        reward: row.reward,
        // Each sub-task is single-slot. Fairness is enforced at the picker:
        // we exclude users who already have a submission/claim/block on
        // THIS sub-task, so each user receives a different row.
        slots: 1,
        timeLimitMinutes: row.time_limit,
        holdHours: row.hold_hours ?? campaignHoldHours,
        minTrustScore: row.min_trust,
        imageUrl: row.image_url ?? null,
        // Force per-task one-per-user. The campaign-level cap
        // (maxClaimsPerUser) still gates how many sub-tasks one user can
        // grab across the campaign — that's checked at claim time.
        allowMultiClaim: false,
        maxClaimsPerUser: rowMaxClaims,
        cooldownEnabled: row.cooldown_enabled ?? campaignCooldownDefault,
        creatorDiscordId: args.creatorDiscordId,
      });
      if (!norm.ok) { errors.push(`Row ${i + 1} "${row.title || row.task_link || row.type}": ${norm.error}`); continue; }
      norm.task.campaignId = campaign.id;
      norm.task.enableUnclaimedNotify = false; // summary embed owns visibility
      try {
        await createTaskAndPost(norm.task, args.guild, { noPost: true, mergedSubtask: true, skipReminder: true, silent: true });
        created++;
      } catch (err) {
        // Don't abort the whole campaign on one bad row — log and continue.
        // Already-inserted sub-tasks remain valid and will be served by the
        // summary embed; the failed row is surfaced in errors[] for the user.
        const msg = (err as Error)?.message ?? String(err);
        errors.push(`Row ${i + 1} "${row.title || row.task_link || row.type}": ${msg}`);
        logger.warn({ err, campaignId: campaign.id, rowIndex: i }, "merge-mode subtask insert failed");
      }
    }

    if (created === 0) {
      throw new Error(`No valid rows to import. Errors: ${errors.slice(0, 3).join("; ")}`);
    }

    // Flag the campaign as merge-mode and post the single summary embed.
    await db.execute(sql`UPDATE campaigns SET merge_mode = TRUE, tasks_created = ${created} WHERE id = ${campaign.id}`).catch(() => {});
    const { tasksChannel } = await setupGuild(args.guild);
    const summaryEmbed = await buildCampaignSummaryEmbed(campaign.id, args.campaignTitle);
    const summaryButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`campaign:claimnext:${campaign.id}`)
        .setLabel("🎯 Claim Next Task")
        .setStyle(ButtonStyle.Success),
    );
    const msg = await (tasksChannel as TextChannel).send({
      content: "@here @everyone 🆕 **New campaign — multiple tasks available!** Click below to grab one.",
      embeds: [summaryEmbed],
      components: [summaryButtons],
      allowedMentions: { parse: ["everyone"] },
    });
    await db.execute(
      sql`UPDATE campaigns SET summary_message_id = ${msg.id}, summary_channel_id = ${(tasksChannel as TextChannel).id} WHERE id = ${campaign.id}`
    ).catch(() => {});

    return { campaignId: campaign.id, rowsFound: rows.length, created, scheduled: 0, intervalMinutes: 0, errors };
  }

  if (intervalMinutes > 0) {
    const intervalMs = intervalMinutes * 60_000;
    const now = Date.now();
    let scheduled = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowMaxClaims = row.max_claims_per_user ?? maxClaimsPerUser;
      const norm = normalizeTaskInput({
        type: row.type, title: row.title, link: row.task_link,
        instructions: row.instructions,
        prewrittenComment: row.prewritten_comment ?? null,
        postBody: row.post_body ?? null, flair: row.flair ?? null,
        reward: row.reward, slots: row.slots,
        timeLimitMinutes: row.time_limit, holdHours: row.hold_hours ?? campaignHoldHours,
        minTrustScore: row.min_trust, imageUrl: row.image_url ?? null,
        allowMultiClaim: allowMultipleClaims || rowMaxClaims === 0,
        maxClaimsPerUser: rowMaxClaims,
        cooldownEnabled: row.cooldown_enabled ?? campaignCooldownDefault,
        creatorDiscordId: args.creatorDiscordId,
      });
      if (!norm.ok) { errors.push(`"${row.title || row.task_link || row.type}": ${norm.error}`); continue; }

      if (args.notifyUnclaimed) norm.task.enableUnclaimedNotify = true;
      norm.task.campaignId = campaign.id;
      const scheduledAt = new Date(now + i * intervalMs);
      await db.insert(campaignQueue).values({
        campaignId: campaign.id,
        guildId: args.guild.id,
        payload: norm.task as unknown as Record<string, unknown>,
        scheduledAt,
      });
      scheduled++;
    }

    return {
      campaignId: campaign.id,
      rowsFound: rows.length,
      created: 0,
      scheduled,
      intervalMinutes,
      errors,
    };
  }

  const { created, firstTaskId, lastTaskId } = await createTasksFromRows(
    rows, args.creatorDiscordId, campaign.id, args.guild, errors,
    { allowMultiClaim: allowMultipleClaims, maxClaimsPerUser, cooldownEnabled: campaignCooldownDefault, holdHoursDefault: campaignHoldHours, notifyUnclaimed: !!args.notifyUnclaimed }
  );

  if (created > 0) {
    const { tasksChannel } = await setupGuild(args.guild);
    await (tasksChannel as TextChannel).send({
      content: "@here @everyone",
      embeds: [
        makeEmbed(COLORS.SUCCESS)
          .setTitle(`📦 ${created} New Task${created === 1 ? "" : "s"} Added`)
          .setDescription(
            `Campaign: **${args.campaignTitle}**\n\nGrab your slots now before they fill up!`
          ),
      ],
      allowedMentions: { parse: ["everyone"] },
    });
  }

  return {
    campaignId: campaign.id,
    rowsFound: rows.length,
    created,
    scheduled: 0,
    intervalMinutes: 0,
    errors,
  };
}
