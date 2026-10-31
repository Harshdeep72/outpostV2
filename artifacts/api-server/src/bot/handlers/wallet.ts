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
      { name: "💸 Auto Payouts", value: "Every Saturday UTC", inline: true },
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
  return interaction.reply({
    embeds: [
      makeEmbed(COLORS.DANGER).setDescription(
        "❌ **PayPal is not supported.**\n\n" +
        "**Supported payout methods are:**\n" +
        "• **USDT (BEP-20)** — `/setwallet`\n" +
        "• **UPI** — `/setupi`\n" +
        "• **GCash** — `/setgcash`"
      ),
    ],
    flags: 64,
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
  if (user.upiId) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You have already set a UPI ID. To change it, please contact an admin.")],
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

export async function handleSetGcash(interaction: ChatInputCommandInteraction) {
  const rawNumber = interaction.options.getString("number", true).trim().replace(/[\s\-]/g, "");

  // Format validation: 11 digits starting with 09, or 12 digits starting with +639 or 639
  let cleanNumber = rawNumber;
  if (/^09\d{9}$/.test(rawNumber)) {
    cleanNumber = rawNumber;
  } else if (/^(\+?63)9\d{9}$/.test(rawNumber)) {
    cleanNumber = "0" + rawNumber.replace(/^\+?63/, "");
  } else {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Invalid GCash number. Please enter a valid 11-digit Philippine mobile number starting with `09` (e.g. `09171234567`).")],
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
  if (user.gcashNumber) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You have already set a GCash number. To change it, please contact an admin.")],
    });
  }

  const duplicateFound = await checkDuplicateDestination(interaction, cleanNumber, "GCash number", interaction.user.id);
  if (duplicateFound) return;

  const existing = (user.cryptoWallets as Record<string, unknown>) ?? {};
  const updatedWallets = { ...existing, GCASH: { address: cleanNumber, network: "GCash" } };

  await db.update(users).set({ gcashNumber: cleanNumber, cryptoWallets: updatedWallets }).where(eq(users.discordId, interaction.user.id));
  invalidateUser(interaction.user.id);

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ GCash number saved: \`${cleanNumber}\``)],
  });
}

// Only USDT on BEP-20 (BNB Smart Chain) is supported per server policy.
const ALLOWED_NETWORKS: Record<string, readonly string[]> = {
  USDT: ["BEP20"],
};
const DEFAULT_NETWORK: Record<string, string> = {
  USDT: "BEP20",
};
const NETWORK_REQUIRED: ReadonlySet<string> = new Set([]);

export async function handleSetWallet(interaction: ChatInputCommandInteraction) {
  const coin = interaction.options.getString("coin", true);
  const address = interaction.options.getString("address", true).trim();
  const rawNetwork = interaction.options.getString("network", false);

  if (coin !== "USDT") {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only **USDT (BEP-20)** is supported for crypto payouts. Select coin: `USDT`.")],
      flags: 64,
    });
  }

  if (rawNetwork && rawNetwork !== "BEP20") {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only the **BEP-20 (BNB Smart Chain)** network is supported for USDT.\n\nPlease pick `BEP20`.")],
      flags: 64,
    });
  }

  // BEP-20 is BNB Smart Chain (EVM standard: 0x followed by 40 hex chars)
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Invalid USDT (BEP-20) address. It must be a valid 42-character BNB Smart Chain address starting with `0x`.")],
      flags: 64,
    });
  }

  const network = "BEP20";

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
  
  const existing = (user.cryptoWallets as Record<string, unknown>) ?? {};
  if (existing[coin]) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ You have already set a **${coin}** wallet. To change it, please contact an admin.`)],
    });
  }

  const duplicateFound = await checkDuplicateDestination(interaction, address, "USDT (BEP-20) wallet", interaction.user.id);
  if (duplicateFound) return;

  const newEntry = { address, network };
  const updated = { ...existing, [coin]: newEntry };

  await db.update(users).set({ cryptoWallets: updated }).where(eq(users.discordId, interaction.user.id));
  invalidateUser(interaction.user.id);

  const successMsg = `✅ **USDT (BEP-20)** wallet saved: \`${address}\`\nPayouts will be sent via BNB Smart Chain.`;
  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(successMsg)],
  });
}

