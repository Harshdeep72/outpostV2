import {
  type ChatInputCommandInteraction,
} from "discord.js";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { users, referrals } from "@workspace/db";
import { getUserByDiscordId, getUserByReferralCode, upsertUser } from "../db.js";
import { invalidateUser, referralStatsCache } from "../cache.js";
import { makeEmbed, formatMoney } from "../util.js";
import { COLORS, REFERRAL_REWARD, REFERRAL_REWARD_REFERRER, REFERRAL_REWARD_REFERRED, CHANNELS } from "../constants.js";
import { logger } from "../../lib/logger.js";

export async function handleReferralCommand(interaction: ChatInputCommandInteraction) {
  // Public — visible to everyone in the channel.
  await interaction.deferReply();

  let user = await upsertUser(interaction.user.id, interaction.user.username);

  if (!user.referralCode) {
    const code = generateReferralCode();
    await db.update(users).set({ referralCode: code }).where(eq(users.discordId, interaction.user.id));
    invalidateUser(interaction.user.id, user.id);
    user = { ...user, referralCode: code };
  }

  let stats = referralStatsCache.get(interaction.user.id);
  if (!stats) {
    const combined = await db.execute<{ count: string; completed: string; pending: string }>(
      sql`SELECT
            COUNT(*)::text as count,
            COUNT(*) FILTER (WHERE status = 'completed')::text as completed,
            COUNT(*) FILTER (WHERE status != 'completed')::text as pending
          FROM referrals
          WHERE referrer_discord_id = ${interaction.user.id}`
    );
    const row = combined.rows[0] ?? { count: "0", completed: "0", pending: "0" };
    stats = {
      count: parseInt(row.count),
      completed: parseInt(row.completed),
      pending: parseInt(row.pending),
    };
    referralStatsCache.set(interaction.user.id, stats);
  }

  const code = user.referralCode!;
  const earnings = user.referralEarnings ?? "0";

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle("🔗 Your Referral Info")
    .setDescription(
      `Share your referral code with friends!\n\n` +
      `**How it works:**\n` +
      `> 1. Your friend joins and applies your code with \`/referraluse\` or during \`/verify\`\n` +
      `> 2. They complete their first task and get it approved\n` +
      `> 3. **You get +$${REFERRAL_REWARD_REFERRER}** and **they get +$${REFERRAL_REWARD_REFERRED}** added directly to available balance!`
    )
    .addFields(
      { name: "🎫 Your Referral Code", value: `\`\`\`${code}\`\`\``, inline: false },
      { name: "📊 Total Referrals", value: String(stats.count), inline: true },
      { name: "✅ Completed", value: String(stats.completed), inline: true },
      { name: "⏳ Pending", value: String(stats.pending), inline: true },
      { name: "💵 Referral Earnings", value: formatMoney(earnings), inline: true },
    );

  await interaction.editReply({ embeds: [embed] });
}

export async function handleReferralUseCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const code = interaction.options.getString("code", true).trim().toUpperCase();
  const discordId = interaction.user.id;

  await upsertUser(discordId, interaction.user.username);
  const self = await getUserByDiscordId(discordId);

  if (self?.verified) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You cannot use a referral code after you are already verified.")],
    });
  }

  if (self?.referredBy) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.WARNING).setDescription("⚠️ You have already applied a referral code.")],
    });
  }

  const referrer = await getUserByReferralCode(code);

  if (!referrer) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Referral code not found. Double-check and try again.")],
    });
  }

  if (referrer.discordId === discordId) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You cannot use your own referral code.")],
    });
  }

  const existingRef = await db.select().from(referrals)
    .where(eq(referrals.referredDiscordId, discordId))
    .limit(1);

  if (existingRef.length > 0) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.WARNING).setDescription("⚠️ A referral is already recorded for your account.")],
    });
  }

  await db.update(users).set({ referredBy: referrer.discordId }).where(eq(users.discordId, discordId));
  invalidateUser(discordId);
  await db.insert(referrals).values({
    referrerDiscordId: referrer.discordId,
    referredDiscordId: discordId,
    codeUsed: code,
    status: "pending",
  });
  referralStatsCache.delete(referrer.discordId);

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ Referral Code Applied!")
        .setDescription(
          `Code \`${code}\` applied — referrer: **${referrer.discordUsername}**\n\n` +
          `Now complete your first task! Once your task is approved:\n` +
          `• You will receive a **+$${REFERRAL_REWARD_REFERRED}** welcome bonus\n` +
          `• Your referrer will receive a **+$${REFERRAL_REWARD_REFERRER}** bonus\n` +
          `Both bonuses are credited directly to available balance.`
        ),
    ],
  });

  logger.info({ discordId, referrerDiscordId: referrer.discordId, code }, "Referral code used");
}

