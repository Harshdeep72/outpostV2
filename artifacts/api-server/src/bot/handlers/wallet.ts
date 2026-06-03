import {
  type ChatInputCommandInteraction,
  AttachmentBuilder,
} from "discord.js";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { users, serverConfig } from "@workspace/db";
import { getUserByDiscordId } from "../db.js";
import { walletStatsCache, invalidateUser } from "../cache.js";
import { makeEmbed, formatMoney, nextPayoutDate, trustBadge, getISOWeekStart, smokyFooterText } from "../util.js";
import { COLORS } from "../constants.js";
import { getUserStreak } from "../streak.js";
import { renderWalletCard } from "../card-renderer.js";
import { logger } from "../../lib/logger.js";
import { setupGuild } from "../setup.js";

async function checkDuplicateDestination(
  interaction: ChatInputCommandInteraction,
  destinationValue: string,
  methodName: string,
  userDiscordId: string
): Promise<boolean> {
  const normDest = destinationValue.toLowerCase();

  const rows = await db.select({ 
    discordId: users.discordId, 
    discordUsername: users.discordUsername, 
    upiId: users.upiId, 
    paypalEmail: users.paypalEmail, 
    cryptoWallets: users.cryptoWallets 
  })
    .from(users)
    .where(sql`discord_id != ${userDiscordId} AND (
      LOWER(upi_id) = ${normDest} OR 
      LOWER(paypal_email) = ${normDest} OR 
      LOWER(crypto_wallets::text) LIKE ${"%" + normDest + "%"}
    )`);
  
  let duplicateFound = false;
  let duplicateUsers: string[] = [];
  
  for (const row of rows) {
    let match = false;
    if (row.upiId?.toLowerCase() === normDest) match = true;
    if (row.paypalEmail?.toLowerCase() === normDest) match = true;
    const cw = row.cryptoWallets as Record<string, unknown> | null;
    if (cw) {
      for (const val of Object.values(cw)) {
        if (typeof val === "string" && val.toLowerCase() === normDest) match = true;
        if (typeof val === "object" && val !== null && (val as any).address?.toLowerCase() === normDest) match = true;
      }
    }
    if (match) {
      duplicateFound = true;
      duplicateUsers.push(`<@${row.discordId}>`);
    }
  }

  if (duplicateFound) {
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ The destination \`${destinationValue}\` is already linked to another account.\n\nSharing payment destinations is a violation of our terms.`)],
    });

    if (interaction.guild) {
      const { taskLogsChannel, adminRole } = await setupGuild(interaction.guild);
      await taskLogsChannel.send({
        content: adminRole ? `<@&${adminRole.id}>` : "",
        embeds: [
          makeEmbed(COLORS.DANGER)
            .setTitle("🚨 Fraud Alert: Duplicate Wallet Setup")
            .setDescription(`User <@${userDiscordId}> attempted to link **${methodName}** \`${destinationValue}\`.\n\nThis exact destination is already linked to: ${duplicateUsers.join(", ")}`)
        ],
      });
    }
    return true;
  }
  
  return false;
}

