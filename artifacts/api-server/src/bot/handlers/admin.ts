import {
  type ChatInputCommandInteraction,
  type TextChannel,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { users, trustLogs } from "@workspace/db";
import { setupGuild, invalidateSetupCache } from "../setup.js";
import { upsertUser, getUserByDiscordId } from "../db.js";
import { invalidateUser } from "../cache.js";
import { makeEmbed, formatMoney } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";

export async function handleSetupCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  invalidateSetupCache(guild.id);
  const setup = await setupGuild(guild);

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ Server Setup Complete")
        .setDescription("All roles, categories, and channels have been created/verified.")
        .addFields(
          {
            name: "Roles",
            value: [setup.adminRole, setup.modRole, setup.verifiedRole].map((r) => r.toString()).join("\n"),
          },
          {
            name: "📣 Community Channels",
            value: [
              setup.announcementsChannel,
              setup.startHereChannel,
              setup.guideChannel,
              setup.generalChannel,
              setup.referralEventsChannel,
            ].map((c) => c.toString()).join("\n"),
          },
          {
            name: "💼 Earn Channels",
            value: [
              setup.tasksChannel,
              setup.leaderboardChannel,
              setup.verificationLogChannel,
              setup.taskLogsChannel,
              setup.withdrawalLogChannel,
            ].map((c) => c.toString()).join("\n"),
          },
        ),
    ],
  });
}

export async function handleAddMod(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const target = interaction.options.getUser("user", true);
  const guild = interaction.guild!;
  const member = await guild.members.fetch(target.id);
  const { modRole } = await setupGuild(guild);

  await member.roles.add(modRole);
  await upsertUser(target.id, target.username);
  await db.update(users).set({ isMod: true }).where(eq(users.discordId, target.id));
  invalidateUser(target.id);

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ <@${target.id}> is now a Mod.`)],
  });
}

export async function handleRemoveMod(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const target = interaction.options.getUser("user", true);
  const guild = interaction.guild!;
  const member = await guild.members.fetch(target.id);
  const { modRole } = await setupGuild(guild);

  await member.roles.remove(modRole);
  await db.update(users).set({ isMod: false }).where(eq(users.discordId, target.id));
  invalidateUser(target.id);

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ Removed Mod role from <@${target.id}>.`)],
  });
}

export async function handleAddAdmin(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const target = interaction.options.getUser("user", true);
  const guild = interaction.guild!;
  const member = await guild.members.fetch(target.id);
  const { adminRole } = await setupGuild(guild);

  await member.roles.add(adminRole);
  await upsertUser(target.id, target.username);
  await db.update(users).set({ isAdmin: true }).where(eq(users.discordId, target.id));
  invalidateUser(target.id);

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ <@${target.id}> is now an Admin.`)],
  });
}

export async function handleFlagUser(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const target = interaction.options.getUser("user", true);
  const reason = interaction.options.getString("reason") ?? "No reason provided";

  await db.execute(
    sql`UPDATE users SET flagged = true, trust_score = GREATEST(0, trust_score - 10) WHERE discord_id = ${target.id}`
  );
  invalidateUser(target.id);

  const user = await getUserByDiscordId(target.id);
  if (user) {
    await db.insert(trustLogs).values({
      userId: user.id,
      discordId: target.id,
      delta: -10,
      reason: `manually flagged by admin: ${reason}`,
    }).catch(() => {});
  }

  try {
    const guild = interaction.guild!;
    const member = await guild.members.fetch(target.id);
    await member.send({
      embeds: [
        makeEmbed(COLORS.DANGER)
          .setTitle("🚩 Account Flagged")
          .setDescription(`Your account on **${guild.name}** has been flagged.\n\n**Reason:** ${reason}\n\nContact an admin if you believe this is an error.`),
      ],
    });
  } catch {
    logger.warn({ discordId: target.id }, "Could not DM flagged user");
  }

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.WARNING).setDescription(`🚩 <@${target.id}> has been flagged.`)],
  });
}

export async function handleUnflagUser(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const target = interaction.options.getUser("user", true);

  await db.update(users).set({ flagged: false }).where(eq(users.discordId, target.id));
  invalidateUser(target.id);

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ <@${target.id}>'s flag has been cleared.`)],
  });
}

/**
 * Shared balance-adjustment logic used by both /addbalance, /removebalance,
 * and the dashboard's POST /admin/users/:id/adjust-balance endpoint. Pass a
 * positive `delta` to credit the user, negative to debit. Returns the new
 * balance and the user row.
 */
