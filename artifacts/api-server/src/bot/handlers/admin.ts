import {
  type ChatInputCommandInteraction,
  type TextChannel,
  ChannelType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
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
import { runWeeklyPayouts } from "./weeklyPayouts.js";

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
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ <@${target.id}> is now a Mod.`)]
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

export async function handleReopenSlot(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(actingMember, guild) && !hasAdminRole(actingMember, guild)) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Mods and Admins can use `/reopenslot`.")],
    });
  }

  const submissionId = interaction.options.getInteger("submission_id", true);
  const reason = interaction.options.getString("reason")?.trim() || "Admin decision";
  const adminTag = interaction.user.tag;

  const rows = await db.execute<{
    id: string;
    discord_id: string;
    task_id: string;
    task_title: string;
    task_status: string;
    slots_filled: string;
    max_slots: string;
    campaign_id: string | null;
    channel_message_id: string | null;
    review_status: string;
    reward: string;
    user_id: string | null;
  }>(
    sql`SELECT
          s.id::text              AS id,
          s.discord_id            AS discord_id,
          s.task_id::text         AS task_id,
          s.reward::text          AS reward,
          s.review_status         AS review_status,
          s.user_id::text         AS user_id,
          t.title                 AS task_title,
          t.status                AS task_status,
          t.slots_filled::text    AS slots_filled,
          t.max_slots::text       AS max_slots,
          t.campaign_id::text     AS campaign_id,
          t.channel_message_id    AS channel_message_id
        FROM submissions s
        JOIN tasks t ON t.id = s.task_id
        WHERE s.id = ${submissionId}
        LIMIT 1`
  );

  const row = rows.rows[0];
  if (!row) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Submission #${submissionId} not found.`)],
    });
  }

  if (row.review_status !== "rejected" && row.review_status !== "flagged") {
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.WARNING).setDescription(
          `⚠️ Submission #${submissionId} is currently **${row.review_status}** — only rejected or flagged submissions can have their slot reopened.`
        ),
      ],
    });
  }

  const slotsFilled = parseInt(row.slots_filled);
  const maxSlots = parseInt(row.max_slots);
  const taskId = parseInt(row.task_id);

  if (slotsFilled <= 0) {
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.WARNING).setDescription(
          `⚠️ Task #${taskId} already has 0 slots filled — nothing to reopen.`
        ),
      ],
    });
  }

  // Atomically decrement slots_filled — safe because we verified > 0 above
  // and GREATEST(0, ...) prevents underflow if another admin races us.
  await db.execute(
    sql`UPDATE tasks
        SET slots_filled = GREATEST(0, slots_filled - 1)
        WHERE id = ${taskId}`
  );

  // Audit trail — delta 0 records the event without affecting the user's
  // trust score. Related to submission for full traceability.
  await db.execute(
    sql`INSERT INTO trust_logs (discord_id, delta, reason, related_submission_id, created_at)
        VALUES (${row.discord_id}, 0,
                ${`Slot manually reopened by ${adminTag} — submission #${submissionId}. Reason: ${reason}`},
                ${submissionId}, now())`
  ).catch(() => {});

  invalidateUser(row.discord_id);

  // Refresh the public #tasks card so the freed slot is immediately visible.
  try {
    const { getPrimaryGuild } = await import("../discord-client.js");
    const { setupGuild: _setupGuild } = await import("../setup.js");
    const { buildPublicTaskEmbed, buildPublicButtons, buildCampaignProgressEmbed, refreshCampaignSummary } = await import("../task-creation.js");
    const { db: _db, tasks: _tasks } = await import("@workspace/db");
    const { eq: _eq } = await import("drizzle-orm");

    const g = getPrimaryGuild();
    if (g) {
      const [refreshed] = await _db.select().from(_tasks).where(_eq(_tasks.id, taskId)).limit(1);
      if (refreshed && refreshed.status === "open" && refreshed.channelMessageId) {
        const { tasksChannel } = await _setupGuild(g);
        const card = buildPublicTaskEmbed(refreshed);
        const prog = refreshed.campaignId
          ? await buildCampaignProgressEmbed(refreshed.campaignId)
          : null;
        const msg = await (tasksChannel as import("discord.js").TextChannel).messages
          .fetch(refreshed.channelMessageId)
          .catch(() => null);
        if (msg) {
          await msg.edit({
            embeds: prog ? [card, prog] : [card],
            components: [buildPublicButtons(refreshed.id, false)],
          }).catch(() => {});
        }
      }
      if (row.campaign_id) {
        const { refreshCampaignSummary: rcs } = await import("../task-creation.js");
        void rcs(parseInt(row.campaign_id));
      }
    }
  } catch (err) {
    logger.warn({ err, taskId }, "handleReopenSlot: task card refresh failed (non-fatal)");
  }

  // Best-effort DM to the worker so they know the slot is available again.
  try {
    const member = await guild.members.fetch(row.discord_id).catch(() => null);
    if (member) {
      const dmEmbed = makeEmbed(COLORS.WARNING)
        .setTitle("🔓 Task Slot Reopened by Admin")
        .setDescription(
          [
            `An admin has manually reopened the task slot held by your submission **#${submissionId}** for **${row.task_title}**.`,
            "",
            `The slot is now available for another earner to claim. Your submission remains rejected.`,
            "",
            `If you have questions, please contact staff.`,
          ].join("\n")
        );
      await member.send({ embeds: [dmEmbed] });
    }
  } catch {
    logger.debug({ discordId: row.discord_id }, "handleReopenSlot: could not DM worker");
  }

  const newSlotsFilled = Math.max(0, slotsFilled - 1);

  return interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle(`🔓 Slot Reopened — Task #${taskId}`)
        .setDescription(
          [
            `**${row.task_title}**`,
            "",
            `Submission **#${submissionId}** (was **${row.review_status}**) released its slot.`,
            `Slots: **${slotsFilled}/${maxSlots}** → **${newSlotsFilled}/${maxSlots}**`,
            "",
            `**Reason:** ${reason}`,
            `The task card in #tasks has been refreshed and the slot is now claimable.`,
          ].join("\n")
        )
        .addFields(
          { name: "Worker", value: `<@${row.discord_id}>`, inline: true },
          { name: "Submission", value: `#${submissionId}`, inline: true },
          { name: "Reward", value: formatMoney(parseFloat(row.reward)), inline: true },
        )
        .setFooter({ text: `Reopened by ${adminTag} • ${new Date().toUTCString()}` }),
    ],
  });
}