// ---------------------------------------------------------------------------
// Admin: set / overwrite any user's USDT (BEP-20) wallet
// ---------------------------------------------------------------------------
export async function handleAdminSetWallet(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser("user", true);
  const address    = interaction.options.getString("address", true).trim();

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Invalid USDT (BEP-20) address. Must be a valid 42-character address starting with `0x`.")],
    });
  }

  const target = await getUserByDiscordId(targetUser.id);
  if (!target) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ User <@${targetUser.id}> is not registered in the system.`)],
    });
  }

  const existing = (target.cryptoWallets as Record<string, any>) ?? {};
  const oldEntry = existing["USDT"];
  const oldAddr = typeof oldEntry === "string" ? oldEntry : oldEntry?.address ?? "(none)";

  const updatedWallets = { ...existing, USDT: { address, network: "BEP20" } };

  await db.update(users).set({ cryptoWallets: updatedWallets }).where(eq(users.discordId, targetUser.id));
  invalidateUser(targetUser.id);

  logger.info({ admin: interaction.user.id, target: targetUser.id, oldAddr, address }, "Admin updated USDT wallet");

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ USDT (BEP-20) Wallet Updated")
        .addFields(
          { name: "User", value: `<@${targetUser.id}>`, inline: true },
          { name: "Old Wallet", value: `\`${oldAddr}\``, inline: true },
          { name: "New Wallet", value: `\`${address}\` (BEP20)`, inline: true },
        ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Admin: set / overwrite any user's UPI ID
// ---------------------------------------------------------------------------
export async function handleAdminSetUpi(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser("user", true);
  const newUpiId   = interaction.options.getString("upi_id", true).trim();

  // Basic format validation
  if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(newUpiId)) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Invalid UPI ID format. Expected `username@bank` (e.g. `john@upi`).")],
    });
  }

  const target = await getUserByDiscordId(targetUser.id);
  if (!target) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ User <@${targetUser.id}> is not registered in the system.`)],
    });
  }

  const oldUpiId = target.upiId ?? "(none)";

  // Check the new UPI isn't already in use by someone else
  const duplicate = await db.query.users.findFirst({
    columns: { discordId: true },
    where: (u, { and, ne, sql: s }) =>
      and(s`LOWER(${u.upiId}) = ${newUpiId.toLowerCase()}`, ne(u.discordId, targetUser.id)),
  });
  if (duplicate) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ UPI ID \`${newUpiId}\` is already linked to another account.`)],
    });
  }

  await db.update(users).set({ upiId: newUpiId }).where(eq(users.discordId, targetUser.id));
  invalidateUser(targetUser.id);

  logger.info({ admin: interaction.user.id, target: targetUser.id, oldUpiId, newUpiId }, "Admin updated UPI ID");

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ UPI ID Updated")
        .addFields(
          { name: "User",    value: `<@${targetUser.id}>`, inline: true },
          { name: "Old UPI", value: `\`${oldUpiId}\``,     inline: true },
          { name: "New UPI", value: `\`${newUpiId}\``,     inline: true },
        ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Admin: set / overwrite any user's GCash number
// ---------------------------------------------------------------------------
export async function handleAdminSetGcash(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const targetUser = interaction.options.getUser("user", true);
  const rawNumber = interaction.options.getString("number", true).trim().replace(/[\s\-]/g, "");

  let cleanNumber = rawNumber;
  if (/^09\d{9}$/.test(rawNumber)) {
    cleanNumber = rawNumber;
  } else if (/^(\+?63)9\d{9}$/.test(rawNumber)) {
    cleanNumber = "0" + rawNumber.replace(/^\+?63/, "");
  } else {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Invalid GCash number format. Expected `09XXXXXXXXX` (11 digits).")],
    });
  }

  const target = await getUserByDiscordId(targetUser.id);
  if (!target) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ User <@${targetUser.id}> is not registered in the system.`)],
    });
  }

  const oldNum = target.gcashNumber ?? "(none)";
  const existing = (target.cryptoWallets as Record<string, unknown>) ?? {};
  const updatedWallets = { ...existing, GCASH: { address: cleanNumber, network: "GCash" } };

  await db.update(users).set({ gcashNumber: cleanNumber, cryptoWallets: updatedWallets }).where(eq(users.discordId, targetUser.id));
  invalidateUser(targetUser.id);

  logger.info({ admin: interaction.user.id, target: targetUser.id, oldNum, cleanNumber }, "Admin updated GCash number");

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ GCash Number Updated")
        .addFields(
          { name: "User", value: `<@${targetUser.id}>`, inline: true },
          { name: "Old GCash", value: `\`${oldNum}\``, inline: true },
          { name: "New GCash", value: `\`${cleanNumber}\``, inline: true },
        ),
    ],
  });
}
