import {
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type TextChannel,
  type Guild,
  PermissionFlagsBits,
  ChannelType,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { pool } from "@workspace/db";
import { makeEmbed, formatMoney } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";
import {
  renderStatsCard,
  type StatsCardData,
  type StatsCardRecentRow,
  type StatsCardStatus,
  type StatsCardLive,
} from "../card-renderer.js";

// Plain-English relative-time formatter used in the PNG card.
// Discord's <t:R> markers don't render inside a rasterized PNG, so we
// compute the diff at render time from the real timestamps the DB returned.
function relTime(target: Date, anchor: Date): { sign: "future" | "past"; label: string } {
  const diffMs = target.getTime() - anchor.getTime();
  const abs = Math.abs(diffMs);
  const sign: "future" | "past" = diffMs >= 0 ? "future" : "past";
  const m = Math.round(abs / 60000);
  if (m < 1) return { sign, label: "moments" };
  if (m < 60) return { sign, label: `${m}m` };
  const h = Math.round(m / 60);
  if (h < 24) return { sign, label: `${h}h` };
  const dd = Math.round(h / 24);
  return { sign, label: `${dd}d` };
}

function mapStatus(reviewStatus: string, movedToAvailable: number): StatsCardStatus {
  if (reviewStatus === "accepted" && movedToAvailable === 1) return "cleared";
  if (reviewStatus === "accepted") return "hold";
  if (reviewStatus === "rejected") return "rejected";
  return "pending";
}
function mapLive(s: string): StatsCardLive {
  if (s === "live") return "live";
  if (s === "removed") return "removed";
  if (s === "deleted") return "deleted";
  return "unknown";
}
function whenLabel(status: StatsCardStatus, sub: RecentSub, now: Date): string {
  if (status === "cleared") {
    const at = sub.reviewed_at ? new Date(sub.reviewed_at) : null;
    if (!at) return "cleared";
    const r = relTime(at, now);
    return r.sign === "past" ? `cleared ${r.label} ago` : `cleared in ${r.label}`;
  }
  if (status === "hold") {
    const at = sub.available_at ? new Date(sub.available_at) : null;
    if (!at) return "in hold";
    const r = relTime(at, now);
    return r.sign === "future" ? `clears in ${r.label}` : `clearing now`;
  }
  if (status === "rejected") {
    const at = sub.reviewed_at ? new Date(sub.reviewed_at) : null;
    if (!at) return "rejected";
    const r = relTime(at, now);
    return r.sign === "past" ? `rejected ${r.label} ago` : `rejected in ${r.label}`;
  }
  // pending
  const r = relTime(new Date(sub.submitted_at), now);
  return r.sign === "past" ? `submitted ${r.label} ago` : `submitted in ${r.label}`;
}

// ── Rate-limit tuning ───────────────────────────────────────────────────
const WORKER_COUNT = 5;
const PER_WORKER_DELAY_MS = 600;
const PROGRESS_UPDATE_EVERY = 25;
// How many recent submissions we render line-by-line. Discord's per-field
// cap is 1024 chars, ~12 lines × ~80 chars is a safe ceiling.
const RECENT_LIMIT = 12;
const RECENT_WINDOW_DAYS = 7;

interface UserRow {
  id: number;
  discord_id: string;
  workspace_channel_id: string;
}

interface RecentSub {
  id: number;
  reward: string;
  review_status: string;     // pending | accepted | rejected
  live_status: string;       // live | removed | deleted | unknown | error | not_found
  moved_to_available: number; // 0 = still in hold, 1 = cleared into available
  available_at: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  task_title: string | null;
  task_link: string | null;
}

interface StatsRow {
  // Live wallet snapshot — straight from the users table so it matches /wallet exactly.
  bal_available: string;
  bal_pending: string;
  bal_lifetime: string;
  // Active in-progress claims.
  active_claims: string;
  // Payment-method setup.
  has_paypal: boolean;
  has_upi: boolean;
  has_crypto: boolean;
  // 7-day rollup + per-task breakdown.
  total_7d: string;
  cleared_7d: string;
  hold_7d: string;
  pending_7d: string;
  rejected_7d: string;
  removed_7d: string;
  recent_subs: RecentSub[];
}

// One round-trip per user: returns the live wallet, payment-method flags,
// 7-day status counts, AND a JSON array of the most-recent N submissions
// joined to tasks so we can render per-task lines without N+1 queries.
const STATS_SQL = `
  WITH recent AS (
    SELECT
      s.id, s.reward, s.review_status, s.live_status, s.moved_to_available,
      s.available_at, s.submitted_at, s.reviewed_at,
      t.title AS task_title, t.reddit_link AS task_link
    FROM submissions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE s.user_id = $1
      AND s.submitted_at >= NOW() - ($2 || ' days')::interval
    ORDER BY s.submitted_at DESC
  )
  SELECT
    u.balance_available::text   AS bal_available,
    u.balance_pending::text     AS bal_pending,
    u.total_earned::text        AS bal_lifetime,
    (SELECT COUNT(*) FROM claims WHERE user_id = u.id AND status = 'claimed')::text AS active_claims,
    (u.paypal_email IS NOT NULL AND u.paypal_email <> '') AS has_paypal,
    (u.upi_id IS NOT NULL AND u.upi_id <> '')             AS has_upi,
    (u.crypto_wallets IS NOT NULL AND u.crypto_wallets::text <> '{}'::text) AS has_crypto,
    (SELECT COUNT(*) FROM recent)::text                                                                AS total_7d,
    (SELECT COUNT(*) FROM recent WHERE review_status = 'accepted' AND moved_to_available = 1)::text   AS cleared_7d,
    (SELECT COUNT(*) FROM recent WHERE review_status = 'accepted' AND moved_to_available = 0)::text   AS hold_7d,
    (SELECT COUNT(*) FROM recent WHERE review_status = 'pending')::text                                AS pending_7d,
    (SELECT COUNT(*) FROM recent WHERE review_status = 'rejected')::text                               AS rejected_7d,
    (SELECT COUNT(*) FROM recent WHERE live_status IN ('removed','deleted'))::text                     AS removed_7d,
    COALESCE(
      (SELECT json_agg(row_to_json(r) ORDER BY r.submitted_at DESC)
         FROM (SELECT * FROM recent ORDER BY submitted_at DESC LIMIT $3) r),
      '[]'::json
    ) AS recent_subs
  FROM users u
  WHERE u.id = $1
`;

function tsR(d: string | Date): string {
  return `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>`;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// "Have you done anything?" → emoji + short tail per submission line.
function lineForSub(s: RecentSub): string {
  // Status emoji (where it stands in the review pipeline).
  let statusEmoji = "🔍";
  let tail = `submitted ${tsR(s.submitted_at)}`;
  if (s.review_status === "accepted" && s.moved_to_available === 1) {
    statusEmoji = "✅";
    tail = s.reviewed_at ? `cleared ${tsR(s.reviewed_at)}` : "cleared";
  } else if (s.review_status === "accepted" && s.moved_to_available === 0) {
    statusEmoji = "⏳";
    tail = s.available_at ? `clears ${tsR(s.available_at)}` : "in hold";
  } else if (s.review_status === "rejected") {
    statusEmoji = "❌";
    tail = s.reviewed_at ? `rejected ${tsR(s.reviewed_at)}` : "rejected";
  }

  // Liveness emoji (is the comment/post still up on Reddit?).
  let liveEmoji = "⚪"; // unknown / not yet checked / error / not_found
  if (s.live_status === "live") liveEmoji = "🟢";
  else if (s.live_status === "removed") liveEmoji = "🚫";
  else if (s.live_status === "deleted") liveEmoji = "🗑️";

  const title = trunc(s.task_title ?? `Task #${s.id}`, 38);
  const titleStr = s.task_link
    ? `[${title}](${s.task_link})`
    : `**${title}**`;

  return `${statusEmoji} ${liveEmoji} ${titleStr} · **${formatMoney(s.reward)}** · ${tail}`;
}

function buildStatsEmbed(row: StatsRow, discordUserId: string) {
  const total7d = parseInt(row.total_7d) || 0;
  const cleared7d = parseInt(row.cleared_7d) || 0;
  const hold7d = parseInt(row.hold_7d) || 0;
  const pending7d = parseInt(row.pending_7d) || 0;
  const rejected7d = parseInt(row.rejected_7d) || 0;
  const removed7d = parseInt(row.removed_7d) || 0;
  const active = parseInt(row.active_claims) || 0;

  // ── Description: live wallet snapshot ────────────────────────────────
  // These numbers are pulled directly from the users table so they match
  // /wallet exactly — Available = what you can withdraw RIGHT NOW.
  const desc =
    `Hey <@${discordUserId}>! Here's where you stand right now.\n\n` +
    `💰 **Available to withdraw:** **${formatMoney(row.bal_available)}**\n` +
    `⏳ **Pending (in hold period):** **${formatMoney(row.bal_pending)}**\n` +
    `📈 **Lifetime earned:** ${formatMoney(row.bal_lifetime)}\n` +
    `🎯 **Currently claimed (in progress):** ${active} task${active === 1 ? "" : "s"}\n` +
    `\nRun \`/wallet\` any time to see this card with your payment methods, or \`/withdraw\` to cash out your **Available** balance.`;

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle("📊 Your task stats so far")
    .setDescription(desc);

  // ── Field 1: per-task breakdown of the last 7 days ───────────────────
  const subs = Array.isArray(row.recent_subs) ? row.recent_subs : [];
  if (total7d === 0) {
    embed.addFields({
      name: `📋 Last ${RECENT_WINDOW_DAYS} days`,
      value: `You haven't submitted any tasks in the last ${RECENT_WINDOW_DAYS} days. Pick one up from the tasks channel whenever you're ready!`,
    });
  } else {
    // Build line by line and stop if we'd blow the 1024-char field cap.
    // We reserve the tail budget up-front so the final "+N more" line can
    // never push the field value over Discord's hard 1024 limit (which
    // would reject the embed and fail the send for that user).
    const FIELD_CAP = 1024;
    const TAIL_BUDGET = 160; // generous reserve for the "+N more" tail
    const lineCap = FIELD_CAP - TAIL_BUDGET;
    const linesOut: string[] = [];
    let used = 0;
    for (let i = 0; i < subs.length; i++) {
      const line = `${i + 1}. ${lineForSub(subs[i]!)}`;
      const next = used + (used === 0 ? line.length : line.length + 1);
      if (next > lineCap) break;
      linesOut.push(line);
      used = next;
    }
    const renderedCount = linesOut.length;
    const moreInWindow = total7d - renderedCount;
    if (moreInWindow > 0) {
      const tail = `_…and **${moreInWindow}** more in the last ${RECENT_WINDOW_DAYS} days._`;
      linesOut.push(tail);
    }
    // Final defensive truncation in case any line ran long (e.g. unusually
    // long task title or future emoji additions). Better to truncate than
    // to fail the send.
    let fieldValue = linesOut.join("\n");
    if (fieldValue.length > FIELD_CAP) {
      fieldValue = fieldValue.slice(0, FIELD_CAP - 1) + "…";
    }
    embed.addFields({
      name: `📋 Last ${RECENT_WINDOW_DAYS} days — ${total7d} task${total7d === 1 ? "" : "s"} (✅ ${cleared7d} · ⏳ ${hold7d} · 🔍 ${pending7d}${rejected7d ? ` · ❌ ${rejected7d}` : ""}${removed7d ? ` · 🚫 ${removed7d}` : ""})`,
      value: fieldValue,
    });
    // Legend so the emojis are self-explanatory.
    embed.addFields({
      name: "🔤 Key",
      value:
        "**Status:** ✅ cleared into wallet · ⏳ in hold · 🔍 awaiting review · ❌ rejected\n" +
        "**On Reddit:** 🟢 live · 🚫 removed by mods · 🗑️ deleted by you · ⚪ not yet checked",
    });
  }

  // ── Field: hold explainer (only when something is on hold) ───────────
  if (hold7d > 0 || parseFloat(row.bal_pending) > 0) {
    embed.addFields({
      name: "⏱️ Why some earnings are still pending",
      value:
        `Approved submissions sit in a short **hold period** (commonly **24 hours to 7 days**, set per task by the admin) before they move into your **Available** balance. ` +
        `**The bot moves the money automatically the moment the timer is up — you don't need to do anything.** ` +
        `If your comment/post stays live on Reddit through the hold, it clears at the time shown above. If it gets removed by mods or deleted, it may not clear.`,
    });
  }

  // ── Field: payment methods (only show missing — keeps the card tight) ─
  const missing: string[] = [];
  if (!row.has_paypal) missing.push("⬜ PayPal — `/setpaypal email:you@example.com`");
  if (!row.has_upi)    missing.push("⬜ UPI — `/setupi upi_id:yourname@bank`");
  if (!row.has_crypto) missing.push("⬜ Crypto / Binance Pay — `/setwallet` (pick a coin, paste your address)");
  if (missing.length > 0) {
    embed.addFields({
      name: "💳 Finish setting up a payment method",
      value:
        `So you can withdraw the moment your balance is available, add at least one:\n` +
        missing.join("\n"),
    });
  } else {
    embed.addFields({
      name: "💳 Payment methods",
      value: "✅ You're fully set up — PayPal, UPI, and Crypto/Binance Pay are all on file. Use `/withdraw` whenever you're ready.",
    });
  }

  embed.setFooter({ text: "Need help with a specific task? Ping a mod — they can look it up." }).setTimestamp();
  return embed;
}

export async function handleSendStatsCommand(interaction: ChatInputCommandInteraction) {
  // Same permission gate as /massdm — admins and mods only.
  const perms = interaction.member?.permissions;
  const hasPerm =
    typeof perms === "object" && perms !== null && "has" in perms
      ? (perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageMessages))
      : false;
  if (!hasPerm) {
    return interaction.reply({ content: "❌ Only admins and mods can use this command.", flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  if (!guild) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ This command must be run inside the server.")],
    });
  }

  let targets: UserRow[];
  try {
    const r = await pool.query<UserRow>(
      `SELECT id, discord_id, workspace_channel_id
         FROM users
        WHERE verified = true
          AND workspace_channel_id IS NOT NULL
          AND workspace_channel_id <> ''
        ORDER BY id ASC`,
    );
    targets = r.rows;
  } catch (err) {
    logger.error({ err }, "sendstats: failed to load target users");
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Failed to load users from the database.")],
    });
  }

  const total = targets.length;
  if (total === 0) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.MUTED ?? COLORS.PRIMARY).setDescription("No verified users with a workspace channel were found.")],
    });
  }

  // Best-effort progress edit; we wrap in try/catch because the interaction
  // token expires after 15 min and we don't want that to nuke the worker pool.
  const safeEdit = async (payload: Parameters<typeof interaction.editReply>[0]) => {
    try { await interaction.editReply(payload); } catch { /* token may have expired */ }
  };

  await safeEdit({
    embeds: [
      makeEmbed(COLORS.PRIMARY).setDescription(
        `📨 Posting personalized stats to **${total}** workspace channel${total === 1 ? "" : "s"}… (parallel x${WORKER_COUNT})`,
      ),
    ],
  });

  let sent = 0;
  let failed = 0;
  let cursor = 0;
  let lastProgressShown = 0;
  let lastProgressAt = Date.now();

  const tryProgress = async () => {
    const done = sent + failed;
    if (done - lastProgressShown < PROGRESS_UPDATE_EVERY) return;
    if (Date.now() - lastProgressAt < 4000) return;
    lastProgressShown = done;
    lastProgressAt = Date.now();
    await safeEdit({
      embeds: [
        makeEmbed(COLORS.PRIMARY).setDescription(
          `📨 Posting stats… ${done}/${total} (✅ ${sent} · ❌ ${failed})`,
        ),
      ],
    });
  };

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;
      const target = targets[idx]!;
      try {
        const r = await pool.query<StatsRow>(STATS_SQL, [target.id, String(RECENT_WINDOW_DAYS), RECENT_LIMIT]);
        const stats = r.rows[0];
        if (!stats) {
          failed++;
          void tryProgress();
          await new Promise((res) => setTimeout(res, PER_WORKER_DELAY_MS));
          continue;
        }

        const embed = buildStatsEmbed(stats, target.discord_id);

        // Resolve the workspace channel; silently skip if missing/deleted.
        let channel: TextChannel | null = null;
        try {
          const fetched = await guild.channels.fetch(target.workspace_channel_id);
          if (fetched && fetched.type === ChannelType.GuildText) {
            channel = fetched as TextChannel;
          }
        } catch {
          channel = null;
        }

        if (!channel) {
          failed++;
        } else {
          // Try the PNG card first (looks better, matches /wallet). ANY
          // failure → fall back to the embed reply, so a renderer hiccup
          // can never lose the message for a user. Same safety contract
          // as the wallet handler.
          let png: Buffer | null = null;
          try {
            // Best-effort displayName lookup; if it fails we fall back to
            // the raw username field already on the user row (or "Member"
            // if we can't resolve anything at all).
            let displayName = "Member";
            try {
              const member = await guild.members.fetch(target.discord_id);
              displayName = member.displayName || member.user.username || displayName;
            } catch { /* member may have left — just use fallback */ }

            const recent = Array.isArray(stats.recent_subs) ? stats.recent_subs : [];
            const now = new Date();
            const recentRows: StatsCardRecentRow[] = recent.map((s) => {
              const status = mapStatus(s.review_status, s.moved_to_available);
              return {
                status,
                live: mapLive(s.live_status),
                title: (s.task_title && s.task_title.trim()) ? s.task_title : `Task #${s.id}`,
                reward: formatMoney(s.reward),
                when: whenLabel(status, s, now),
              };
            });

            const cardData: StatsCardData = {
              username: displayName,
              generatedAt: now,
              // Every money/count value below comes verbatim from the
              // STATS_SQL row — same source as /wallet — so the card can
              // never show an amount the database didn't actually record.
              available: formatMoney(stats.bal_available),
              pending:   formatMoney(stats.bal_pending),
              lifetime:  formatMoney(stats.bal_lifetime),
              activeClaims: parseInt(stats.active_claims) || 0,
              counts7d: {
                total:    parseInt(stats.total_7d)    || 0,
                cleared:  parseInt(stats.cleared_7d)  || 0,
                hold:     parseInt(stats.hold_7d)     || 0,
                pending:  parseInt(stats.pending_7d)  || 0,
                rejected: parseInt(stats.rejected_7d) || 0,
                removed:  parseInt(stats.removed_7d)  || 0,
              },
              recent: recentRows,
              payments: {
                paypal: !!stats.has_paypal,
                upi:    !!stats.has_upi,
                crypto: !!stats.has_crypto,
              },
            };
            png = renderStatsCard(cardData);
          } catch (err) {
            logger.warn({ err, userId: target.id }, "sendstats: PNG render failed — falling back to embed");
            png = null;
          }

          if (png) {
            const file = new AttachmentBuilder(png, { name: "stats.png" });
            await channel.send({ content: `<@${target.discord_id}>`, files: [file] });
          } else {
            await channel.send({ content: `<@${target.discord_id}>`, embeds: [embed] });
          }
          sent++;
        }
      } catch (err) {
        failed++;
        logger.warn({ err, userId: target.id }, "sendstats: per-user post failed");
      }
      void tryProgress();
      await new Promise((res) => setTimeout(res, PER_WORKER_DELAY_MS));
    }
  }

  const workers = Array.from({ length: Math.min(WORKER_COUNT, total) }, () => worker());
  await Promise.all(workers);

  await safeEdit({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("📊 Stats posted")
        .addFields(
          { name: "✅ Sent", value: String(sent), inline: true },
          { name: "❌ Failed", value: String(failed), inline: true },
          { name: "Total", value: String(total), inline: true },
        )
        .setFooter({ text: "Failed channels are usually ones that were deleted or that the bot lost access to." }),
    ],
  });

  logger.info({ sent, failed, total, sender: interaction.user.id }, "sendstats completed");
}

