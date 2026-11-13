import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type Guild,
  type GuildMember,
  type Role,
} from "discord.js";
import { makeEmbed, hasModRole } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";

export interface CommunityFlair {
  id: string;
  name: string;
  roleName: string;
  emoji: string;
  description: string;
  color: number;
}

export const COMMUNITY_FLAIRS: CommunityFlair[] = [
  {
    id: "speed_demon",
    name: "Speed Demon",
    roleName: "⚡ Speed Demon",
    emoji: "⚡",
    description: "Submits verified proof at lightning speed",
    color: 0xf1c40f, // Gold
  },
  {
    id: "night_owl",
    name: "Night Owl",
    roleName: "🦉 Night Owl",
    emoji: "🦉",
    description: "Grinding microtasks in the late night hours",
    color: 0x9b59b6, // Amethyst Purple
  },
  {
    id: "caffeine",
    name: "Caffeine Powered",
    roleName: "☕ Caffeine Powered",
    emoji: "☕",
    description: "Fueled by coffee and fast notifications",
    color: 0xe67e22, // Warm Orange
  },
  {
    id: "bag_securer",
    name: "Bag Securer",
    roleName: "💰 Bag Securer",
    emoji: "💰",
    description: "Securing every dollar available on the board",
    color: 0x2ecc71, // Emerald Green
  },
  {
    id: "lurker",
    name: "Reddit Lurker",
    roleName: "👀 Reddit Lurker",
    emoji: "👀",
    description: "Quietly watching task drops like a hawk",
    color: 0x607d8b, // Slate Gray
  },
  {
    id: "wordsmith",
    name: "Wordsmith",
    roleName: "✍️ Wordsmith",
    emoji: "✍️",
    description: "High quality comments that never get flagged",
    color: 0x3498db, // Sky Blue
  },
  {
    id: "task_hunter",
    name: "Task Hunter",
    roleName: "🎯 Task Hunter",
    emoji: "🎯",
    description: "Always first in line when campaigns drop",
    color: 0xe74c3c, // Crimson Red
  },
  {
    id: "pizza_funded",
    name: "Pizza Funded",
    roleName: "🍕 Pizza Funded",
    emoji: "🍕",
    description: "Trading microtasks for fresh pizza slices",
    color: 0xf39c12, // Pizza Orange
  },
  {
    id: "to_the_moon",
    name: "To The Moon",
    roleName: "🚀 To The Moon",
    emoji: "🚀",
    description: "Reddit & crypto enthusiast shooting for the moon",
    color: 0x1abc9c, // Turquoise
  },
  {
    id: "antiban",
    name: "Anti-Ban Specialist",
    roleName: "🛡️ Anti-Ban Specialist",
    emoji: "🛡️",
    description: "Master of the 5-6 min rule & account longevity",
    color: 0x16a085, // Dark Teal
  },
  {
    id: "gamer",
    name: "Gamer On Shift",
    roleName: "🎮 Gamer On Shift",
    emoji: "🎮",
    description: "Completing tasks between gaming matches",
    color: 0x8e44ad, // Dark Violet
  },
  {
    id: "not_a_bot",
    name: "Totally Not A Bot",
    roleName: "🤖 Totally Not A Bot",
    emoji: "🤖",
    description: "Beep boop... definitely a 100% human tasker",
    color: 0x95a5a6, // Silver Gray
  },
];

export async function ensureFlairRoles(guild: Guild): Promise<Map<string, Role>> {
  const roleMap = new Map<string, Role>();
  for (const flair of COMMUNITY_FLAIRS) {
    let role = guild.roles.cache.find(
      (r) => r.name.toLowerCase() === flair.roleName.toLowerCase() || r.name.toLowerCase() === flair.name.toLowerCase()
    );
    if (!role) {
      try {
        role = await guild.roles.create({
          name: flair.roleName,
          color: flair.color,
          reason: "Reddit Microtasks community flair auto-create",
          mentionable: false,
          hoist: false,
        });
        const botMember = guild.members.me;
        if (botMember && botMember.roles.highest.position > 1) {
          const targetPos = botMember.roles.highest.position - 1;
          if (role.position < targetPos) {
            await role.setPosition(targetPos).catch(() => {});
          }
        }
        logger.info({ guildId: guild.id, role: flair.roleName }, "Created community flair role");
      } catch (err) {
        logger.warn({ err, flair: flair.roleName }, "Failed to create community flair role");
        continue;
      }
    }
    roleMap.set(flair.id, role);
  }
  return roleMap;
}