export async function handleWalletCommand(interaction: ChatInputCommandInteraction) {
  // Public — visible to everyone in the channel.
  await interaction.deferReply();

  const target = interaction.options.getUser("user") ?? interaction.user;
  const user = await getUserByDiscordId(target.id);

  if (!user) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ <@${target.id}> hasn't registered yet.`)],
    });
  }

  let stats = walletStatsCache.get(user.discordId);
  if (!stats) {
    const weekStart = getISOWeekStart();
    const combined = await db.execute<{ week_total: string; week_count: string; life_count: string }>(
      sql`SELECT
            COALESCE(SUM(CASE WHEN submitted_at >= ${weekStart} THEN reward ELSE 0 END), 0)::text as week_total,
            COUNT(*) FILTER (WHERE submitted_at >= ${weekStart})::text as week_count,
            COUNT(*)::text as life_count
          FROM submissions
          WHERE discord_id = ${user.discordId} AND review_status = 'accepted'`
    );
    const row = combined.rows[0] ?? { week_total: "0", week_count: "0", life_count: "0" };
    stats = {
      weekTotal: row.week_total,
      weekCount: parseInt(row.week_count),
      lifeCount: parseInt(row.life_count),
    };
    walletStatsCache.set(user.discordId, stats);
  }

  const payout = nextPayoutDate();
  const unixPayout = Math.floor(payout.getTime() / 1000);
  const streak = await getUserStreak(user.discordId);
  const streakLabel = streak === 0 ? "—" : `🔥 ${streak} day${streak === 1 ? "" : "s"}`;

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(`💼 Wallet — ${target.username}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: "Status", value: user.verified ? "✅ Verified earner" : "❌ Not yet verified", inline: true },
      ...(user.redditUsername ? [{ name: "Reddit", value: `[u/${user.redditUsername}](https://reddit.com/u/${user.redditUsername})`, inline: true }] : []),
      { name: "\u200b", value: "\u200b" },
      { name: "💰 Available", value: formatMoney(user.balanceAvailable), inline: true },
      { name: "⏳ Pending", value: formatMoney(user.balancePending), inline: true },
      { name: "📈 Lifetime Earnings", value: formatMoney(user.totalEarned), inline: true },
      { name: "🔗 Referral Earnings", value: formatMoney(user.referralEarnings), inline: true },
      { name: `🛡️ Trust Score`, value: `${user.trustScore} — ${trustBadge(user.trustScore)}`, inline: true },
      { name: "🔥 Streak", value: streakLabel, inline: true },
      { name: "📅 Last 7 Days", value: `${formatMoney(stats.weekTotal)} (${stats.weekCount} tasks)`, inline: true },
      { name: "✅ Tasks Completed", value: String(stats.lifeCount), inline: true },
      { name: "🗓️ Next Payout", value: `<t:${unixPayout}:D> (<t:${unixPayout}:R>)`, inline: true },
      { name: "💸 Auto Payouts", value: "Every Wednesday UTC", inline: true },
    );

  if (user.flagged) {
    embed.setFooter({ text: smokyFooterText("⚠️ Account flagged — contact an admin") });
  }

  // Try to render a fancy PNG wallet card. ANY failure → fall back to the
  // existing embed-only reply (so this can never break /wallet for users).
  try {
    const png = await renderWalletCard({
      username: target.username,
      avatarUrl: target.displayAvatarURL({ extension: "png", size: 128 }),
      redditUsername: user.redditUsername ?? null,
      verified: !!user.verified,
      available: formatMoney(user.balanceAvailable),
      pending: formatMoney(user.balancePending),
      earned: formatMoney(user.totalEarned),
      weekTotal: formatMoney(stats.weekTotal),
      weekCount: stats.weekCount,
      lifeCount: stats.lifeCount,
      trustScore: user.trustScore,
      trustBadge: trustBadge(user.trustScore),
      streakLabel,
      nextPayoutLabel: payout.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }),
      flagged: !!user.flagged,
    });
    const file = new AttachmentBuilder(png, { name: "wallet.png" });
    return interaction.editReply({ files: [file] });
  } catch (err) {
    logger.warn({ err, discordId: target.id }, "Wallet card PNG render failed — falling back to embed");
    return interaction.editReply({ embeds: [embed] });
  }
}

export async function handleSetPaypal(interaction: ChatInputCommandInteraction) {
  const email = interaction.options.getString("email", true).trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Invalid email address. Please enter a valid PayPal email.")],
      flags: 64,
    });
  }

  await interaction.deferReply({ flags: 64 });

  const user = await getUserByDiscordId(interaction.user.id);
  if (!user?.verified) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You must verify with `/verify` before saving payout details.")],
    });
  }
  if (user.flagged) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Your account is flagged — contact an admin.")],
    });
  }

  const duplicateFound = await checkDuplicateDestination(interaction, email, "PayPal email", interaction.user.id);
  if (duplicateFound) return;

  await db.update(users).set({ paypalEmail: email }).where(eq(users.discordId, interaction.user.id));
  invalidateUser(interaction.user.id);

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ PayPal email saved: \`${email}\``)],
  });
}

export async function handleSetupI(interaction: ChatInputCommandInteraction) {
  const upiId = interaction.options.getString("upi_id", true);

  if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upiId)) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Invalid UPI ID format. Expected format: `username@bank`")],
      flags: 64,
    });
  }

  await interaction.deferReply({ flags: 64 });

  const user = await getUserByDiscordId(interaction.user.id);
  if (!user?.verified) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You must verify with `/verify` before saving payout details.")],
    });
  }
  if (user.flagged) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Your account is flagged — contact an admin.")],
    });
  }

  const duplicateFound = await checkDuplicateDestination(interaction, upiId, "UPI ID", interaction.user.id);
  if (duplicateFound) return;

  await db.update(users).set({ upiId }).where(eq(users.discordId, interaction.user.id));
  invalidateUser(interaction.user.id);

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ UPI ID saved: \`${upiId}\``)],
  });
}