// ════════════════════════════════════════════════════════════════════════
// Single-user, paginated stats card.
//
// Triggered from the admin dashboard ("Send Stats" button on a worker
// profile) and from this module's own ◀/▶ pagination buttons. Keeps the
// PNG visually identical to the existing card — same width/typography —
// but slices the recent-submissions list into pages of 14 so the canvas
// height never balloons no matter how active a user has been.
//
// Window = 21 days (we only hold submission history that long), so a
// single page-0 render is "everything we have on this user right now".
// ════════════════════════════════════════════════════════════════════════

const SINGLE_WINDOW_DAYS = 21;
const SINGLE_PAGE_SIZE = 14;
// Hard ceiling — even at 14/page this caps the card at ~70 pages of
// history, which is way more than 21 days can ever produce. Defensive.
const SINGLE_HARD_LIMIT = 1000;

interface SingleUserStatsRow {
  id: number;
  discord_id: string;
  workspace_channel_id: string | null;
}

interface SingleStatsResult {
  ok: boolean;
  reason?: "no_user" | "no_workspace" | "channel_missing" | "stats_missing" | "send_failed";
  totalPages?: number;
  totalSubs?: number;
}

function buildPaginationRow(targetDiscordId: string, page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  // Discord requires ≥1 enabled button on the row OR all buttons disabled
  // for a row to render at all. We always show both arrows for visual
  // consistency; the at-the-edge ones are disabled so the user can't
  // click into an invalid page.
  const prev = new ButtonBuilder()
    .setCustomId(`stats:page:${targetDiscordId}:${page - 1}`)
    .setLabel("◀ Previous")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page <= 0);
  const indicator = new ButtonBuilder()
    .setCustomId(`stats:noop:${targetDiscordId}:${page}`)
    .setLabel(`Page ${page + 1} / ${totalPages}`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);
  const next = new ButtonBuilder()
    .setCustomId(`stats:page:${targetDiscordId}:${page + 1}`)
    .setLabel("Next ▶")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= totalPages - 1);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(prev, indicator, next);
}

