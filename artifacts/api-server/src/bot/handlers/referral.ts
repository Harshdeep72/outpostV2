import {
  type ChatInputCommandInteraction,
} from "discord.js";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { users, referrals } from "@workspace/db";
import { getUserByDiscordId, getUserByReferralCode, upsertUser } from "../db.js";
import { invalidateUser, referralStatsCache } from "../cache.js";
import { makeEmbed, formatMoney } from "../util.js";
import { COLORS, REFERRAL_REWARD } from "../constants.js";
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
      `Share your referral code with friends!\n\nThey must:\n> 1. Join the server\n> 2. Run \`/referraluse ${code}\`\n> 3. Verify their Reddit account\n> 4. Complete at least **1 task**\n\nOnce all 4 steps are done, you earn **+$${REFERRAL_REWARD}** instantly to your available balance.`
    )
    .addFields(
      { name: "🎫 Your Referral Code", value: `\`\`\`${code}\`\`\``, inline: false },
      { name: "📊 Total Referrals", value: String(stats.count), inline: true },
      { name: "✅ Completed", value: String(stats.completed), inline: true },
      { name: "⏳ Pending", value: String(stats.pending), inline: true },
      { name: "💵 Referral Earnings", value: formatMoney(earnings), inline: true },
    )
    .setFooter({ text: "Friends use /referraluse <code> before verifying." });

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
          `Code \`${code}\` applied — referrer: **${referrer.discordUsername}**\n\nNow verify your Reddit account with \`/verify\` and complete your first task to unlock the referral reward for them.`
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

function generateReferralCode(): string {
  return Math.random().toString(36).substring(2, 6).toUpperCase() +
    Math.random().toString(36).substring(2, 6).toUpperCase();
}
