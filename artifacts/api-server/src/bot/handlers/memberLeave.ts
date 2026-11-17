import {
  type GuildMember,
  type PartialGuildMember,
  type TextChannel,
  AttachmentBuilder,
} from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getUserByDiscordId } from "../db.js";
import { makeEmbed, formatMoney } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";
import { fetchAllLinkedRedditAccounts } from "./profile.js";
import { renderProfileCard } from "../card-renderer.js";
import { setupGuild } from "../setup.js";

/**
 * Handle member leave event (GuildMemberRemove).
 * Whenever someone leaves the server, posts their complete profile, Reddit accounts,
 * trust score, and earnings stats into #rest-in-peace.
 */
export async function handleGuildMemberRemove(member: GuildMember | PartialGuildMember): Promise<void> {
  try {
    if (member.user?.bot) return;

    const guild = member.guild;
    const discordId = member.id;
    const user = await getUserByDiscordId(discordId);

    const username = member.user?.username ?? user?.discordUsername ?? "Unknown User";
    const displayName = (member as any).displayName ?? (member.user as any)?.globalName ?? username;
    const avatarUrl = member.user?.displayAvatarURL?.({ extension: "png", size: 128 }) ?? null;

    const joinedUnix = member.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;
    const leftUnix = Math.floor(Date.now() / 1000);

    const isVerified = !!user?.verified;
    const trustScore = user?.trustScore ?? 100;
    const available = formatMoney(user?.balanceAvailable ?? "0.00");
    const pending = formatMoney(user?.balancePending ?? "0.00");
    const totalEarned = formatMoney(user?.totalEarned ?? "0.00");

    let linkedAccounts: string[] = [];
    if (user?.redditUsername) {
      linkedAccounts = await fetchAllLinkedRedditAccounts(discordId, user.redditUsername);
    }

    const redditDisplay = linkedAccounts.length > 0
      ? linkedAccounts.map((u) => `[u/${u}](https://www.reddit.com/user/${u})`).join(", ")
      : (user?.redditUsername ? `[u/${user.redditUsername}](https://www.reddit.com/user/${user.redditUsername})` : "*(None linked)*");

    const postKarma = user?.redditPostKarma ?? 0;
    const commentKarma = user?.redditCommentKarma ?? 0;
    const totalKarma = postKarma + commentKarma;
    const ageDays = user?.redditAccountAgeDays ?? 0;

    // Fetch submission statistics
    let approvedCount = 0;
    let totalSubmissions = 0;
    try {
      const statsRes = await db.execute<{ approved: string; total: string }>(
        sql`SELECT
              COUNT(*) FILTER (WHERE review_status = 'approved') AS approved,
              COUNT(*) AS total
            FROM submissions
            WHERE discord_id = ${discordId}`
      );
      approvedCount = Number(statsRes?.rows?.[0]?.approved || 0);
      totalSubmissions = Number(statsRes?.rows?.[0]?.total || 0);
    } catch (err) {
      logger.debug({ err, discordId }, "Could not load submission stats for leaving member");
    }

    // Determine active payout methods
    const wallets = (user?.cryptoWallets as Record<string, unknown>) ?? {};
    const usdtWallet = wallets["USDT"] as { address?: string } | string | undefined;
    const usdtAddress = (typeof usdtWallet === "string" ? usdtWallet : usdtWallet?.address)?.trim() || "";
    const gcash = user?.gcashNumber?.trim() || "";
    const upi = user?.upiId?.trim() || "";
    const paypal = user?.paypalEmail?.trim() || "";

    const payoutMethods: string[] = [];
    if (upi) payoutMethods.push(`UPI: \`${upi}\``);
    if (gcash) payoutMethods.push(`GCash: \`${gcash}\``);
    if (paypal) payoutMethods.push(`PayPal: \`${paypal}\``);
    if (usdtAddress) payoutMethods.push(`USDT: \`${usdtAddress.slice(0, 8)}...${usdtAddress.slice(-6)}\``);
    const payoutStr = payoutMethods.length > 0 ? payoutMethods.join(" · ") : "*(None set)*";

    const embed = makeEmbed(isVerified ? COLORS.PRIMARY : COLORS.MUTED)
      .setTitle(`🪦 Member Left: ${displayName}`)
      .setDescription(
        `**<@${discordId}>** (\`${username}\` • \`${discordId}\`) has left the server.`
      )
      .addFields(
        {
          name: "🛡️ Verification Status",
          value: user?.flagged ? "🚩 **Flagged**" : (isVerified ? "✅ **Verified Worker**" : "⏳ **Unverified**"),
          inline: true,
        },
        {
          name: "⭐ Trust Score",
          value: `${trustScore}/100`,
          inline: true,
        },
        {
          name: "📅 Time in Server",
          value: joinedUnix ? `Joined <t:${joinedUnix}:R> (<t:${joinedUnix}:D>)` : "Unknown join date",
          inline: true,
        },
        {
          name: linkedAccounts.length > 1 ? `🔗 Linked Reddit Accounts (${linkedAccounts.length})` : "🔗 Linked Reddit Account",
          value: redditDisplay,
          inline: false,
        },
      );

    if (avatarUrl) {
      embed.setThumbnail(avatarUrl);
    }

    if (isVerified) {
      embed.addFields(
        {
          name: "📊 Reddit Karma & Age",
          value: `**Total:** ${totalKarma.toLocaleString()} (${postKarma.toLocaleString()} post · ${commentKarma.toLocaleString()} comment)\n**Age:** ${ageDays.toLocaleString()} days`,
          inline: true,
        },
        {
          name: "🎯 Tasks Done",
          value: `**${approvedCount}** approved (${totalSubmissions} submitted)`,
          inline: true,
        },
        {
          name: "💰 Wallet & Earnings",
          value: `**Available:** ${available} · **Pending:** ${pending} · **Lifetime:** ${totalEarned}`,
          inline: false,
        },
      );

      if (payoutMethods.length > 0) {
        embed.addFields({
          name: "💳 Payout Destination",
          value: payoutStr,
          inline: false,
        });
      }
    } else if (user && (Number(user.balanceAvailable) > 0 || Number(user.totalEarned) > 0)) {
      embed.addFields({
        name: "💰 Wallet Balances",
        value: `**Available:** ${available} · **Pending:** ${pending} · **Lifetime:** ${totalEarned}`,
        inline: false,
      });
    }

    embed
      .setFooter({ text: `Member Departed • Discord ID: ${discordId}` })
      .setTimestamp(new Date(leftUnix * 1000));

    // Try rendering visual profile card PNG if verified with Reddit
    let cardAttachment: AttachmentBuilder | null = null;
    if (isVerified && user?.redditUsername) {
      try {
        const png = await renderProfileCard({
          username,
          avatarUrl,
          redditUsername: user.redditUsername,
          ageDays,
          postKarma,
          commentKarma,
          totalKarma,
          trustScore,
          flagged: !!user.flagged,
          available,
          pending,
          earned: totalEarned,
          freshenedNow: false,
          flair: null,
          flairColor: null,
        });
        cardAttachment = new AttachmentBuilder(png, { name: "profile.png" });
        embed.setImage("attachment://profile.png");
      } catch (err) {
        logger.debug({ err, discordId }, "Failed rendering leave profile card PNG, using embed-only");
      }
    }

    // Resolve #rest-in-peace channel
    const ripChannel = (guild.channels.cache.find(
      (c) => c && c.isTextBased() && (c.name === "rest-in-peace" || c.id === "1565438858567618711")
    ) as TextChannel | undefined) ?? (await guild.channels.fetch("1565438858567618711").catch(() => null)) as TextChannel | null;

    if (ripChannel) {
      await ripChannel.send({
        embeds: [embed],
        ...(cardAttachment ? { files: [cardAttachment] } : {}),
      }).catch((err) => {
        logger.warn({ err, channelId: ripChannel.id }, "Failed posting leave embed to #rest-in-peace");
      });
    } else {
      logger.warn({ guildId: guild.id }, "Could not find #rest-in-peace channel to post member leave info");
    }

    // Also log to staff verification log if member was verified
    if (isVerified) {
      try {
        const setup = await setupGuild(guild).catch(() => null);
        if (setup?.verificationLogChannel && setup.verificationLogChannel.id !== ripChannel?.id) {
          await setup.verificationLogChannel.send({
            embeds: [
              makeEmbed(COLORS.WARNING)
                .setTitle(`⚠️ Verified Worker Left Server: ${username}`)
                .setDescription(`Verified worker **<@${discordId}>** (\`${username}\`) has left the server.\n\n**Reddit:** ${redditDisplay}\n**Available Balance:** ${available}\n**Lifetime Earned:** ${totalEarned}\n**Trust Score:** ${trustScore}`)
                .setFooter({ text: `Discord ID: ${discordId}` })
                .setTimestamp(),
            ],
          }).catch(() => {});
        }
      } catch {}
    }

    logger.info({ discordId, username, isVerified }, "Logged member leave profile in #rest-in-peace");
  } catch (err) {
    logger.error({ err, memberId: member.id }, "Error in handleGuildMemberRemove");
  }
}