export async function adjustUserBalance(opts: {
  discordId: string;
  delta: number;
  reason: string;
  actor: string;
}): Promise<{
  newBalance: string;
  previousBalance: string;
  appliedDelta: number;
  requestedDelta: number;
  clamped: boolean;
  user: typeof users.$inferSelect;
} | null> {
  const { discordId, delta, reason, actor } = opts;

  const result = await db.execute<{
    id: number;
    new_balance: string;
    prev_balance: string;
  }>(
    sql`WITH prev AS (
          SELECT id, balance_available AS prev_balance
          FROM users
          WHERE discord_id = ${discordId}
          FOR UPDATE
        ),
        upd AS (
          UPDATE users u
          SET balance_available = GREATEST(0::numeric, u.balance_available + ${delta}::numeric)
          FROM prev
          WHERE u.id = prev.id
          RETURNING u.id, u.balance_available AS new_balance, prev.prev_balance
        )
        SELECT id, new_balance::text, prev_balance::text FROM upd`
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0]!;
  const prevNum = Number(row.prev_balance);
  const newNum = Number(row.new_balance);
  const appliedDelta = Number((newNum - prevNum).toFixed(2));
  const clamped = Math.abs(appliedDelta - delta) > 0.0001;

  const reasonStr = clamped
    ? `balance ${appliedDelta >= 0 ? "+" : ""}${appliedDelta} (requested ${delta >= 0 ? "+" : ""}${delta}, clamped at 0) by ${actor}: ${reason}`
    : `balance ${appliedDelta >= 0 ? "+" : ""}${appliedDelta} by ${actor}: ${reason}`;

  await db
    .insert(trustLogs)
    .values({
      userId: row.id,
      discordId,
      delta: 0,
      reason: reasonStr,
    })
    .catch(() => {});

  invalidateUser(discordId);

  const [user] = await db.select().from(users).where(eq(users.id, row.id)).limit(1);
  return {
    newBalance: row.new_balance,
    previousBalance: row.prev_balance,
    appliedDelta,
    requestedDelta: delta,
    clamped,
    user: user!,
  };
}

export async function handleAddBalance(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getNumber("amount", true);
  const reason = interaction.options.getString("reason") ?? "No reason provided";

  if (amount <= 0) {
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Amount must be greater than 0.")],
    });
    return;
  }

  await upsertUser(target.id, target.username);
  const result = await adjustUserBalance({
    discordId: target.id,
    delta: amount,
    reason,
    actor: interaction.user.username,
  });

  if (!result) {
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ User not found.")],
    });
    return;
  }

  // Best-effort DM
  try {
    const dmEmbed = makeEmbed(COLORS.SUCCESS)
      .setTitle("💰 Balance Credited")
      .setDescription(
        `An admin added **${formatMoney(amount)}** to your available balance.\n\n**Reason:** ${reason}\n\n**New balance:** ${formatMoney(result.newBalance)}`,
      );
    const member = await interaction.guild!.members.fetch(target.id);
    await member.send({ embeds: [dmEmbed] });
  } catch {
    logger.warn({ discordId: target.id }, "Could not DM credited user");
  }

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ Balance Added")
        .setDescription(
          `Added **${formatMoney(amount)}** to <@${target.id}>'s available balance.\n\n**Reason:** ${reason}\n**New balance:** ${formatMoney(result.newBalance)}`,
        ),
    ],
  });
}

export async function handleRemoveBalance(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const target = interaction.options.getUser("user", true);
  const amount = interaction.options.getNumber("amount", true);
  const reason = interaction.options.getString("reason") ?? "No reason provided";

  if (amount <= 0) {
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Amount must be greater than 0.")],
    });
    return;
  }

  await upsertUser(target.id, target.username);
  const result = await adjustUserBalance({
    discordId: target.id,
    delta: -amount,
    reason,
    actor: interaction.user.username,
  });

  if (!result) {
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ User not found.")],
    });
    return;
  }

  const actualRemoved = Math.abs(result.appliedDelta);
  const clampNote = result.clamped
    ? `\n\n_Note: requested ${formatMoney(amount)} but user only had ${formatMoney(result.previousBalance)}; balance clamped to 0._`
    : "";

  // Best-effort DM
  try {
    const dmEmbed = makeEmbed(COLORS.WARNING)
      .setTitle("⚠️ Balance Adjusted")
      .setDescription(
        `An admin removed **${formatMoney(actualRemoved)}** from your available balance.\n\n**Reason:** ${reason}\n\n**New balance:** ${formatMoney(result.newBalance)}`,
      );
    const member = await interaction.guild!.members.fetch(target.id);
    await member.send({ embeds: [dmEmbed] });
  } catch {
    logger.warn({ discordId: target.id }, "Could not DM debited user");
  }

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ Balance Removed")
        .setDescription(
          `Removed **${formatMoney(actualRemoved)}** from <@${target.id}>'s available balance.\n\n**Reason:** ${reason}\n**New balance:** ${formatMoney(result.newBalance)}${clampNote}`,
        ),
    ],
  });
}

// ════════════════════════════════════════════════════════════════════════
// /notifywalletmigration — one-shot DM blast asking users with legacy
// crypto wallet entries (the pre-network string format) to re-run
// /setwallet. Self-healing: as users re-set, their entry becomes an
// object and they stop matching the migration query, so running this
// command twice on the same population just re-pings the stragglers.
//
// Binance Pay entries are skipped — they have no on-chain network concept.
// Posts to each user's workspace channel (same delivery vehicle as
// /sendstats) so the DM lands somewhere the bot can definitely reach.
// ════════════════════════════════════════════════════════════════════════

interface WalletMigrationTarget {
  id: number;
  discord_id: string;
  workspace_channel_id: string;
  legacy_coins: string[];
}

