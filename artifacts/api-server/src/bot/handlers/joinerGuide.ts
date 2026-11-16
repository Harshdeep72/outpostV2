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
import { setupGuild, getOrCreateWorkspaceChannel } from "../setup.js";
import { upsertUserSmart, getUserByDiscordId } from "../db.js";
import { pool, db, users, redditAccounts } from "@workspace/db";
import { eq } from "drizzle-orm";
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

  // Check if member is a returning verified user
  let isReturningVerified = false;
  let workspaceChannel: TextChannel | null = null;
  try {
    const guild = member.guild;
    const setup = await setupGuild(guild);
    const existingUser = await getUserByDiscordId(member.id);

    if (existingUser?.verified) {
      isReturningVerified = true;
      logger.info({ userId: member.id, username: member.user.username }, "Returning verified member detected, restoring verified status");

      // 1. Assign Verified role and strip Unverified role if present
      if (setup.verifiedRole && !member.roles.cache.has(setup.verifiedRole.id)) {
        await member.roles.add(setup.verifiedRole, "Restoring Verified role for returning member").catch((err) => {
          logger.warn({ err, userId: member.id }, "Failed adding verified role on rejoin");
        });
      }
      if (setup.unverifiedRole && member.roles.cache.has(setup.unverifiedRole.id)) {
        await member.roles.remove(setup.unverifiedRole, "Removing Unverified role for returning member").catch(() => {});
      }

      // 2. Restore karma roles if applicable
      try {
        const karmaAccounts = await db.select().from(redditAccounts).where(eq(redditAccounts.discordId, member.id));
        let maxKarma = 0;
        for (const acct of karmaAccounts) {
          const total = (acct.postKarma || 0) + (acct.commentKarma || 0);
          if (total > maxKarma) maxKarma = total;
        }
        if (maxKarma >= 10000) {
          if (setup.karma10kRole && !member.roles.cache.has(setup.karma10kRole.id)) {
            await member.roles.add(setup.karma10kRole).catch(() => {});
          }
          if (setup.karma5kRole && !member.roles.cache.has(setup.karma5kRole.id)) {
            await member.roles.add(setup.karma5kRole).catch(() => {});
          }
        } else if (maxKarma >= 5000) {
          if (setup.karma5kRole && !member.roles.cache.has(setup.karma5kRole.id)) {
            await member.roles.add(setup.karma5kRole).catch(() => {});
          }
        }
      } catch (kErr) {
        logger.warn({ err: kErr, userId: member.id }, "Failed restoring karma roles on rejoin");
      }

      // 3. Restore workspace channel & permissions
      if (existingUser.workspaceChannelId) {
        workspaceChannel = (await guild.channels.fetch(existingUser.workspaceChannelId).catch(() => null)) as TextChannel | null;
      }

      if (!workspaceChannel) {
        workspaceChannel = await getOrCreateWorkspaceChannel(guild, member).catch(() => null);
        if (workspaceChannel && workspaceChannel.id !== existingUser.workspaceChannelId) {
          await db.update(users).set({ workspaceChannelId: workspaceChannel.id }).where(eq(users.discordId, member.id)).catch(() => {});
        }
      } else {
        await workspaceChannel.permissionOverwrites.edit(member.id, {
          ViewChannel: true,
          SendMessages: true,
          AttachFiles: true,
          EmbedLinks: true,
          ReadMessageHistory: true,
        }, { reason: `Restoring workspace permissions for returning member ${member.user.username}` }).catch((e) => {
          logger.warn({ err: e, channelId: workspaceChannel!.id, userId: member.id }, "Failed restoring workspace channel overwrites on rejoin");
        });
      }
    } else {
      // New or unverified member: assign Unverified role
      if (
        setup.unverifiedRole &&
        !member.roles.cache.has(setup.verifiedRole.id) &&
        !member.roles.cache.has(setup.unverifiedRole.id)
      ) {
        await member.roles.add(setup.unverifiedRole, "Auto-assign Unverified role on join").catch(() => {});
      }
    }
  } catch (err) {
    logger.warn({ err, userId: member.id }, "Failed auto-assigning initial roles or restoring status on join");
  }

  // Handle returning verified member notification and exit early
  if (isReturningVerified) {
    try {
      const guild = member.guild;
      const setup = await setupGuild(guild);

      // DM returning member
      await member.send({
        embeds: [
          makeEmbed(COLORS.SUCCESS)
            .setTitle(`👋 Welcome back to ${guild.name}!`)
            .setDescription(
              `Your **Verified** status and private workspace have been automatically restored!\n\n` +
              (workspaceChannel ? `📂 **Your Workspace:** <#${workspaceChannel.id}>\n` : "") +
              (setup.tasksChannel ? `📋 **Active Tasks:** <#${setup.tasksChannel.id}>\n\n` : "\n") +
              `Head over to your workspace or check active tasks to continue earning.`
            ),
        ],
      }).catch(() => {
        logger.debug({ userId: member.id }, "Could not DM returning member (DMs closed)");
      });

      // Post welcome message in workspace channel
      if (workspaceChannel) {
        await workspaceChannel.send({
          embeds: [
            makeEmbed(COLORS.SUCCESS)
              .setTitle("👋 Welcome back!")
              .setDescription(
                `Hey <@${member.id}>! You've rejoined **${guild.name}**.\n\n` +
                `Your verified status and workspace have been automatically restored. Check ${setup.tasksChannel ? `<#${setup.tasksChannel.id}>` : "tasks"} to claim tasks and keep earning!`
              ),
          ],
        }).catch(() => {});
      }

      // Welcome message in public welcome/start-here channel
      const welcomeChannel = (guild.channels.cache.find(
        (c) => c.isTextBased() && (c.name === "welcome" || c.name === "start-here" || c.name === "chat-area" || c.name === "general")
      ) as TextChannel | undefined) ?? setup.startHereChannel ?? setup.generalChannel;

      if (welcomeChannel) {
        await welcomeChannel.send({
          content: `👋 Welcome back <@${member.id}> to **${guild.name}**! Your verified status has been automatically restored. ${workspaceChannel ? `Check your workspace: <#${workspaceChannel.id}>` : ""}`,
        }).catch(() => {});
      }
    } catch (err) {
      logger.warn({ err, userId: member.id }, "Failed sending returning member welcome notices");
    }
    return;
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