export function getMemberFlair(member: GuildMember): CommunityFlair | null {
  for (const flair of COMMUNITY_FLAIRS) {
    const hasRole = member.roles.cache.some(
      (r) => r.name.toLowerCase() === flair.roleName.toLowerCase() || r.name.toLowerCase() === flair.name.toLowerCase()
    );
    if (hasRole) return flair;
  }
  return null;
}

export function getMemberFlairRoleName(member: GuildMember): string | null {
  const flair = getMemberFlair(member);
  return flair ? flair.roleName : null;
}

export function cleanBaseDisplayName(displayName: string): string {
  // Strip existing bracketed flair tag, e.g. "Skylerrr [⚡ Speed Demon]" -> "Skylerrr"
  return displayName.replace(/\s*\[.*?\]\s*$/, "").trim();
}

export function formatNicknameWithFlair(baseName: string, flair: CommunityFlair): string {
  // 1. Try full tag: "Skylerrr [⚡ Speed Demon]"
  const full = `${baseName} [${flair.roleName}]`;
  if (full.length <= 32) return full;

  // 2. Try short name: "Skylerrr [Speed Demon]"
  const withName = `${baseName} [${flair.name}]`;
  if (withName.length <= 32) return withName;

  // 3. Try emoji only: "Skylerrr [⚡]"
  const withEmoji = `${baseName} [${flair.emoji}]`;
  if (withEmoji.length <= 32) return withEmoji;

  // 4. Truncate base name to fit emoji
  const maxBase = Math.max(1, 32 - flair.emoji.length - 3);
  return `${baseName.slice(0, maxBase)} [${flair.emoji}]`;
}

export async function setMemberFlair(
  guild: Guild,
  member: GuildMember,
  flairId: string
): Promise<{ success: boolean; equippedFlair: CommunityFlair | null; nicknameUpdated: boolean; error?: string }> {
  try {
    const roleMap = await ensureFlairRoles(guild);

    const rolesToRemove: string[] = [];
    for (const flair of COMMUNITY_FLAIRS) {
      const r = roleMap.get(flair.id);
      if (r && member.roles.cache.has(r.id)) {
        rolesToRemove.push(r.id);
      }
      const byName = member.roles.cache.find(
        (existing) => existing.name.toLowerCase() === flair.roleName.toLowerCase() || existing.name.toLowerCase() === flair.name.toLowerCase()
      );
      if (byName && !rolesToRemove.includes(byName.id)) {
        rolesToRemove.push(byName.id);
      }
    }

    if (rolesToRemove.length > 0) {
      await member.roles.remove(rolesToRemove, "Switching/removing community flair");
    }

    const baseName = cleanBaseDisplayName(member.displayName || member.user.username);
    let nicknameUpdated = false;

    if (flairId === "none") {
      try {
        const targetNick = baseName === member.user.username ? null : baseName;
        if (member.nickname !== targetNick) {
          await member.setNickname(targetNick, "Removed community flair tag");
          nicknameUpdated = true;
        }
      } catch (err) {
        logger.debug({ err, userId: member.id }, "Could not reset member nickname (non-fatal, e.g. server owner)");
      }
      return { success: true, equippedFlair: null, nicknameUpdated };
    }

    const targetFlair = COMMUNITY_FLAIRS.find((f) => f.id === flairId);
    if (!targetFlair) {
      return { success: false, equippedFlair: null, nicknameUpdated: false, error: "Invalid flair selected" };
    }

    const roleToAssign = roleMap.get(targetFlair.id);
    if (!roleToAssign) {
      return { success: false, equippedFlair: null, nicknameUpdated: false, error: "Could not create or find flair role" };
    }

    await member.roles.add(roleToAssign, "Equipped community flair");

    try {
      const newNick = formatNicknameWithFlair(baseName, targetFlair);
      if (member.nickname !== newNick) {
        await member.setNickname(newNick, "Applied community flair tag");
        nicknameUpdated = true;
      }
    } catch (err) {
      logger.debug({ err, userId: member.id }, "Could not set member nickname (non-fatal, e.g. server owner)");
    }

    return { success: true, equippedFlair: targetFlair, nicknameUpdated };
  } catch (err) {
    logger.warn({ err, userId: member.id, flairId }, "Failed to update member flair");
    return { success: false, equippedFlair: null, nicknameUpdated: false, error: (err as Error).message };
  }
}