async function loadSingleUserByDiscordId(discordId: string): Promise<SingleUserStatsRow | null> {
  const r = await pool.query<SingleUserStatsRow>(
    `SELECT id, discord_id, workspace_channel_id FROM users WHERE discord_id = $1 LIMIT 1`,
    [discordId],
  );
  return r.rows[0] ?? null;
}

async function loadSingleUserById(userId: number): Promise<SingleUserStatsRow | null> {
  const r = await pool.query<SingleUserStatsRow>(
    `SELECT id, discord_id, workspace_channel_id FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/**
 * Build a StatsCardData for the single-user, paginated card. Always uses
 * the 21-day window. `page` is 0-indexed; `pageSize` defaults to 14 to
 * match the card-renderer's hard cap.
 */
async function buildSingleUserCard(
  guild: Guild,
  user: SingleUserStatsRow,
  page: number,
): Promise<{ card: StatsCardData; totalPages: number; totalSubs: number } | null> {
  const r = await pool.query<StatsRow>(
    STATS_SQL,
    [user.id, String(SINGLE_WINDOW_DAYS), SINGLE_HARD_LIMIT],
  );
  const stats = r.rows[0];
  if (!stats) return null;

  const allRecent = Array.isArray(stats.recent_subs) ? stats.recent_subs : [];
  const totalSubs = parseInt(stats.total_7d) || allRecent.length;
  const totalPages = Math.max(1, Math.ceil(allRecent.length / SINGLE_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * SINGLE_PAGE_SIZE;
  const slice = allRecent.slice(start, start + SINGLE_PAGE_SIZE);

  // Best-effort displayName lookup — same fallback chain as the bulk command.
  let displayName = "Member";
  try {
    const member = await guild.members.fetch(user.discord_id);
    displayName = member.displayName || member.user.username || displayName;
  } catch { /* member may have left */ }

  const now = new Date();
  const recentRows: StatsCardRecentRow[] = slice.map((s) => {
    const status = mapStatus(s.review_status, s.moved_to_available);
    return {
      status,
      live: mapLive(s.live_status),
      title: (s.task_title && s.task_title.trim()) ? s.task_title : `Task #${s.id}`,
      reward: formatMoney(s.reward),
      when: whenLabel(status, s, now),
    };
  });

  const card: StatsCardData = {
    username: displayName,
    generatedAt: now,
    available: formatMoney(stats.bal_available),
    pending:   formatMoney(stats.bal_pending),
    lifetime:  formatMoney(stats.bal_lifetime),
    activeClaims: parseInt(stats.active_claims) || 0,
    // Counts now reflect the 21-day window (label rendered as "Last 21 days").
    counts7d: {
      total:    parseInt(stats.total_7d)    || 0,
      cleared:  parseInt(stats.cleared_7d)  || 0,
      hold:     parseInt(stats.hold_7d)     || 0,
      pending:  parseInt(stats.pending_7d)  || 0,
      rejected: parseInt(stats.rejected_7d) || 0,
      removed:  parseInt(stats.removed_7d)  || 0,
    },
    recent: recentRows,
    payments: {
      paypal: !!stats.has_paypal,
      upi:    !!stats.has_upi,
      crypto: !!stats.has_crypto,
    },
    windowDays: SINGLE_WINDOW_DAYS,
    pageInfo: { page: safePage, totalPages },
  };

  return { card, totalPages, totalSubs };
}

