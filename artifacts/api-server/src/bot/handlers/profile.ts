import {
  type ChatInputCommandInteraction,
  AttachmentBuilder,
} from "discord.js";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { users } from "@workspace/db";
import { getUserByDiscordId } from "../db.js";
import { invalidateUser } from "../cache.js";
import { makeEmbed, formatMoney } from "../util.js";
import { COLORS } from "../constants.js";
import { fetchRedditProfile } from "../reddit.js";
import { logger } from "../../lib/logger.js";
import { renderProfileCard } from "../card-renderer.js";

/**
 * Fetch every Reddit account linked to a Discord user, merging the primary
 * `users.reddit_username` with every row in `reddit_accounts`. We UNION
 * because some legacy users (verified before the multi-account schema
 * landed) only have the primary in the users table; without the UNION
 * /profile would show only the primary and hide their other linked
 * accounts. De-duped case-insensitively, primary always listed first.
 *
 * Always returns lowercase usernames. Returns [] if the user has none.
 * Wrapped in try/catch — never throws, /profile keeps working even if
 * the DB hiccups on this auxiliary query.
 */
async function fetchAllLinkedRedditAccounts(discordId: string, primary: string | null): Promise<string[]> {
  try {
    const result = await db.execute<{ reddit_username: string }>(
      sql`SELECT DISTINCT LOWER(reddit_username) AS reddit_username
            FROM reddit_accounts
            WHERE discord_id = ${discordId}
              AND reddit_username IS NOT NULL
              AND reddit_username <> ''`,
    );
    const fromTable = (result.rows ?? []).map((r) => r.reddit_username);
    const primaryLower = primary?.toLowerCase() ?? null;
    const all = new Set<string>();
    if (primaryLower) all.add(primaryLower);
    for (const name of fromTable) all.add(name);
    // Primary first, then the rest in insertion order.
    const ordered = Array.from(all);
    return ordered;
  } catch (err) {
    logger.warn({ err, discordId }, "fetchAllLinkedRedditAccounts failed (non-fatal)");
    return primary ? [primary.toLowerCase()] : [];
  }
}

export async function handleProfileCommand(interaction: ChatInputCommandInteraction) {
  // Public — visible to everyone in the channel.
  await interaction.deferReply();

  const targetUser = interaction.options.getUser("user") ?? interaction.user;
  const discordId = targetUser.id;

  const user = await getUserByDiscordId(discordId);

  if (!user) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ User not found. They need to interact with the bot first.")],
    });
  }

  if (!user.verified || !user.redditUsername) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.WARNING).setDescription(`⚠️ <@${discordId}> has not verified their Reddit account yet.`)],
    });
  }

  let postKarma = user.redditPostKarma ?? 0;
  let commentKarma = user.redditCommentKarma ?? 0;
  let ageDays = user.redditAccountAgeDays ?? 0;
  let freshenedNow = false;

  if (postKarma === 0 && commentKarma === 0) {
    const result = await fetchRedditProfile(user.redditUsername);
    if (result.ok) {
      postKarma = result.profile.linkKarma;
      commentKarma = result.profile.commentKarma;
      ageDays = result.profile.accountAgeDays;
      await db.update(users).set({
        redditPostKarma: postKarma,
        redditCommentKarma: commentKarma,
        redditAccountAgeDays: ageDays,
      }).where(eq(users.discordId, discordId));
      invalidateUser(discordId, user.id);
      freshenedNow = true;
    }
  }

  const totalKarma = postKarma + commentKarma;
  const createdApprox = new Date(Date.now() - ageDays * 86400 * 1000);
  const createdUnix = Math.floor(createdApprox.getTime() / 1000);

  // ORDER NOTE: the embed lists the primary account first (the one
  // stored in users.reddit_username — same one that owns the verified
  // flag), then additional accounts in the order they were linked
  // (oldest verified_at first). Matches the dashboard slot 1..N
  // contract the operator expects.
  // Pull EVERY linked Reddit account for this Discord ID, not just the
  // primary. Surfaced in a dedicated embed field below so the user (and
  // staff running /profile @someone) can see all of someone's accounts at
  // a glance. Non-fatal — returns [primary] on error.
  const linkedAccounts = await fetchAllLinkedRedditAccounts(discordId, user.redditUsername);
  const hasMultiple = linkedAccounts.length > 1;
  const linkedDisplay = linkedAccounts.length === 0
    ? `u/${user.redditUsername}`
    : linkedAccounts.map((u) => `u/${u}`).join(", ");

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(`📋 Profile — ${targetUser.username}`)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: hasMultiple ? `Linked Reddit Accounts (${linkedAccounts.length})` : "Reddit Account", value: linkedDisplay, inline: false },
      { name: "Account Age", value: `${ageDays} days`, inline: true },
      { name: "Registered", value: `<t:${createdUnix}:D>`, inline: true },
      { name: "Post Karma", value: postKarma.toLocaleString(), inline: true },
      { name: "Comment Karma", value: commentKarma.toLocaleString(), inline: true },
      { name: "Total Karma", value: totalKarma.toLocaleString(), inline: true },
      { name: "Trust Score", value: String(user.trustScore), inline: true },
      { name: "Status", value: user.flagged ? "🚩 Flagged" : "✅ Active", inline: true },
      { name: "Tasks on Leaderboard", value: user.lastTaskCompletedAt ? `Last active <t:${Math.floor(new Date(user.lastTaskCompletedAt).getTime() / 1000)}:R>` : "None yet", inline: true },
      { name: "Balance Available", value: formatMoney(user.balanceAvailable), inline: true },
      { name: "Balance Pending", value: formatMoney(user.balancePending), inline: true },
      { name: "Lifetime Earnings", value: formatMoney(user.totalEarned), inline: true },
    )
    .setFooter({ text: freshenedNow ? "Karma refreshed from Reddit API" : "Karma as of last verification" });

  // Try to render a fancy PNG profile card. ANY failure → fall back to the
  // existing embed-only reply (so this can never break /profile for users).
  try {
    const png = await renderProfileCard({
      username: targetUser.username,
      avatarUrl: targetUser.displayAvatarURL({ extension: "png", size: 128 }),
      redditUsername: user.redditUsername,
      ageDays,
      postKarma,
      commentKarma,
      totalKarma,
      trustScore: user.trustScore,
      flagged: !!user.flagged,
      available: formatMoney(user.balanceAvailable),
      pending: formatMoney(user.balancePending),
      earned: formatMoney(user.totalEarned),
      freshenedNow,
    });
    const file = new AttachmentBuilder(png, { name: "profile.png" });
    await interaction.editReply({ files: [file] });
  } catch (err) {
    logger.warn({ err, discordId }, "Profile card PNG render failed — falling back to embed");
    await interaction.editReply({ embeds: [embed] });
  }

  logger.info({ discordId, targetId: discordId }, "Profile viewed");
}
