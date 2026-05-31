import {
  type ChatInputCommandInteraction,
  type TextChannel,
  ChannelType,
} from "discord.js";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { users, trustLogs } from "@workspace/db";
import { setupGuild, invalidateSetupCache } from "../setup.js";
import { upsertUser, getUserByDiscordId } from "../db.js";
import { invalidateUser } from "../cache.js";
import { makeEmbed, formatMoney, hasAdminRole, hasModRole } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";
import { checkSubmissionNow } from "../redditLivenessChecker.js";

export async function handleSetupCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(actingMember, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can run `/setup`.")] });
  }

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
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(actingMember, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can add Mods.")] });
  }
  const target = interaction.options.getUser("user", true);
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
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(actingMember, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can remove Mods.")] });
  }
  const target = interaction.options.getUser("user", true);
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
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(actingMember, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can add Admins.")] });
  }
  const target = interaction.options.getUser("user", true);
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
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(actingMember, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can flag users.")] });
  }
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
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(actingMember, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can unflag users.")] });
  }
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
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(actingMember, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can add balance.")] });
  }
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
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(actingMember, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can remove balance.")] });
  }
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
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(actingMember, guild)) {
    return interaction.reply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can use this command.")], flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });

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

export async function handleCheckSubmission(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(actingMember, guild) && !hasAdminRole(actingMember, guild)) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Mods and Admins can use `/checksubmission`.")],
    });
  }

  const submissionId = interaction.options.getInteger("id", true);

  // Show a "checking…" state immediately while the Reddit fetch runs.
  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.WARNING)
        .setTitle("🔍 Checking submission…")
        .setDescription(`Fetching Reddit liveness for submission **#${submissionId}**. This takes a few seconds.`),
    ],
  });

  let result;
  try {
    result = await checkSubmissionNow(submissionId);
  } catch (err) {
    logger.error({ err, submissionId }, "handleCheckSubmission: checkSubmissionNow threw");
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Unexpected error while checking submission #${submissionId}.`)],
    });
  }

  // ── Error cases ────────────────────────────────────────────────────────────
  if (result.errorMessage) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ ${result.errorMessage}`)],
    });
  }

  // ── Build result embed ─────────────────────────────────────────────────────

  // newStatus is null when recheckRedditLiveness returned "unknown" (network
  // error, blocked proxy, comment_missing treated as inconclusive, etc.).
  // In that case we must NOT fall back to previousStatus and show "Live" —
  // we should clearly communicate that the check was inconclusive.
  if (result.newStatus === null) {
    const embed = makeEmbed(COLORS.WARNING)
      .setTitle(`❔ Submission #${submissionId} — Inconclusive`)
      .setDescription(
        [
          `Last known status: **${result.previousStatus ?? "unknown"}**`,
          result.reason ? `Reason: ${result.reason}` : null,
          "",
          "Reddit was unreachable or returned an inconclusive result. " +
          "Try again in a few minutes, or check the proof link manually.",
        ].filter((l) => l !== null).join("\n")
      );

    if (result.proofLink) {
      embed.addFields({ name: "Proof", value: `[Open Reddit post](${result.proofLink})`, inline: false });
    }
    embed.setFooter({ text: `Checked by ${interaction.user.tag} • ${new Date().toUTCString()}` });
    return interaction.editReply({ embeds: [embed] });
  }

  const statusEmoji: Record<string, string> = {
    live: "✅", removed: "🛡️", deleted: "🗑️",
  };
  const statusColor: Record<string, number> = {
    live: COLORS.SUCCESS, removed: COLORS.DANGER, deleted: COLORS.DANGER,
  };

  const currentStatus = result.newStatus;
  const color = statusColor[currentStatus] ?? COLORS.WARNING;
  const emoji = statusEmoji[currentStatus] ?? "❔";

  const lines: string[] = [];

  if (result.statusChanged) {
    lines.push(`Status changed: **${result.previousStatus}** → **${currentStatus}**`);
  } else {
    lines.push(`Status unchanged: **${currentStatus}**`);
  }

  if (result.reason) lines.push(`Reason: ${result.reason}`);

  if (result.reversalTriggered) {
    lines.push(
      "",
      "⏳ **Reversal in progress** — running 45-second confirmation check.",
      "If confirmed removed, the payout will be clawed back and a notice posted to task-logs."
    );
  } else if (
    (currentStatus === "removed" || currentStatus === "deleted") &&
    !result.isReversible
  ) {
    lines.push("", "ℹ️ Payout already processed or submission already reversed — no financial action taken.");
  }

  const embed = makeEmbed(color)
    .setTitle(`${emoji} Submission #${submissionId} — ${currentStatus.charAt(0).toUpperCase() + currentStatus.slice(1)}`)
    .setDescription(lines.join("\n"));

  if (result.proofLink) {
    embed.addFields({ name: "Proof", value: `[Open Reddit post](${result.proofLink})`, inline: false });
  }

  embed.setFooter({ text: `Checked by ${interaction.user.tag} • ${new Date().toUTCString()}` });

  return interaction.editReply({ embeds: [embed] });
}