/**
 * Resolve the user's workspace text channel. Returns null if unset,
 * deleted, or of the wrong type.
 */
async function resolveWorkspaceChannel(guild: Guild, channelId: string): Promise<TextChannel | null> {
  try {
    const fetched = await guild.channels.fetch(channelId);
    if (fetched && fetched.type === ChannelType.GuildText) return fetched as TextChannel;
  } catch { /* deleted / no access */ }
  return null;
}

/**
 * Public entry: post a fresh paginated stats card to one user's workspace
 * channel. Used by the admin dashboard "Send Stats" button. Always starts
 * at page 0 and includes the ◀/▶ pager when there's more than one page.
 *
 * Never throws — returns { ok: false, reason } so the HTTP caller can map
 * a clean error to the response.
 */
export async function sendSingleUserStatsCard(
  guild: Guild,
  targetUserId: number,
): Promise<SingleStatsResult> {
  const user = await loadSingleUserById(targetUserId);
  if (!user) return { ok: false, reason: "no_user" };
  if (!user.workspace_channel_id) return { ok: false, reason: "no_workspace" };

  const channel = await resolveWorkspaceChannel(guild, user.workspace_channel_id);
  if (!channel) return { ok: false, reason: "channel_missing" };

  const built = await buildSingleUserCard(guild, user, 0);
  if (!built) return { ok: false, reason: "stats_missing" };
  const { card, totalPages, totalSubs } = built;

  try {
    const png = renderStatsCard(card);
    const file = new AttachmentBuilder(png, { name: "stats.png" });
    const components = totalPages > 1 ? [buildPaginationRow(user.discord_id, 0, totalPages)] : [];
    await channel.send({
      content: `<@${user.discord_id}> — here are your stats from the last ${SINGLE_WINDOW_DAYS} days.`,
      files: [file],
      components,
    });
    return { ok: true, totalPages, totalSubs };
  } catch (err) {
    logger.warn({ err, userId: user.id }, "sendSingleUserStatsCard: send failed");
    return { ok: false, reason: "send_failed" };
  }
}