// Per-coin allowed networks. Sending crypto to the WRONG chain loses the
// funds permanently, so we enforce this at the bot/UI layer instead of
// trusting admins to remember the right combo at payout time.
const ALLOWED_NETWORKS: Record<string, readonly string[]> = {
  USDT: ["TRC20", "ERC20", "BEP20", "SOL", "POLYGON"],
  ETH:  ["ERC20", "ARB", "OP", "BASE", "POLYGON"],
  BTC:  ["BTC", "LIGHTNING"],
};
// For coins where a single network is the realistic default, we fill it in
// when the user omits the option — strict only for USDT.
const DEFAULT_NETWORK: Record<string, string> = {
  ETH:  "ERC20",
  BTC:  "BTC",
};
const NETWORK_REQUIRED: ReadonlySet<string> = new Set(["USDT"]);

export async function handleSetWallet(interaction: ChatInputCommandInteraction) {
  const coin = interaction.options.getString("coin", true);
  const address = interaction.options.getString("address", true).trim();
  const rawNetwork = interaction.options.getString("network", false);
  const isBinance = coin === "BINANCE";

  if (isBinance) {
    // Binance Pay ID is a numeric string (currently 8–13 digits in the wild).
    // Be strict here so we don't store a wallet address under the BINANCE key.
    if (!/^\d{8,13}$/.test(address)) {
      return interaction.reply({
        embeds: [makeEmbed(COLORS.DANGER).setDescription(
          "❌ That doesn't look like a Binance Pay ID.\n\n" +
          "Open Binance → **Pay** → tap your name to copy your **Pay ID** " +
          "(an 8–13 digit number). Then run `/setwallet coin:Binance Pay ID address:<that number>`."
        )],
        flags: 64,
      });
    }
  } else if (address.length < 8 || address.length > 200) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Wallet address must be 8–200 characters.")],
      flags: 64,
    });
  }

  // Resolve network. For Binance we ignore it entirely. For crypto, validate
  // against the per-coin allow-list and fall back to a sensible default if
  // the coin permits one. USDT is special — we REQUIRE a network because the
  // same address won't work across TRC20/ERC20/BEP20/SOL/Polygon and there's
  // no safe default. Sending USDT to the wrong chain = permanent loss.
  let network: string | null = null;
  if (!isBinance) {
    const allowed = ALLOWED_NETWORKS[coin] ?? [];
    if (rawNetwork) {
      if (!allowed.includes(rawNetwork)) {
        return interaction.reply({
          embeds: [makeEmbed(COLORS.DANGER).setDescription(
            `❌ \`${rawNetwork}\` is not a valid network for **${coin}**.\n\n` +
            `Pick one of: ${allowed.map((n) => `\`${n}\``).join(", ")}.`
          )],
          flags: 64,
        });
      }
      network = rawNetwork;
    } else if (NETWORK_REQUIRED.has(coin)) {
      return interaction.reply({
        embeds: [makeEmbed(COLORS.DANGER).setDescription(
          `❌ **USDT requires a network.**\n\n` +
          `Sending USDT to the wrong chain = permanently lost funds. Pick one in the \`network\` option:\n` +
          allowed.map((n) => `• \`${n}\``).join("\n") +
          `\n\nNot sure? Check the Deposit screen in your wallet/exchange — the network shown there is the one to pick.`
        )],
        flags: 64,
      });
    } else {
      network = DEFAULT_NETWORK[coin] ?? null;
    }
  }

  await interaction.deferReply({ flags: 64 });

  const user = await getUserByDiscordId(interaction.user.id);
  if (!user?.verified) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You must verify with `/verify` before saving a wallet.")],
    });
  }
  if (user.flagged) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Your account is flagged — contact an admin.")],
    });
  }

  const duplicateFound = await checkDuplicateDestination(interaction, address, isBinance ? "Binance Pay ID" : coin + " wallet", interaction.user.id);
  if (duplicateFound) return;

  // Storage shape: { address, network } object per coin. Backward-compat with
  // older string entries (from before this option existed) is handled by
  // every reader — they accept either shape. Binance Pay has no network so
  // we still store a plain string to avoid spurious "network:null" noise.
  const existing = (user.cryptoWallets as Record<string, unknown>) ?? {};
  const newEntry: unknown = isBinance ? address : { address, network };
  const updated = { ...existing, [coin]: newEntry };

  await db.update(users).set({ cryptoWallets: updated }).where(eq(users.discordId, interaction.user.id));
  invalidateUser(interaction.user.id);

  const successMsg = isBinance
    ? `✅ Binance Pay ID saved: \`${address}\`\nPayouts in stablecoin will be sent to this Binance account.`
    : `✅ **${coin}${network ? ` (${network})` : ""}** wallet saved: \`${address}\``;
  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(successMsg)],
  });
}