export async function markReferralVerified(discordId: string): Promise<void> {
  const ref = await db.select().from(referrals)
    .where(eq(referrals.referredDiscordId, discordId))
    .limit(1);

  if (ref.length > 0 && ref[0]!.status === "pending") {
    await db.update(referrals).set({ status: "verified" }).where(eq(referrals.id, ref[0]!.id));
    referralStatsCache.delete(ref[0]!.referrerDiscordId);
    logger.info({ discordId }, "Referral marked verified");
  }
}

export async function notifyReferralCompletion(
  clientOrGuild: any,
  result: {
    completed: boolean;
    referrerDiscordId?: string;
    referredDiscordId?: string;
    referrerReward?: string;
    referredReward?: string;
  }
): Promise<void> {
  if (!result.completed || !result.referrerDiscordId || !result.referredDiscordId) return;

  const referrerReward = result.referrerReward ?? REFERRAL_REWARD_REFERRER;
  const referredReward = result.referredReward ?? REFERRAL_REWARD_REFERRED;

  let client: any = null;
  let guild: any = null;

  if (clientOrGuild) {
    if ("client" in clientOrGuild && clientOrGuild.client) {
      guild = clientOrGuild;
      client = clientOrGuild.client;
    } else {
      client = clientOrGuild;
      guild = client.guilds?.cache?.first?.() ?? null;
    }
  }

  // 1. DM Referrer
  try {
    const referrerUser = await client?.users?.fetch(result.referrerDiscordId).catch(() => null);
    if (referrerUser) {
      const dmEmbed = makeEmbed(COLORS.SUCCESS)
        .setTitle("🎉 Referral Bonus Earned!")
        .setDescription(
          `One of your invited members (<@${result.referredDiscordId}>) just successfully completed their first task!\n\n` +
          `**+$${referrerReward}** has been credited to your available balance.`
        );
      await referrerUser.send({ embeds: [dmEmbed] }).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, referrerDiscordId: result.referrerDiscordId }, "Failed to DM referrer on completion");
  }

  // 2. DM Referred Member (new member)
  try {
    const referredUser = await client?.users?.fetch(result.referredDiscordId).catch(() => null);
    if (referredUser) {
      const dmEmbed = makeEmbed(COLORS.SUCCESS)
        .setTitle("🎁 Welcome Referral Bonus!")
        .setDescription(
          `Congratulations on completing your first approved task!\n\n` +
          `As a welcome bonus for being invited by a friend, **+$${referredReward}** has been added to your available balance.`
        );
      await referredUser.send({ embeds: [dmEmbed] }).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, referredDiscordId: result.referredDiscordId }, "Failed to DM referred member on completion");
  }

  // 3. Post to #referral-events channel if available
  try {
    let eventsChannel: any = null;
    if (guild?.channels?.cache) {
      eventsChannel = guild.channels.cache.find((c: any) => c.name === CHANNELS.REFERRAL_EVENTS);
    }
    if (!eventsChannel && client?.channels?.cache) {
      eventsChannel = client.channels.cache.find((c: any) => c.name === CHANNELS.REFERRAL_EVENTS);
    }
    if (eventsChannel && "send" in eventsChannel) {
      const eventEmbed = makeEmbed(COLORS.SUCCESS)
        .setTitle("🎉 Referral Milestone Completed!")
        .setDescription(
          `<@${result.referrerDiscordId}> referred <@${result.referredDiscordId}>, who just completed their first approved task!\n\n` +
          `• Inviter earned: **+$${referrerReward}**\n` +
          `• New member earned: **+$${referredReward}**\n\n` +
          `Invite your friends using \`/referral\` to earn bonus cash!`
        )
        .setTimestamp();
      await eventsChannel.send({ embeds: [eventEmbed] }).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err }, "Failed to post to referral-events channel");
  }
}

function generateReferralCode(): string {
  return Math.random().toString(36).substring(2, 6).toUpperCase() +
    Math.random().toString(36).substring(2, 6).toUpperCase();
}