/**
 * Button handler for `stats:page:<discordId>:<page>`. Re-renders the PNG
 * for the requested page and edits the original message in place. Only
 * the target user can flip pages — staff who can see the message must
 * use the dashboard to re-post (avoids confusing the user with someone
 * else's clicks). Failures are surfaced as ephemeral replies; the
 * source message is never deleted.
 */
export async function handleStatsPageButton(
  interaction: ButtonInteraction,
  targetDiscordId: string,
  pageStr: string,
): Promise<void> {
  const page = parseInt(pageStr, 10);
  if (!Number.isFinite(page) || page < 0) {
    await interaction.reply({ content: "Invalid page.", flags: 64 }).catch(() => {});
    return;
  }

  // Only the target user may flip pages on their own stats card. The
  // dashboard "Send Stats" path posts a FRESH message, so admins aren't
  // blocked from operating — they just don't fight with the user for
  // page state on a card already in flight.
  if (interaction.user.id !== targetDiscordId) {
    await interaction.reply({
      content: "These pagination buttons are for the user this card belongs to. Ask an admin to re-send if you need a fresh view.",
      flags: 64,
    }).catch(() => {});
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: "Run from inside the server.", flags: 64 }).catch(() => {});
    return;
  }

  // Defer the update so Discord doesn't time us out while we re-render.
  await interaction.deferUpdate().catch(() => {});

  const user = await loadSingleUserByDiscordId(targetDiscordId);
  if (!user) {
    await interaction.followUp({ content: "❌ Could not find your user record.", flags: 64 }).catch(() => {});
    return;
  }

  const built = await buildSingleUserCard(interaction.guild, user, page);
  if (!built) {
    await interaction.followUp({ content: "❌ No stats found.", flags: 64 }).catch(() => {});
    return;
  }
  const { card, totalPages } = built;

  try {
    const png = renderStatsCard(card);
    const file = new AttachmentBuilder(png, { name: "stats.png" });
    const components = totalPages > 1
      ? [buildPaginationRow(targetDiscordId, card.pageInfo!.page, totalPages)]
      : [];
    await interaction.editReply({
      files: [file],
      components,
      // Wipe the previous attachment so Discord shows the new PNG cleanly.
      attachments: [],
    });
  } catch (err) {
    logger.warn({ err, targetDiscordId, page }, "handleStatsPageButton: re-render failed");
    await interaction.followUp({
      content: "❌ Couldn't render the next page. Please try again in a moment.",
      flags: 64,
    }).catch(() => {});
  }
}