export async function handleNotifyWalletMigration(interaction: ChatInputCommandInteraction) {
  // Admin-only — this command can DM every active member. Permission
  // gate mirrors /massdm.
  const perms = interaction.member?.permissions;
  const hasPerm =
    typeof perms === "object" && perms !== null && "has" in perms
      ? perms.has(PermissionFlagsBits.Administrator)
      : false;
  if (!hasPerm) {
    return interaction.reply({ content: "❌ Only admins can use this command.", flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild;
  if (!guild) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Run this inside the server.")],
    });
  }

  // Pull every verified user with a non-empty wallet bag. We filter the
  // legacy-string check in JS because each entry's shape varies.
  let candidates: Array<{ id: number; discord_id: string; workspace_channel_id: string | null; crypto_wallets: unknown }>;
  try {
    const r = await pool.query<{ id: number; discord_id: string; workspace_channel_id: string | null; crypto_wallets: unknown }>(
      `SELECT id, discord_id, workspace_channel_id, crypto_wallets
         FROM users
        WHERE verified = true
          AND crypto_wallets IS NOT NULL
          AND crypto_wallets::text <> '{}'
        ORDER BY id ASC`
    );
    candidates = r.rows;
  } catch (err) {
    logger.error({ err }, "notifywalletmigration: failed to load users");
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Failed to load users from the database.")],
    });
  }

  // A user needs the DM if ANY non-Binance entry is still a bare string
  // (legacy format, no network attached). Binance has no on-chain network
  // so we skip it. Empty / malformed entries are silently ignored.
  const targets: WalletMigrationTarget[] = [];
  for (const u of candidates) {
    if (!u.workspace_channel_id) continue;
    const wallets = (u.crypto_wallets ?? {}) as Record<string, unknown>;
    const legacyCoins: string[] = [];
    for (const [coin, val] of Object.entries(wallets)) {
      if (coin === "BINANCE") continue;
      if (typeof val === "string" && val.trim().length > 0) {
        legacyCoins.push(coin);
      }
    }
    if (legacyCoins.length > 0) {
      targets.push({
        id: u.id,
        discord_id: u.discord_id,
        workspace_channel_id: u.workspace_channel_id,
        legacy_coins: legacyCoins,
      });
    }
  }

  const total = targets.length;
  if (total === 0) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.SUCCESS).setDescription(
        "✅ All verified users with crypto wallets are already on the new format — nothing to do."
      )],
    });
  }

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.PRIMARY).setDescription(
      `📨 Notifying **${total}** user${total === 1 ? "" : "s"} with legacy crypto wallets…`
    )],
  });

  let sent = 0;
  let failed = 0;
  // Sequential with a small delay — this is a one-shot migration ping,
  // not a high-frequency operation, so we keep things simple and well
  // below any Discord rate limits.
  for (const t of targets) {
    try {
      let channel: TextChannel | null = null;
      try {
        const fetched = await guild.channels.fetch(t.workspace_channel_id);
        if (fetched && fetched.type === ChannelType.GuildText) channel = fetched as TextChannel;
      } catch { /* deleted */ }

      if (!channel) {
        failed++;
        continue;
      }

      const coinList = t.legacy_coins.map((c) => `**${c}**`).join(", ");
      const embed = makeEmbed(COLORS.WARNING)
        .setTitle("⚠️ Please re-save your crypto wallet")
        .setDescription(
          `Hey <@${t.discord_id}> — we just upgraded \`/setwallet\` so the bot can record **which chain** your crypto address is on. ` +
          `Sending crypto to the wrong chain = **permanently lost funds**, so we'd rather ask once than risk a wrong-network payout.\n\n` +
          `Your saved wallet${t.legacy_coins.length === 1 ? "" : "s"} for ${coinList} need to be re-saved with the new network option.\n\n` +
          `**What to do (takes 30 seconds):**\n` +
          `Run \`/setwallet\` again for each of: ${coinList}\n` +
          `• **USDT** → pick TRC20 / ERC20 / BEP20 / Solana / Polygon\n` +
          `• **ETH** → pick ERC20 / Arbitrum / Optimism / Base / Polygon (default: ERC20)\n` +
          `• **BTC** → pick Bitcoin or Lightning (default: Bitcoin)\n\n` +
          `Not sure which network? Open your wallet/exchange's **Deposit** screen — the network it shows you there is the one to pick.`
        );

      await channel.send({ content: `<@${t.discord_id}>`, embeds: [embed] });
      sent++;
    } catch (err) {
      failed++;
      logger.warn({ err, userId: t.id }, "notifywalletmigration: per-user post failed");
    }
    await new Promise((res) => setTimeout(res, 400));
  }

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("📊 Wallet migration notices sent")
        .addFields(
          { name: "✅ Sent", value: String(sent), inline: true },
          { name: "❌ Failed", value: String(failed), inline: true },
          { name: "Total", value: String(total), inline: true },
        )
        .setFooter({ text: "Re-run anytime — users who've already re-saved are skipped automatically." }),
    ],
  });

  logger.info({ sent, failed, total, sender: interaction.user.id }, "notifywalletmigration completed");
}
