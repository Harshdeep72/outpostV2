import {
  type Guild,
  type GuildMember,
  type TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { setupGuild } from "../setup.js";
import { upsertUserSmart } from "../db.js";
import { pool } from "@workspace/db";
import { makeEmbed, hasAdminRole, hasModRole } from "../util.js";
import {
  COLORS,
  REFERRAL_TIER1_REWARD,
  REFERRAL_TIER1_MIN_KARMA,
  REFERRAL_TIER1_MIN_AGE_DAYS,
  REFERRAL_TIER2_REWARD,
  REFERRAL_TIER2_MIN_KARMA,
  REFERRAL_TIER2_MIN_AGE_DAYS,
} from "../constants.js";
import { logger } from "../../lib/logger.js";
import { trackMemberJoin, autoApplyReferralOnJoin } from "../inviteTracker.js";

// Process-local memory set to quickly debounce duplicate gateway events
const localWelcomedCache = new Map<string, number>();
const LOCAL_CACHE_TTL_MS = 60_000; // 1 minute

export function buildJoinerGuideEmbed(guild: Guild, _member?: GuildMember): EmbedBuilder {
  const description = [
    "**What this server is:**",
    "We connect Reddit users with quick, paid community marketing microtasks. We provide active Reddit threads and brief instructions—you leave a natural, relevant comment from your Reddit account, submit the link, and earn daily cash.",
    "",
    "💵 **Reward:** $1.00 per verified live comment",
    "💳 **Payout Options:** UPI, PayPal, GCash, or Crypto (USDT)",
    "",
    "🚀 **How to start earning right now:**",
    "",
    "1️⃣ **Link your Reddit:** Go to <#1565661337420308510> and click **Verify Me** to unlock tasks and your personal workspace channel.",
    "2️⃣ **Set your payout details:** Run `/setupi`, `/setpaypal`, `/setgcash`, or `/setwallet`.",
    "3️⃣ **Claim & Earn:** Check <#1565661343737192531>, click **Claim**, post your comment following the prompt, and submit your link!"
  ].join("\n");

  return makeEmbed(COLORS.PRIMARY)
    .setTitle("👋 Welcome to Reddit Microtasks!")
    .setDescription(description)
    .setFooter({ text: `${guild.name} • Start earning today!` })
    .setTimestamp();
}

export function buildJoinerGuideButtons(
  guild: Guild,
  tasksChannelId?: string,
  guideChannelId?: string
): ActionRowBuilder<ButtonBuilder> {
  const buttons: ButtonBuilder[] = [
    new ButtonBuilder()
      .setCustomId("verify:start")
      .setLabel("✅ Verify Reddit Account")
      .setStyle(ButtonStyle.Success),
  ];

  if (tasksChannelId) {
    buttons.push(
      new ButtonBuilder()
        .setLabel("📋 Open Tasks")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${guild.id}/${tasksChannelId}`)
    );
  }

  if (guideChannelId) {
    buttons.push(
      new ButtonBuilder()
        .setLabel("📖 Full Guide")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/channels/${guild.id}/${guideChannelId}`)
    );
  }

  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

export async function handleGuildMemberAdd(member: GuildMember) {
  if (member.user.bot) return;

  const now = Date.now();
  const cachedTime = localWelcomedCache.get(member.id);
  if (cachedTime && now - cachedTime < LOCAL_CACHE_TTL_MS) {
    logger.debug({ userId: member.id }, "Skipping duplicate welcome (in-memory debounce)");
    return;
  }
  localWelcomedCache.set(member.id, now);

  upsertUserSmart(member.id, member.user.username).catch((err) => {
    logger.warn({ err, userId: member.id }, "Failed to upsert new member");
  });

  // Always ensure Unverified role on join for new members
  try {
    const guild = member.guild;
    const setup = await setupGuild(guild);

    if (
      setup.unverifiedRole &&
      !member.roles.cache.has(setup.verifiedRole.id) &&
      !member.roles.cache.has(setup.unverifiedRole.id)
    ) {
      await member.roles.add(setup.unverifiedRole, "Auto-assign Unverified role on join").catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, userId: member.id }, "Failed auto-assigning initial roles on join");
  }

  // 0. Automatically track invite & apply referral if joined through a member's link
  let autoReferredBy: string | undefined;
  try {
    const inviteInfo = await trackMemberJoin(member);
    if (inviteInfo?.referrerDiscordId) {
      const applied = await autoApplyReferralOnJoin(member, inviteInfo.referrerDiscordId, inviteInfo.inviteCode);
      if (applied) {
        autoReferredBy = inviteInfo.referrerDiscordId;
      }
    }
  } catch (invErr) {
    logger.warn({ err: invErr, userId: member.id }, "Failed tracking joiner invite");
  }

  // Cross-instance / cluster deduplication:
  // Atomically claim the welcome event in PostgreSQL. If another instance or
  // event already welcomed this user in the last 24 hours, rowCount is 0.
  try {
    const claimRes = await pool.query(
      `INSERT INTO member_welcomes (discord_id, welcomed_at)
       VALUES ($1, NOW())
       ON CONFLICT (discord_id) DO UPDATE
         SET welcomed_at = NOW()
         WHERE member_welcomes.welcomed_at < NOW() - INTERVAL '1 day'
       RETURNING discord_id`,
      [member.id]
    );

    if (claimRes.rowCount === 0) {
      logger.info({ userId: member.id }, "Member already welcomed recently — skipping duplicate welcome message");
      return;
    }
  } catch (dbErr) {
    logger.warn({ err: dbErr, userId: member.id }, "Failed to query member_welcomes dedup table");
    // Continue gracefully if DB table check throws
  }

  try {
    const guild = member.guild;
    const setup = await setupGuild(guild);

    const embed = buildJoinerGuideEmbed(guild, member);
    const row = buildJoinerGuideButtons(guild, setup.tasksChannel?.id, setup.guideChannel?.id);

    // 1. Send Direct Message to the new member (fails gracefully if user has DMs closed)
    await member.send({
      content: `👋 Welcome to **${guild.name}**! Here is your quick start guide:`,
      embeds: [embed],
    }).catch(() => {
      logger.debug({ userId: member.id }, "Could not DM new joiner (DMs closed)");
    });

    // 2. Post welcome message in the server welcome / start-here channel
    const welcomeChannel = (guild.channels.cache.find(
      (c) => c.isTextBased() && (c.name === "welcome" || c.name === "start-here" || c.name === "chat-area" || c.name === "general")
    ) as TextChannel | undefined) ?? setup.startHereChannel ?? setup.generalChannel;

    if (welcomeChannel) {
      const welcomeContent = autoReferredBy
        ? `👋 Welcome <@${member.id}> to **${guild.name}**! *(Invited by <@${autoReferredBy}> — referral code linked automatically!)* Check out your quick start guide below:`
        : `👋 Welcome <@${member.id}> to **${guild.name}**! Check out your quick start guide below:`;

      await welcomeChannel.send({
        content: welcomeContent,
        embeds: [embed],
        components: [row],
      });
    }
  } catch (err) {
    logger.error({ err, userId: member.id, guildId: member.guild.id }, "Error handling guildMemberAdd joiner guide");
  }
}

export async function handleJoinerGuideCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });
  const guild = interaction.guild!;
  const member = await guild.members.fetch(interaction.user.id);
  if (!hasAdminRole(member, guild) && !hasModRole(member, guild)) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can use this command.")],
    });
  }

  const targetChannelOption = interaction.options.getChannel("channel");
  const targetChannel = (targetChannelOption as TextChannel) || (interaction.channel as TextChannel);

  const setup = await setupGuild(guild);
  const embed = buildJoinerGuideEmbed(guild);
  const row = buildJoinerGuideButtons(guild, setup.tasksChannel?.id, setup.guideChannel?.id);

  await targetChannel.send({
    embeds: [embed],
    components: [row],
  });

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ Joiner guide posted in <#${targetChannel.id}>!`)],
  });
}