export function buildFlairSelectMenu(currentFlairId?: string | null): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId("flair:select")
    .setPlaceholder("🎭 Choose your community flair...")
    .setMinValues(1)
    .setMaxValues(1);

  const options = COMMUNITY_FLAIRS.map((f) => {
    return new StringSelectMenuOptionBuilder()
      .setLabel(f.name)
      .setValue(f.id)
      .setDescription(f.description.slice(0, 100))
      .setEmoji(f.emoji)
      .setDefault(f.id === currentFlairId);
  });

  options.push(
    new StringSelectMenuOptionBuilder()
      .setLabel("None / Remove Flair")
      .setValue("none")
      .setDescription("Remove your equipped community flair")
      .setEmoji("❌")
      .setDefault(currentFlairId === "none" || !currentFlairId)
  );

  menu.addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buildFlairPickerEmbed(currentFlair?: CommunityFlair | null) {
  const currentText = currentFlair
    ? `**Currently equipped:** ${currentFlair.roleName}`
    : `**Currently equipped:** *None*`;

  return makeEmbed(COLORS.PRIMARY)
    .setTitle("🎭 Reddit-Style Community Flairs")
    .setDescription(
      `Show off your style in the server! Equipping a flair gives you a colored name and custom **[Flair Tag]** right in chat, plus a neon glowing badge on your \`/profile\` card.\n\n` +
      `${currentText}\n\n` +
      `**How it works:**\n` +
      `• Select a flair from the menu below to equip it.\n` +
      `• Your chat name will be tagged (e.g. \`Name [${currentFlair?.roleName ?? "⚡ Speed Demon"}]\`).\n` +
      `• You can only equip **1 flair** at a time.\n` +
      `• Select **None / Remove Flair** anytime to clear it.`
    )
    .addFields({
      name: "📋 Available Flairs",
      value: COMMUNITY_FLAIRS.map((f) => `${f.emoji} **${f.name}** — *${f.description}*`).join("\n"),
    });
}

export async function handleFlairCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ This command can only be used in a server.")],
      flags: 64,
    });
  }

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Could not find your member profile in this server.")],
      flags: 64,
    });
  }

  const currentFlair = getMemberFlair(member);
  const embed = buildFlairPickerEmbed(currentFlair);
  const row = buildFlairSelectMenu(currentFlair?.id);

  return interaction.reply({
    embeds: [embed],
    components: [row],
    flags: 64,
  });
}

export async function handleSendFlairPickerCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ This command can only be used in a server.")],
      flags: 64,
    });
  }

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !hasModRole(member, guild)) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can send the permanent flair picker.")],
      flags: 64,
    });
  }

  const embed = buildFlairPickerEmbed(null);
  const row = buildFlairSelectMenu(null);

  await interaction.reply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription("✅ Community flair picker posted!")],
    flags: 64,
  });

  const channel = interaction.channel;
  if (channel && "send" in channel) {
    await channel.send({
      embeds: [embed],
      components: [row],
    });
  }
}

export async function handleFlairSelect(interaction: StringSelectMenuInteraction) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ This menu can only be used inside the server.")],
      flags: 64,
    });
  }

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Could not resolve your member record.")],
      flags: 64,
    });
  }

  const selectedFlairId = interaction.values[0];
  if (!selectedFlairId) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ No flair selected.")],
      flags: 64,
    });
  }

  await interaction.deferReply({ flags: 64 });

  const result = await setMemberFlair(guild, member, selectedFlairId);

  if (!result.success) {
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.DANGER)
          .setTitle("❌ Failed to Update Flair")
          .setDescription(`Could not update your flair: ${result.error ?? "Unknown error"}`),
      ],
    });
  }

  if (result.equippedFlair) {
    const isOwner = member.id === guild.ownerId;
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.SUCCESS)
          .setTitle("🎭 Community Flair Equipped!")
          .setDescription(
            `You are now rocking the **${result.equippedFlair.roleName}** flair!\n\n` +
            `• **In Chat:** ${result.nicknameUpdated ? `Your nickname is now tagged with **[${result.equippedFlair.roleName}]** in matching role color!` : "Tagged with your custom role color!"}\n` +
            `• **On Profile:** Neon glowing badge on \`/profile\`\n` +
            (isOwner
              ? `\n*(Note: Discord does not permit bots to edit the Server Owner's nickname directly — you can set your nickname to \`YourName [${result.equippedFlair.roleName}]\` manually in Server Profile!)*\n`
              : "") +
            `• Run \`/flair\` anytime if you want to switch or remove it.`
          ),
      ],
    });
  }

  return interaction.editReply({
    embeds: [
      makeEmbed(COLORS.MUTED)
        .setTitle("🎭 Flair Removed")
        .setDescription("Your community flair role has been removed. You can equip a new one anytime with `/flair`."),
    ],
  });
}
