import {
  type Guild,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { eq, sql, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { serverConfig, weeklyWinners } from "@workspace/db";
import { setupGuild } from "../setup.js";
import { makeEmbed, formatMoney, getISOWeekStart, medalFor } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";
import { leaderboardSnapshotCache, invalidateLeaderboard } from "../cache.js";
import { renderLeaderboardCard, type LeaderboardRow } from "../card-renderer.js";

async function getOrCreateConfig(guildId: string) {
  try {
    const rows = await db.select().from(serverConfig).where(eq(serverConfig.guildId, guildId)).limit(1);
    if (rows.length > 0) return rows[0]!;
    const [row] = await db.insert(serverConfig).values({ guildId }).returning();
    return row!;
  } catch (err) {
    logger.warn({ err, guildId }, "Leaderboard config unavailable, skipping");
    return null;
  }
}

export async function checkAndRolloverWeek(guild: Guild) {
  const config = await getOrCreateConfig(guild.id);
  if (!config) return;
  const weekStart = getISOWeekStart();

  const savedWeekStart = config.currentWeekStart ? new Date(config.currentWeekStart) : null;

  if (savedWeekStart && savedWeekStart.getTime() === weekStart.getTime()) return;

  if (savedWeekStart && savedWeekStart.getTime() < weekStart.getTime()) {
    const weekEnd = new Date(weekStart.getTime() - 1);
    const topRow = await db.execute<{ discord_id: string; discord_username: string; user_id: string; total: string; count: string }>(
      sql`SELECT s.discord_id, u.discord_username, u.id as user_id, SUM(s.reward)::text as total, COUNT(*)::text as count
          FROM submissions s JOIN users u ON u.discord_id = s.discord_id
          WHERE s.review_status = 'accepted' AND s.submitted_at >= ${savedWeekStart} AND s.submitted_at < ${weekStart}
          GROUP BY s.discord_id, u.discord_username, u.id
          ORDER BY SUM(s.reward) DESC LIMIT 1`
    );
    const winner = topRow.rows[0];

    if (winner) {
      await db.insert(weeklyWinners).values({
        guildId: guild.id,
        weekStart: savedWeekStart,
        weekEnd,
        userId: parseInt(winner.user_id),
        discordId: winner.discord_id,
        discordUsername: winner.discord_username,
        totalEarned: winner.total,
        taskCount: parseInt(winner.count),
      }).catch(() => {});

      const { leaderboardChannel } = await setupGuild(guild);
      await leaderboardChannel.send({
        embeds: [
          makeEmbed(COLORS.ACCENT)
            .setTitle("👑 New Week Begins!")
            .setDescription(
              `Last week's champion: <@${winner.discord_id}> with **${formatMoney(winner.total)}** from ${winner.count} tasks! 🎉\n\nA new week has started — get claiming!`
            ),
        ],
      }).catch(() => {});
    }
  }

  await db.update(serverConfig).set({ currentWeekStart: weekStart, updatedAt: new Date() }).where(eq(serverConfig.guildId, guild.id));
  invalidateLeaderboard(guild.id);
}

function fmtWeekRange(weekStart: Date): string {
  const weekEnd = new Date(weekStart.getTime() + 6 * 86400 * 1000);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
  return `${weekStart.toLocaleDateString("en-US", opts)} → ${weekEnd.toLocaleDateString("en-US", opts)}`;
}

/**
 * Compute weekly leaderboard data — both the embed and the card payload —
 * from the same query results. Weekly only (per user request: "I want only
 * this week leaderboard users on leaderboard").
 */
async function computeLeaderboardSnapshot(guildId: string): Promise<{
  embed: EmbedBuilder;
  cardData: NonNullable<ReturnType<typeof leaderboardSnapshotCache.get>>["cardData"];
}> {
  void guildId;
  const weekStart = getISOWeekStart();

  // Three parallel queries:
  //  - weekTop: top 10 earners THIS week (their actual week total)
  //  - allTimeTop: top 20 earners ALL TIME (used to backfill if fewer than 10
  //    people earned this week — they appear with $0.00 so the board never
  //    looks empty at the start of the week)
  //  - weekTotals: footer summary (total earners, total paid this week)
  // Top-30 (3 pages × 10) earners this week, plus their accept rate
  // (accepted / total non-pending submissions × 100). Pending submissions
  // don't count against the rate.
  const [weekTop, allTimeTop, weekTotals] = await Promise.all([
    db.execute<{ discord_id: string; discord_username: string; total: string; accept_rate: string | null }>(
      sql`SELECT s.discord_id, u.discord_username,
                 SUM(CASE WHEN s.review_status = 'accepted' THEN s.reward ELSE 0 END)::text as total,
                 CASE
                   WHEN COUNT(*) FILTER (WHERE s.review_status IN ('accepted','rejected')) = 0 THEN NULL
                   ELSE ROUND(
                     100.0 * COUNT(*) FILTER (WHERE s.review_status = 'accepted')::numeric
                     / COUNT(*) FILTER (WHERE s.review_status IN ('accepted','rejected'))
                   )::text
                 END as accept_rate
          FROM submissions s JOIN users u ON u.discord_id = s.discord_id
          WHERE s.submitted_at >= ${weekStart}
          GROUP BY s.discord_id, u.discord_username
          HAVING SUM(CASE WHEN s.review_status = 'accepted' THEN s.reward ELSE 0 END) > 0
          ORDER BY SUM(CASE WHEN s.review_status = 'accepted' THEN s.reward ELSE 0 END) DESC
          LIMIT 30`
    ),
    db.execute<{ discord_id: string; discord_username: string; total: string }>(
      sql`SELECT discord_id, discord_username, total_earned::text as total
          FROM users
          WHERE verified = true AND total_earned > 0
          ORDER BY total_earned DESC LIMIT 30`
    ),
    db.execute<{ earners: string; total: string }>(
      sql`SELECT COUNT(DISTINCT s.discord_id)::text as earners, COALESCE(SUM(s.reward), 0)::text as total
          FROM submissions s
          WHERE s.review_status = 'accepted' AND s.submitted_at >= ${weekStart}`
    ),
  ]);

  const weekRangeLabel = fmtWeekRange(weekStart);
  const totals = weekTotals.rows[0] ?? { earners: "0", total: "0" };

  // Build the merged top-30 list: weekly earners first (in order), then
  // backfill with all-time earners (showing $0.00) until we hit 30.
  type Row = { discordId: string; username: string; amount: string; isZero: boolean; acceptRate?: string };
  const merged: Row[] = weekTop.rows.map((r: { discord_id: string; discord_username: string; total: string; accept_rate: string | null }) => ({
    discordId: r.discord_id,
    username: r.discord_username,
    amount: formatMoney(r.total),
    isZero: false,
    acceptRate: r.accept_rate ? `${r.accept_rate}%` : undefined,
  }));
  const seen = new Set(merged.map((r) => r.discordId));
  for (const r of allTimeTop.rows) {
    if (merged.length >= 30) break;
    if (seen.has(r.discord_id)) continue;
    merged.push({
      discordId: r.discord_id,
      username: r.discord_username,
      amount: formatMoney("0"),
      isZero: true,
    });
    seen.add(r.discord_id);
  }

  // Embed — only the first 10 entries (Discord embed length limits). This is
  // ONLY a fallback if the PNG render fails; the channel post is image-based.
  const top10 = merged.slice(0, 10);
  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle("🏆 Outpost Bot Leaderboard")
    .addFields({
      name: `🔥 This Week · ${weekRangeLabel}`,
      value:
        top10.length === 0
          ? "_No earners on the board yet — be the first!_"
          : top10
              .map((r, i) => `${medalFor(i + 1)} <@${r.discordId}> — **${r.amount}**`)
              .join("\n"),
    });

  embed.setFooter({
    text: `${totals.earners} earner${totals.earners === "1" ? "" : "s"} this week · ${formatMoney(totals.total)} paid · updated <t:${Math.floor(Date.now() / 1000)}:R>`,
  });

  // Tier purely from rank: #1 Gold, #2 Silver, #3 Bronze, others Verified.
  // Zero (backfill) rows get "Earner".
  const tierFor = (rank: number, isZero: boolean): "Gold" | "Silver" | "Bronze" | "Verified" | "Earner" =>
    isZero ? "Earner" : rank === 1 ? "Gold" : rank === 2 ? "Silver" : rank === 3 ? "Bronze" : "Verified";

  const rows = merged.map((r, i) => ({
    rank: i + 1,
    username: r.username,
    amount: r.amount,
    discordId: r.discordId,
    isZero: r.isZero,
    acceptRate: r.acceptRate,
    tier: tierFor(i + 1, r.isZero),
  }));

  const cardData = {
    weekRangeLabel,
    rows,
    lastWinnerLabel: null,
    totalEarners: parseInt(totals.earners) || 0,
    totalPaid: formatMoney(totals.total),
  };

  return { embed, cardData };
}

async function getLeaderboardSnapshot(guildId: string): Promise<{
  embed: EmbedBuilder;
  cardData: NonNullable<ReturnType<typeof leaderboardSnapshotCache.get>>["cardData"];
}> {
  const cached = leaderboardSnapshotCache.get(guildId);
  if (cached && cached.cardData) {
    return { embed: EmbedBuilder.from(cached.embedData), cardData: cached.cardData };
  }
  const fresh = await computeLeaderboardSnapshot(guildId);
  leaderboardSnapshotCache.set(guildId, {
    embedData: fresh.embed.data,
    refreshedAt: Date.now(),
    cardData: fresh.cardData,
  });
  return fresh;
}

const PAGE_SIZE = 10;

/**
 * Build the paginated card payload for a given page. Returns null if PNG
 * render fails so callers can fall back to the embed.
 */
function buildPageFiles(
  cardData: NonNullable<ReturnType<typeof leaderboardSnapshotCache.get>>["cardData"],
  page: number,
  callerDiscordId: string | null,
): { rowsForPage: LeaderboardRow[]; totalPages: number; pageClamped: number } {
  const all = cardData!.rows;
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const pageClamped = Math.max(1, Math.min(page, totalPages));
  const start = (pageClamped - 1) * PAGE_SIZE;
  const slice = all.slice(start, start + PAGE_SIZE);
  const rowsForPage: LeaderboardRow[] = slice.map((r) => ({
    rank: r.rank,
    username: r.username,
    amount: r.amount,
    isYou: callerDiscordId !== null && r.discordId === callerDiscordId,
    isZero: r.isZero,
    acceptRate: r.acceptRate,
    tier: r.tier,
  }));
  return { rowsForPage, totalPages, pageClamped };
}

function buildPageButtons(page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> | null {
  if (totalPages <= 1) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`lb:page:${page - 1}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId("lb:noop")
      .setLabel(`Page ${page} / ${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`lb:page:${page + 1}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page >= totalPages),
  );
}

async function renderPagePngBuffer(
  cardData: NonNullable<ReturnType<typeof leaderboardSnapshotCache.get>>["cardData"],
  page: number,
  callerDiscordId: string | null,
): Promise<{ buffer: Buffer; pageClamped: number; totalPages: number } | null> {
  try {
    const { rowsForPage, totalPages, pageClamped } = buildPageFiles(cardData, page, callerDiscordId);
    const buffer = await renderLeaderboardCard({
      weekRangeLabel: cardData!.weekRangeLabel,
      rows: rowsForPage,
      lastWinnerLabel: cardData!.lastWinnerLabel,
      totalEarners: cardData!.totalEarners,
      totalPaid: cardData!.totalPaid,
      page: pageClamped,
      totalPages,
    });
    return { buffer, pageClamped, totalPages };
  } catch (err) {
    logger.warn({ err }, "Leaderboard PNG render failed");
    return null;
  }
}

/**
 * Refresh the pinned leaderboard message in the channel. Sends the new
 * pill-style image with pagination buttons. On the first post (no existing
 * message id) we include a single @here ping so members are notified. On
 * scheduled refreshes we edit silently — no re-ping. PNG failures fall
 * back to the legacy embed so this can never leave the channel empty.
 */
export async function refreshLeaderboard(guild: Guild) {
  const config = await getOrCreateConfig(guild.id);
  if (!config) return;

  const { embed, cardData } = await computeLeaderboardSnapshot(guild.id);
  leaderboardSnapshotCache.set(guild.id, {
    embedData: embed.data,
    refreshedAt: Date.now(),
    cardData,
  });

  const { leaderboardChannel } = await setupGuild(guild);

  const rendered = cardData ? await renderPagePngBuffer(cardData, 1, null) : null;
  const buttons = rendered ? buildPageButtons(rendered.pageClamped, rendered.totalPages) : null;
  const components = buttons ? [buttons] : [];

  // Try edit-in-place first so the pinned message + initial ping aren't repeated.
  if (config.leaderboardMessageId) {
    try {
      const msg = await leaderboardChannel.messages.fetch(config.leaderboardMessageId);
      if (rendered) {
        await msg.edit({
          content: null,
          attachments: [],
          files: [new AttachmentBuilder(rendered.buffer, { name: `leaderboard-${Date.now()}.png` })],
          embeds: [],
          components,
        });
      } else {
        await msg.edit({ content: null, attachments: [], files: [], embeds: [embed], components: [] });
      }
      return;
    } catch {
      logger.warn({ guildId: guild.id }, "Could not edit leaderboard message — reposting");
    }
  }

  // First post: ping @here once so members know the leaderboard is live.
  const initialPing = "🏆 **Weekly Earnings Leaderboard** — auto-refreshes every 5 minutes. @here";
  const msg = rendered
    ? await leaderboardChannel.send({
        content: initialPing,
        files: [new AttachmentBuilder(rendered.buffer, { name: `leaderboard-${Date.now()}.png` })],
        components,
        allowedMentions: { parse: ["everyone"] },
      })
    : await leaderboardChannel.send({
        content: initialPing,
        embeds: [embed],
        allowedMentions: { parse: ["everyone"] },
      });
  try { await msg.pin(); } catch {}

  await db.update(serverConfig).set({
    leaderboardMessageId: msg.id,
    leaderboardChannelId: leaderboardChannel.id,
    updatedAt: new Date(),
  }).where(eq(serverConfig.guildId, guild.id));
}

/**
 * Handle the prev/next pagination button on the leaderboard channel message.
 * Re-renders the requested page from the cached snapshot (or refreshes the
 * snapshot first if the cache is empty) and edits the message in place.
 */
export async function handleLeaderboardPageButton(
  interaction: ButtonInteraction,
  pageStr: string,
) {
  const requestedPage = parseInt(pageStr, 10);
  if (!Number.isFinite(requestedPage) || requestedPage < 1) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }
  let snap = leaderboardSnapshotCache.get(guildId);
  if (!snap || !snap.cardData) {
    const fresh = await computeLeaderboardSnapshot(guildId);
    leaderboardSnapshotCache.set(guildId, {
      embedData: fresh.embed.data,
      refreshedAt: Date.now(),
      cardData: fresh.cardData,
    });
    snap = leaderboardSnapshotCache.get(guildId);
  }
  if (!snap || !snap.cardData) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }

  const rendered = await renderPagePngBuffer(snap.cardData, requestedPage, interaction.user.id);
  if (!rendered) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }
  const buttons = buildPageButtons(rendered.pageClamped, rendered.totalPages);
  await interaction.update({
    attachments: [],
    files: [new AttachmentBuilder(rendered.buffer, { name: `leaderboard-${Date.now()}.png` })],
    components: buttons ? [buttons] : [],
  }).catch((err) => {
    logger.warn({ err, guildId }, "Leaderboard page button update failed");
  });
}

export async function handleLeaderboardCommand(interaction: ChatInputCommandInteraction) {
  // Public — visible to everyone in the channel.
  await interaction.deferReply();

  const guild = interaction.guild!;
  const { embed, cardData } = await getLeaderboardSnapshot(guild.id);

  // Try the PNG card first. ANY failure → fall back to the embed (so this
  // can never break /leaderboard for users). Paginated: page 1 + buttons.
  if (cardData) {
    const rendered = await renderPagePngBuffer(cardData, 1, interaction.user.id);
    if (rendered) {
      const buttons = buildPageButtons(rendered.pageClamped, rendered.totalPages);
      const file = new AttachmentBuilder(rendered.buffer, { name: `leaderboard-${Date.now()}.png` });
      await interaction.editReply({ files: [file], components: buttons ? [buttons] : [] });

      // Background refresh of the pinned channel message — fire-and-forget.
      void refreshLeaderboard(guild).catch((err) => {
        logger.warn({ err, guildId: guild.id }, "Background leaderboard refresh failed");
      });
      return;
    }
    logger.warn({ guildId: guild.id }, "Leaderboard card PNG render failed — falling back to embed");
  }

  await interaction.editReply({ embeds: [embed] });

  void refreshLeaderboard(guild).catch((err) => {
    logger.warn({ err, guildId: guild.id }, "Background leaderboard refresh failed");
  });
}

export async function handleResetLeaderboard(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild!;

  try {
    await db
      .update(serverConfig)
      .set({ leaderboardMessageId: null, updatedAt: new Date() })
      .where(eq(serverConfig.guildId, guild.id));
    invalidateLeaderboard(guild.id);
    await refreshLeaderboard(guild);
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.SUCCESS).setDescription("✅ Leaderboard reset and reposted!")],
    });
  } catch (err: any) {
    logger.error({ err, guildId: guild.id }, "resetleaderboard failed");
    const reason =
      err?.code === 50013 || err?.message?.includes("Missing Permissions")
        ? "Bot is missing permissions in the **leaderboard** channel. It needs **View Channel**, **Send Messages**, **Embed Links**, **Manage Messages** (to pin), and **Manage Channels/Roles** if `/setup` hasn't been run yet."
        : err?.code === 50001 || err?.message?.includes("Missing Access")
          ? "Bot can't access the **leaderboard** channel. Run `/setup` first to create the required roles, categories, and channels."
          : `Unexpected error: \`${err?.message ?? "unknown"}\``;
    await interaction.editReply({
      embeds: [
        makeEmbed(COLORS.DANGER)
          .setTitle("❌ Could not reset the leaderboard")
          .setDescription(reason),
      ],
    });
  }
}
