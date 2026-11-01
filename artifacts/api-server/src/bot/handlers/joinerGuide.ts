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
import { makeEmbed, hasAdminRole, hasModRole } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";

export function buildJoinerGuideEmbed(guild: Guild, _member?: GuildMember): EmbedBuilder {
  return makeEmbed(COLORS.PRIMARY)
    .setTitle(`🚀 Welcome to ${guild.name} — Quick Start Guide`)
    .setDescription(
      `Earn real money by completing simple Reddit tasks (comments and posts)!\n` +
      `Follow these **3 simple steps** to get started and receive your first payout:`
    )
    .addFields(
      {
        name: "1️⃣ Step 1: Link & Verify Your Reddit Account",
        value:
          "Click the **✅ Verify Reddit Account** button below (or run `/verify`).\n" +
          "Enter your Reddit username or profile link. Once approved, you get the **Verified Earner** role.",
      },
      {
        name: "2️⃣ Step 2: Claim Tasks in #tasks",
        value:
          "Watch the `#tasks` channel for new task drops.\n" +
          "When an open task appears, click **Claim Task**.\n" +
          "A private workspace ticket channel (`#workspace-username`) will open for you with the exact Reddit link, post script, and timer.",
      },
      {
        name: "3️⃣ Step 3: Complete & Submit Proof",
        value:
          "Post your comment on Reddit using your verified account, copy your comment link, and click **Submit Proof** in your private channel.\n" +
          "Once verified, rewards go into your pending hold and clear after the hold period.",
      },
      {
        name: "💳 Payout Methods (UPI & PayPal Only)",
        value:
          "We support payouts via **UPI** and **PayPal** only.\n" +
          "Set up your payment details with `/setupi` (for UPI) or `/setpaypal` (for PayPal).\n" +
          "Check your balance and payout status anytime with `/wallet`.",
      },
      {
        name: "🎁 Earn +$0.40 Per Referral",
        value:
          "Run `/referral` to get your personal invite code. Share it with friends to earn bonus cash for every referral who completes a task!",
      }
    )
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

  upsertUserSmart(member.id, member.user.username).catch((err) => {
    logger.warn({ err, userId: member.id }, "Failed to upsert new member");
  });

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
      await welcomeChannel.send({
        content: `👋 Welcome <@${member.id}> to **${guild.name}**! Check out your quick start guide below:`,
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