export async function handleApproveSubmission(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(actingMember, guild) && !hasAdminRole(actingMember, guild)) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Mods and Admins can use `/approvesubmission`.")],
    });
  }

  const submissionId = interaction.options.getInteger("id", true);

  const rows = await db.execute<{
    id: string;
    discord_id: string;
    reward: string;
    live_status: string;
    review_status: string;
    review_reason: string | null;
    moved_to_available: number;
  }>(
    sql`SELECT s.id::text            AS id,
               s.discord_id          AS discord_id,
               s.reward::text        AS reward,
               s.live_status         AS live_status,
               s.review_status       AS review_status,
               s.review_reason       AS review_reason,
               s.moved_to_available  AS moved_to_available
        FROM submissions s
        WHERE s.id = ${submissionId}
        LIMIT 1`
  );

  const row = rows.rows[0];
  if (!row) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Submission #${submissionId} not found.`)],
    });
  }

  if (row.review_status !== "rejected") {
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.WARNING).setDescription(
          `⚠️ Submission #${submissionId} is currently **${row.review_status}** — only rejected submissions can be manually approved.`
        ),
      ],
    });
  }

  const reward = parseFloat(row.reward);

  // Credit the reward to balance_available and restore the trust deduction.
  await db.execute(
    sql`UPDATE users
        SET balance_available = balance_available + ${reward}::numeric,
            total_earned      = total_earned      + ${reward}::numeric,
            trust_score       = trust_score       + 0.05
        WHERE discord_id = ${row.discord_id}`
  );

  const adminTag = interaction.user.tag;
  const reviewReason = `Manually approved by ${adminTag} — liveness check was incorrect.`;

  await db.execute(
    sql`UPDATE submissions
        SET live_status    = 'live',
            review_status  = 'accepted',
            removal_reason = NULL,
            review_reason  = ${reviewReason}
        WHERE id = ${submissionId}`
  );

  // Log the correction to trust_logs for audit trail.
  await db.execute(
    sql`INSERT INTO trust_logs (discord_id, delta, reason, related_submission_id, created_at)
        VALUES (${row.discord_id}, 0,
                ${`Manual approval by ${adminTag}: +${formatMoney(reward)} credited, trust restored +0.05 (submission #${submissionId})`},
                ${submissionId}, now())`
  ).catch(() => {});

  invalidateUser(row.discord_id);

  // Best-effort DM to the user.
  try {
    const member = await guild.members.fetch(row.discord_id);
    const dmEmbed = makeEmbed(COLORS.SUCCESS)
      .setTitle("✅ Submission Approved — Reward Credited")
      .setDescription(
        [
          `Your submission **#${submissionId}** has been manually reviewed and approved.`,
          "",
          `**${formatMoney(reward)}** has been added to your available balance.`,
          "",
          "We apologise for the inconvenience — the automated liveness check made an error and it has since been corrected.",
        ].join("\n")
      );
    await member.send({ embeds: [dmEmbed] });
  } catch {
    logger.warn({ discordId: row.discord_id }, "handleApproveSubmission: could not DM user");
  }

  return interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle(`✅ Submission #${submissionId} — Manually Approved`)
        .setDescription(
          [
            `**${formatMoney(reward)}** credited to <@${row.discord_id}>'s available balance.`,
            `Trust score restored (+0.05).`,
            `Previous status: **${row.live_status}** / **${row.review_status}**`,
            row.review_reason ? `Previous rejection reason: ${row.review_reason}` : null,
          ].filter(Boolean).join("\n")
        )
        .setFooter({ text: `Approved by ${adminTag} • ${new Date().toUTCString()}` }),
    ],
  });
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
      "If confirmed removed, the payout will be clawed back, the submission marked **Rejected**, and a notice posted to task-logs."
    );
  } else if (result.clawbackTriggered) {
    lines.push(
      "",
      "💸 **Clawback executed** — the reward has been deducted from the user's available balance.",
      "Submission marked **Rejected**."
    );
  } else if (result.autoRejected) {
    lines.push(
      "",
      "🚫 **Submission auto-rejected** — marked as Rejected. No funds were at stake."
    );
  } else if (
    (currentStatus === "removed" || currentStatus === "deleted") &&
    !result.isReversible
  ) {
    lines.push("", "ℹ️ Submission already reversed or rejected — no further financial action taken.");
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

export async function handleProcessHolds(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(actingMember, guild)) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can use `/processholds`.")],
    });
  }

  try {
    const { runPendingProcessorNow } = await import("../pendingProcessor.js");
    const { runPendingSweepNow } = await import("../pendingReviewSweeper.js");

    const processorResult = await runPendingProcessorNow(interaction.client, true);
    const sweeperResult = await runPendingSweepNow(true);

    const lines = [
      `**10-Min / Configured Holds (Pending Processor):**`,
      `• Processed to Available: ${processorResult.acceptedProcessed}`,
      `• Re-checked Reddit Liveness: ${processorResult.holdProcessed}`,
      ``,
      `**24h Sweeper (Pending Review):**`,
      `• Triggered 1 batch of 100 submissions (check logs for results).`,
    ];

    await interaction.editReply({
      embeds: [
        makeEmbed(COLORS.SUCCESS)
          .setTitle("🧹 Background Processors Triggered")
          .setDescription(lines.join("\n")),
      ],
    });
  } catch (err) {
    logger.error({ err }, "handleProcessHolds failed");
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Failed to run processors: ${String(err)}`)],
    });
  }
}

export async function handleForcePayout(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  
  if (!hasAdminRole(actingMember, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can force a bulk payout.")] });
  }

  const { withdrawalLogChannel } = await setupGuild(guild);
  
  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription("⏳ Processing forced bulk payout...")],
  });

  const { processed, totalAmount, skipped } = await runWeeklyPayouts(guild, true);

  await withdrawalLogChannel.send({
    embeds: [
      makeEmbed(COLORS.ACCENT)
        .setTitle("⚠️ Manual Bulk Payout Triggered")
        .setDescription(`Admin <@${interaction.user.id}> manually triggered a forced bulk payout.`)
    ]
  });

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ Bulk Payout Complete")
        .addFields(
          { name: "Users Processed", value: String(processed), inline: true },
          { name: "Total Owed", value: formatMoney(totalAmount), inline: true },
          { name: "Skipped (No Wallet)", value: String(skipped), inline: true }
        )
    ]
  });
}

export async function handleRequeueCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(actingMember, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can run this command.")] });
  }

  const res = await db.execute(sql`
    UPDATE submissions
    SET review_status = 'pending_hold',
        last_checked_at = NOW(),
        review_reason = NULL,
        available_at = COALESCE(available_at, NOW() + INTERVAL '7 days')
    WHERE review_status = 'pending'
    AND (
      review_reason ILIKE '%hold-end liveness check%'
      OR review_reason ILIKE '%hold-end check inconclusive%'
      OR review_reason ILIKE '%Post is in r/%'
      OR review_reason ILIKE '%Reddit API unreachable%'
    )
    RETURNING id
  `);
  
  // Drizzle with postgres.js returns an array of returned rows directly
  const count = Array.isArray(res) ? res.length : ((res as any).rowCount || 0);

  if (count === 0) {
    await interaction.editReply({
      content: "✅ No inconclusive hold-end submissions found — queue is clean"
    });
  } else {
    await interaction.editReply({
      content: `✅ Requeued ${count} submissions back to pending_hold for automatic retry`
    });

    const { taskLogsChannel } = await setupGuild(guild);
    if (taskLogsChannel) {
      const getStatusLabel = (status: string, movedToAvailable: number) => {
        if (status === "accepted") {
          return movedToAvailable === 1 ? "✅ Accepted" : "⏱️ Accepted (Hold)";
        }
        if (status === "pending_hold") return "⏱️ Pending Hold";
        if (status === "pending") return "⏳ Pending";
        if (status === "rejected") return "❌ Rejected";
        if (status === "flagged") return "🚩 Flagged";
        return status;
      };

      await taskLogsChannel.send({
        content: `🔄 /requeue triggered by <@${interaction.user.id}> — ${count} submissions moved back to pending_hold`
      });
    }
  }
}

export async function handleSubmissionCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(actingMember, guild) && !hasAdminRole(actingMember, guild)) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Mods and Admins can use `/submission`.")],
    });
  }

  const submissionId = interaction.options.getInteger("id");
  const targetUser = interaction.options.getUser("user");

  const formatDiscordTime = (dateStr: string | null, format: "R" | "F" = "F") => {
    if (!dateStr) return "—";
    const unix = Math.floor(new Date(dateStr).getTime() / 1000);
    return `<t:${unix}:${format}>`;
  };

  const getStatusLabel = (status: string, movedToAvailable: number) => {
    if (status === "accepted") {
      return movedToAvailable === 1 ? "✅ Accepted" : "⏱️ Accepted (Hold)";
    }
    if (status === "pending_hold") return "⏱️ Pending Hold";
    if (status === "pending") return "⏳ Pending";
    if (status === "rejected") return "❌ Rejected";
    if (status === "flagged") return "🚩 Flagged";
    return status;
  };

  const liveEmoji: Record<string, string> = {
    live: "✅ Live",
    removed: "🛡️ Removed",
    deleted: "🗑️ Deleted",
    unknown: "❔ Unknown",
  };

  type SubmissionDetail = {
    id: number;
    claim_id: number;
    task_id: number;
    user_id: number;
    discord_id: string;
    proof_link: string;
    screenshot_url: string | null;
    reward: string;
    review_status: string;
    reviewer_discord_id: string | null;
    review_reason: string | null;
    log_message_id: string | null;
    available_at: string | null;
    moved_to_available: number;
    submitted_at: string;
    reviewed_at: string | null;
    live_status: string;
    last_checked_at: string | null;
    removal_reason: string | null;
    live_status_changed_at: string | null;
    paid_at: string | null;
    proof_verified_via: string | null;
    discord_username: string;
    reddit_username: string | null;
    task_title: string;
  };

  if (submissionId) {
    // ── CASE 1: Single Submission View ──
    const rows = await db.execute<SubmissionDetail>(
      sql`SELECT s.*, u.discord_username, u.reddit_username, t.title as task_title
          FROM submissions s
          LEFT JOIN users u ON u.id = s.user_id
          LEFT JOIN tasks t ON t.id = s.task_id
          WHERE s.id = ${submissionId} LIMIT 1`
    );

    if (rows.rows.length === 0) {
      return interaction.editReply({
        embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Submission **#${submissionId}** not found.`)],
      });
    }

    const sub = rows.rows[0]!;
    const unixSubmitted = Math.floor(new Date(sub.submitted_at).getTime() / 1000);

    const payoutStatus = sub.moved_to_available === 1
      ? `Paid ✅ (on ${formatDiscordTime(sub.paid_at)})`
      : sub.available_at
        ? `Unpaid ⏳ (Releases ${formatDiscordTime(sub.available_at, "R")})`
        : "Unpaid ⏳";

    const embed = makeEmbed(COLORS.PRIMARY)
      .setTitle(`🔍 Submission #${sub.id} Details`)
      .addFields(
        { name: "Worker", value: `<@${sub.discord_id}> (${sub.discord_username})`, inline: true },
        { name: "Reddit User", value: sub.reddit_username ? `[u/${sub.reddit_username}](https://reddit.com/u/${sub.reddit_username})` : "—", inline: true },
        { name: "Task", value: `#${sub.task_id} — ${sub.task_title}`, inline: false },
        { name: "Reward", value: formatMoney(sub.reward), inline: true },
        { name: "Review Status", value: getStatusLabel(sub.review_status, sub.moved_to_available), inline: true },
        { name: "Live Status", value: liveEmoji[sub.live_status] ?? sub.live_status, inline: true },
        { name: "Proof Link", value: `[Open Proof Link](${sub.proof_link})`, inline: false },
        { name: "Submitted At", value: `<t:${unixSubmitted}:F> (<t:${unixSubmitted}:R>)`, inline: false }
      );

    if (sub.reviewer_discord_id) {
      const reviewerValue = sub.reviewer_discord_id === "system"
        ? "🤖 System (Auto-validated)"
        : sub.reviewer_discord_id.startsWith("dashboard:")
          ? `Dashboard User: **${sub.reviewer_discord_id.replace("dashboard:", "")}**`
          : `<@${sub.reviewer_discord_id}>`;
      embed.addFields(
        { name: "Reviewed By", value: reviewerValue, inline: true },
        { name: "Reviewed At", value: formatDiscordTime(sub.reviewed_at), inline: true }
      );
    }

    if (sub.review_reason) {
      embed.addFields({ name: "Review/Verdict Reason", value: sub.review_reason, inline: false });
    }

    if (sub.removal_reason) {
      embed.addFields({ name: "Reddit Removal Reason", value: sub.removal_reason, inline: false });
    }

    embed.addFields({ name: "Payout Status", value: payoutStatus, inline: false });

    if (sub.screenshot_url) {
      embed.setImage(sub.screenshot_url);
    }

    embed.setFooter({ text: `Requested by ${interaction.user.tag} • ${new Date().toUTCString()}` });

    return interaction.editReply({ embeds: [embed] });
  }

  // ── CASE 2: List Submissions View ──
  type SubmissionSummary = {
    id: number;
    task_id: number;
    reward: string;
    review_status: string;
    moved_to_available: number;
    submitted_at: string;
    discord_username?: string;
    discord_id?: string;
    task_title: string;
  };

  let rows;
  if (targetUser) {
    rows = await db.execute<SubmissionSummary>(
      sql`SELECT s.id, s.task_id, s.reward, s.review_status, s.moved_to_available, s.submitted_at, u.discord_username, t.title as task_title
          FROM submissions s
          LEFT JOIN users u ON u.id = s.user_id
          LEFT JOIN tasks t ON t.id = s.task_id
          WHERE s.discord_id = ${targetUser.id}
          ORDER BY s.id DESC LIMIT 10`
    );
  } else {
    rows = await db.execute<SubmissionSummary>(
      sql`SELECT s.id, s.task_id, s.reward, s.review_status, s.moved_to_available, s.submitted_at, u.discord_username, t.title as task_title
          FROM submissions s
          LEFT JOIN users u ON u.id = s.user_id
          LEFT JOIN tasks t ON t.id = s.task_id
          WHERE s.review_status = 'pending'
          ORDER BY s.id DESC LIMIT 10`
    );
  }

  if (rows.rows.length === 0) {
    const errorMsg = targetUser
      ? `❌ No submissions found for <@${targetUser.id}>.`
      : `✅ No pending submissions requiring review.`;
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.PRIMARY).setDescription(errorMsg)],
    });
  }

  // If there's exactly 1 submission, just render it directly instead of a list.
  if (rows.rows.length === 1) {
    const singleId = rows.rows[0].id;
    const subRows = await db.execute<SubmissionDetail>(
      sql`SELECT s.*, u.discord_username, u.reddit_username, t.title as task_title
          FROM submissions s
          LEFT JOIN users u ON u.id = s.user_id
          LEFT JOIN tasks t ON t.id = s.task_id
          WHERE s.id = ${singleId} LIMIT 1`
    );
    const sub = subRows.rows[0]!;
    const unixSubmitted = Math.floor(new Date(sub.submitted_at).getTime() / 1000);

    const payoutStatus = sub.moved_to_available === 1
      ? `Paid ✅ (on ${formatDiscordTime(sub.paid_at)})`
      : sub.available_at
        ? `Unpaid ⏳ (Releases ${formatDiscordTime(sub.available_at, "R")})`
        : "Unpaid ⏳";

    const embed = makeEmbed(COLORS.PRIMARY)
      .setTitle(`🔍 Submission #${sub.id} Details`)
      .addFields(
        { name: "Worker", value: `<@${sub.discord_id}> (${sub.discord_username})`, inline: true },
        { name: "Reddit User", value: sub.reddit_username ? `[u/${sub.reddit_username}](https://reddit.com/u/${sub.reddit_username})` : "—", inline: true },
        { name: "Task", value: `#${sub.task_id} — ${sub.task_title}`, inline: false },
        { name: "Reward", value: formatMoney(sub.reward), inline: true },
        { name: "Review Status", value: getStatusLabel(sub.review_status, sub.moved_to_available), inline: true },
        { name: "Live Status", value: liveEmoji[sub.live_status] ?? sub.live_status, inline: true },
        { name: "Proof Link", value: `[Open Proof Link](${sub.proof_link})`, inline: false },
        { name: "Submitted At", value: `<t:${unixSubmitted}:F> (<t:${unixSubmitted}:R>)`, inline: false }
      );

    if (sub.reviewer_discord_id) {
      const reviewerValue = sub.reviewer_discord_id === "system"
        ? "🤖 System (Auto-validated)"
        : sub.reviewer_discord_id.startsWith("dashboard:")
          ? `Dashboard User: **${sub.reviewer_discord_id.replace("dashboard:", "")}**`
          : `<@${sub.reviewer_discord_id}>`;
      embed.addFields(
        { name: "Reviewed By", value: reviewerValue, inline: true },
        { name: "Reviewed At", value: formatDiscordTime(sub.reviewed_at), inline: true }
      );
    }

    if (sub.review_reason) {
      embed.addFields({ name: "Review/Verdict Reason", value: sub.review_reason, inline: false });
    }

    if (sub.removal_reason) {
      embed.addFields({ name: "Reddit Removal Reason", value: sub.removal_reason, inline: false });
    }

    embed.addFields({ name: "Payout Status", value: payoutStatus, inline: false });

    if (sub.screenshot_url) {
      embed.setImage(sub.screenshot_url);
    }

    embed.setFooter({ text: `Requested by ${interaction.user.tag} • ${new Date().toUTCString()}` });

    return interaction.editReply({ embeds: [embed] });
  }

  // Otherwise, render a list with a select menu.
  const listLines = rows.rows.map((r) => {
    const timeAgo = formatDiscordTime(r.submitted_at, "R");
    const status = getStatusLabel(r.review_status, r.moved_to_available);
    const workerText = r.discord_username ? ` by **@${r.discord_username}**` : "";
    return `**#${r.id}** | **${formatMoney(r.reward)}** | ${status} | *${r.task_title}*${workerText} (${timeAgo})`;
  });

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(targetUser ? `📋 Submissions — ${targetUser.username}` : "📋 Latest Pending Submissions")
    .setDescription(
      (targetUser ? `Showing up to 10 recent submissions for <@${targetUser.id}>.\n\n` : "Showing up to 10 latest pending submissions requiring review.\n\n") +
      listLines.join("\n")
    )
    .setFooter({ text: `Requested by ${interaction.user.tag} • ${new Date().toUTCString()}` });

  const selectOptions = rows.rows.map((r) => {
    const status = getStatusLabel(r.review_status, r.moved_to_available);
    return {
      label: `Inspect #${r.id} (${formatMoney(r.reward)})`,
      value: String(r.id),
      description: `Status: ${status} | Task: ${r.task_title.substring(0, 50)}`,
    };
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("sub:select")
    .setPlaceholder("Select a submission to inspect...")
    .addOptions(selectOptions);

  const rowComponent = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

  return interaction.editReply({ embeds: [embed], components: [rowComponent] });
}

export async function handleSubmissionSelect(interaction: StringSelectMenuInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  const actingMember = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(actingMember, guild) && !hasAdminRole(actingMember, guild)) {
    return interaction.followUp({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Mods and Admins can view submission details.")],
      flags: 64,
    });
  }

  const submissionId = parseInt(interaction.values[0]);

  type SubmissionDetail = {
    id: number;
    claim_id: number;
    task_id: number;
    user_id: number;
    discord_id: string;
    proof_link: string;
    screenshot_url: string | null;
    reward: string;
    review_status: string;
    reviewer_discord_id: string | null;
    review_reason: string | null;
    log_message_id: string | null;
    available_at: string | null;
    moved_to_available: number;
    submitted_at: string;
    reviewed_at: string | null;
    live_status: string;
    last_checked_at: string | null;
    removal_reason: string | null;
    live_status_changed_at: string | null;
    paid_at: string | null;
    proof_verified_via: string | null;
    discord_username: string;
    reddit_username: string | null;
    task_title: string;
  };

  const rows = await db.execute<SubmissionDetail>(
    sql`SELECT s.*, u.discord_username, u.reddit_username, t.title as task_title
        FROM submissions s
        LEFT JOIN users u ON u.id = s.user_id
        LEFT JOIN tasks t ON t.id = s.task_id
        WHERE s.id = ${submissionId} LIMIT 1`
  );

  if (rows.rows.length === 0) {
    return interaction.followUp({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Submission **#${submissionId}** not found.`)],
      flags: 64,
    });
  }

  const sub = rows.rows[0]!;
  const unixSubmitted = Math.floor(new Date(sub.submitted_at).getTime() / 1000);

  const formatDiscordTime = (dateStr: string | null, format: "R" | "F" = "F") => {
    if (!dateStr) return "—";
    const unix = Math.floor(new Date(dateStr).getTime() / 1000);
    return `<t:${unix}:${format}>`;
  };

  const getStatusLabel = (status: string, movedToAvailable: number) => {
    if (status === "accepted") {
      return movedToAvailable === 1 ? "✅ Accepted" : "⏱️ Accepted (Hold)";
    }
    if (status === "pending_hold") return "⏱️ Pending Hold";
    if (status === "pending") return "⏳ Pending";
    if (status === "rejected") return "❌ Rejected";
    if (status === "flagged") return "🚩 Flagged";
    return status;
  };

  const liveEmoji: Record<string, string> = {
    live: "✅ Live",
    removed: "🛡️ Removed",
    deleted: "🗑️ Deleted",
    unknown: "❔ Unknown",
  };

  const payoutStatus = sub.moved_to_available === 1
    ? `Paid ✅ (on ${formatDiscordTime(sub.paid_at)})`
    : sub.available_at
      ? `Unpaid ⏳ (Releases ${formatDiscordTime(sub.available_at, "R")})`
      : "Unpaid ⏳";

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(`🔍 Submission #${sub.id} Details`)
    .addFields(
      { name: "Worker", value: `<@${sub.discord_id}> (${sub.discord_username})`, inline: true },
      { name: "Reddit User", value: sub.reddit_username ? `[u/${sub.reddit_username}](https://reddit.com/u/${sub.reddit_username})` : "—", inline: true },
      { name: "Task", value: `#${sub.task_id} — ${sub.task_title}`, inline: false },
      { name: "Reward", value: formatMoney(sub.reward), inline: true },
      { name: "Review Status", value: getStatusLabel(sub.review_status, sub.moved_to_available), inline: true },
      { name: "Live Status", value: liveEmoji[sub.live_status] ?? sub.live_status, inline: true },
      { name: "Proof Link", value: `[Open Proof Link](${sub.proof_link})`, inline: false },
      { name: "Submitted At", value: `<t:${unixSubmitted}:F> (<t:${unixSubmitted}:R>)`, inline: false }
    );

  if (sub.reviewer_discord_id) {
    const reviewerValue = sub.reviewer_discord_id === "system"
      ? "🤖 System (Auto-validated)"
      : sub.reviewer_discord_id.startsWith("dashboard:")
        ? `Dashboard User: **${sub.reviewer_discord_id.replace("dashboard:", "")}**`
        : `<@${sub.reviewer_discord_id}>`;
    embed.addFields(
      { name: "Reviewed By", value: reviewerValue, inline: true },
      { name: "Reviewed At", value: formatDiscordTime(sub.reviewed_at), inline: true }
    );
  }

  if (sub.review_reason) {
    embed.addFields({ name: "Review/Verdict Reason", value: sub.review_reason, inline: false });
  }

  if (sub.removal_reason) {
    embed.addFields({ name: "Reddit Removal Reason", value: sub.removal_reason, inline: false });
  }

  embed.addFields({ name: "Payout Status", value: payoutStatus, inline: false });

  if (sub.screenshot_url) {
    embed.setImage(sub.screenshot_url);
  }

  embed.setFooter({ text: `Requested by ${interaction.user.tag} • ${new Date().toUTCString()}` });

  return interaction.followUp({ embeds: [embed], flags: 64 });
}
