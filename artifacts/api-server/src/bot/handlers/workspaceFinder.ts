import {
  type ChatInputCommandInteraction,
  type UserContextMenuCommandInteraction,
  type AutocompleteInteraction,
  type ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type TextChannel,
  ChannelType,
} from "discord.js";
import { sql } from "drizzle-orm";
import { db, users, claims, tasks } from "@workspace/db";
import { getUserByDiscordId } from "../db.js";
import { getOrCreateWorkspaceChannel, setupGuild } from "../setup.js";
import { makeEmbed, formatMoney, hasModRole } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";

/**
 * Handle /workspace and /ws slash command.
 * Allows admins, mods, or workers to instantly find and jump to any user's workspace channel.
 */
export async function handleWorkspaceCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "❌ This command can only be used inside the server.", flags: 64 });
    return;
  }

  await interaction.deferReply({ flags: 64 });

  const isMod = hasModRole(interaction.member as any, guild);

  // 1. Resolve target user
  const targetUserOpt = interaction.options.getUser("user");
  const workerSearch = interaction.options.getString("worker")?.trim();
  const redditSearch = interaction.options.getString("reddit")?.trim();

  let targetDiscordId: string | null = null;

  if (targetUserOpt) {
    targetDiscordId = targetUserOpt.id;
  } else if (workerSearch) {
    // If workerSearch is a pure numeric ID (from autocomplete or pasted Discord ID)
    if (/^\d{17,20}$/.test(workerSearch)) {
      targetDiscordId = workerSearch;
    } else {
      // Search in DB by username or reddit username
      const cleanSearch = workerSearch.replace(/^u\//i, "").toLowerCase();
      const match = await db.execute<{ discord_id: string }>(
        sql`SELECT discord_id FROM users
            WHERE LOWER(discord_username) = ${cleanSearch}
               OR LOWER(reddit_username) = ${cleanSearch}
               OR discord_username ILIKE ${"%" + cleanSearch + "%"}
            LIMIT 1`
      );
      if (match.rows[0]?.discord_id) {
        targetDiscordId = match.rows[0].discord_id;
      }
    }
  } else if (redditSearch) {
    const cleanReddit = redditSearch.replace(/^u\//i, "").toLowerCase();
    const match = await db.execute<{ discord_id: string }>(
      sql`SELECT discord_id FROM users WHERE LOWER(reddit_username) = ${cleanReddit} LIMIT 1`
    );
    if (match.rows[0]?.discord_id) {
      targetDiscordId = match.rows[0].discord_id;
    }
  } else {
    // Default to caller
    targetDiscordId = interaction.user.id;
  }

  if (!targetDiscordId) {
    await interaction.editReply({
      embeds: [
        makeEmbed(COLORS.DANGER).setDescription(
          `❌ Could not find a worker matching **\`${workerSearch || redditSearch}\`**.\n\nTry using autocomplete or mentioning them directly with \`/workspace user: @worker\`.`
        ),
      ],
    });
    return;
  }

  // Non-mods can only view their own workspace
  if (!isMod && targetDiscordId !== interaction.user.id) {
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ You can only look up your own workspace channel.")],
    });
    return;
  }

  await respondWithWorkspaceDetails(interaction, guild, targetDiscordId);
}

/**
 * Handle "Open Workspace" User Context Menu command (right click member -> Apps -> Open Workspace).
 */
export async function handleOpenWorkspaceContextMenu(interaction: UserContextMenuCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "❌ This command can only be used inside the server.", flags: 64 });
    return;
  }

  await interaction.deferReply({ flags: 64 });

  const targetDiscordId = interaction.targetUser.id;
  await respondWithWorkspaceDetails(interaction, guild, targetDiscordId);
}

/**
 * Autocomplete handler for the `worker` option in /workspace.
 * Returns up to 25 live matches by Discord username or Reddit username.
 */
export async function handleWorkspaceAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused().trim().toLowerCase();
  const clean = focused.replace(/^u\//i, "");

  try {
    const query = clean.length > 0
      ? sql`SELECT discord_id, discord_username, reddit_username, workspace_channel_id
            FROM users
            WHERE (
              discord_username ILIKE ${"%" + clean + "%"} OR
              reddit_username ILIKE ${"%" + clean + "%"} OR
              discord_id LIKE ${clean + "%"}
            )
            ORDER BY verified DESC, last_task_completed_at DESC NULLS LAST
            LIMIT 25`
      : sql`SELECT discord_id, discord_username, reddit_username, workspace_channel_id
            FROM users
            WHERE workspace_channel_id IS NOT NULL AND workspace_channel_id <> ''
            ORDER BY verified DESC, last_task_completed_at DESC NULLS LAST
            LIMIT 25`;

    const res = await db.execute<{
      discord_id: string;
      discord_username: string;
      reddit_username: string | null;
      workspace_channel_id: string | null;
    }>(query);

    const choices = res.rows.map((r) => {
      const redditPart = r.reddit_username ? `(u/${r.reddit_username})` : "(no reddit)";
      const label = `${r.discord_username || "User"} ${redditPart}`.slice(0, 95);
      return {
        name: label,
        value: r.discord_id,
      };
    });

    await interaction.respond(choices);
  } catch (err) {
    logger.debug({ err }, "Workspace autocomplete failed");
    await interaction.respond([]).catch(() => {});
  }
}

/**
 * Core responder: resolves channel and renders embed with direct Jump to Channel link button.
 */
async function respondWithWorkspaceDetails(
  interaction: ChatInputCommandInteraction | UserContextMenuCommandInteraction,
  guild: any,
  targetDiscordId: string
): Promise<void> {
  const user = await getUserByDiscordId(targetDiscordId);
  const member = await guild.members.fetch(targetDiscordId).catch(() => null);

  const username = member?.user?.username ?? user?.discordUsername ?? `User ${targetDiscordId}`;
  const displayName = member?.displayName ?? (member?.user as any)?.globalName ?? username;
  const avatarUrl = member?.user?.displayAvatarURL?.() ?? null;

  let workspaceChannel: TextChannel | null = null;
  let channelId = user?.workspaceChannelId;

  if (channelId) {
    workspaceChannel = (await guild.channels.fetch(channelId).catch(() => null)) as TextChannel | null;
  }

  // If user has no workspace channel or channel was deleted, try locating or restoring it
  if (!workspaceChannel && member) {
    try {
      workspaceChannel = await getOrCreateWorkspaceChannel(guild, member);
      if (workspaceChannel) {
        channelId = workspaceChannel.id;
        await db.execute(
          sql`UPDATE users SET workspace_channel_id = ${channelId} WHERE discord_id = ${targetDiscordId}`
        ).catch(() => {});
      }
    } catch (err) {
      logger.debug({ err, targetDiscordId }, "Could not auto-restore workspace channel");
    }
  }

  if (!workspaceChannel || !channelId) {
    const embed = makeEmbed(COLORS.WARNING)
      .setTitle(`📂 No Workspace Channel Found for ${displayName}`)
      .setDescription(
        `Worker **<@${targetDiscordId}>** does not have an active workspace channel in this server.\n\n` +
        `• Verification: ${user?.verified ? "✅ Verified" : "⏳ Unverified"}\n` +
        `• Reddit: ${user?.redditUsername ? `[u/${user.redditUsername}](https://www.reddit.com/user/${user.redditUsername})` : "*(none)*"}\n\n` +
        (user?.verified
          ? "They are verified, but their channel may have been deleted manually."
          : "Workspaces are automatically created when a worker completes `/verify`.")
      );

    const row = new ActionRowBuilder<ButtonBuilder>();
    if (member) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ws:create:${targetDiscordId}`)
          .setLabel("🛠️ Create Workspace Channel")
          .setStyle(ButtonStyle.Primary)
      );
      await interaction.editReply({ embeds: [embed], components: [row] });
    } else {
      await interaction.editReply({ embeds: [embed] });
    }
    return;
  }

  // Fetch any active claim
  let activeClaimText = "*(None active)*";
  try {
    const claimRes = await db.execute<{ id: number; task_id: number; expires_at: string | null }>(
      sql`SELECT id, task_id, expires_at FROM claims
          WHERE discord_id = ${targetDiscordId} AND status = 'claimed'
          ORDER BY id DESC LIMIT 1`
    );
    if (claimRes.rows.length > 0 && claimRes.rows[0]) {
      const c = claimRes.rows[0];
      const expUnix = c.expires_at ? Math.floor(new Date(c.expires_at).getTime() / 1000) : null;
      activeClaimText = `⚡ Task **#${c.task_id}**${expUnix ? ` (expires <t:${expUnix}:R>)` : ""}`;
    }
  } catch {}

  const channelJumpUrl = `https://discord.com/channels/${guild.id}/${channelId}`;

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(`📂 Workspace Channel: #${workspaceChannel.name}`)
    .setDescription(
      `Direct channel access for **<@${targetDiscordId}>**:\n\n` +
      `➡️ **Channel:** <#${channelId}>\n` +
      `🔗 **Direct Link:** [Open #${workspaceChannel.name}](${channelJumpUrl})\n\n` +
      `Click the **📂 Jump to Workspace** button below to open the channel instantly.`
    )
    .addFields(
      {
        name: "👤 Worker",
        value: `<@${targetDiscordId}>\n\`${username}\``,
        inline: true,
      },
      {
        name: "🔗 Linked Reddit",
        value: user?.redditUsername
          ? `[u/${user.redditUsername}](https://www.reddit.com/user/${user.redditUsername})`
          : "*(none)*",
        inline: true,
      },
      {
        name: "⭐ Trust Score",
        value: `${user?.trustScore ?? 100}/100`,
        inline: true,
      },
      {
        name: "💰 Balances",
        value: `**Available:** ${formatMoney(user?.balanceAvailable ?? "0.00")}\n` +
               `**Pending:** ${formatMoney(user?.balancePending ?? "0.00")}\n` +
               `**Earned:** ${formatMoney(user?.totalEarned ?? "0.00")}`,
        inline: true,
      },
      {
        name: "📌 Active Claim",
        value: activeClaimText,
        inline: true,
      },
      {
        name: "🛡️ Status",
        value: user?.flagged
          ? "🚩 **Flagged**"
          : (user?.verified ? "✅ **Verified**" : "⏳ **Unverified**"),
        inline: true,
      }
    );

  if (avatarUrl) {
    embed.setThumbnail(avatarUrl);
  }

  embed.setFooter({ text: `Channel ID: ${channelId} • Discord ID: ${targetDiscordId}` });

  // Direct clickable Discord Link Button
  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel(`📂 Jump to #${workspaceChannel.name}`)
      .setStyle(ButtonStyle.Link)
      .setURL(channelJumpUrl),
    new ButtonBuilder()
      .setCustomId(`ws:viewprofile:${targetDiscordId}`)
      .setLabel("👤 View Full Profile")
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [buttonRow] });
}

/**
 * Handle button clicks for workspace finder (ws:create:*, ws:viewprofile:*).
 */
export async function handleWorkspaceButton(
  interaction: ButtonInteraction,
  action: string,
  targetDiscordId: string
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;

  if (action === "create") {
    await interaction.deferUpdate();
    const member = await guild.members.fetch(targetDiscordId).catch(() => null);
    if (!member) {
      await interaction.followUp({ content: "❌ Member is no longer in this Discord server.", flags: 64 });
      return;
    }

    try {
      const channel = await getOrCreateWorkspaceChannel(guild, member);
      await db.execute(
        sql`UPDATE users SET workspace_channel_id = ${channel.id} WHERE discord_id = ${targetDiscordId}`
      );
      const channelJumpUrl = `https://discord.com/channels/${guild.id}/${channel.id}`;

      const embed = makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ Workspace Channel Restored")
        .setDescription(
          `Workspace channel created/restored for **<@${targetDiscordId}>**:\n\n` +
          `➡️ **Channel:** <#${channel.id}>\n` +
          `[**📂 Jump to #${channel.name}**](${channelJumpUrl})`
        );

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel(`📂 Jump to #${channel.name}`)
          .setStyle(ButtonStyle.Link)
          .setURL(channelJumpUrl)
      );

      await interaction.editReply({ embeds: [embed], components: [row] });
    } catch (err: any) {
      await interaction.followUp({ content: `❌ Failed creating channel: ${err.message}`, flags: 64 });
    }
    return;
  }

  if (action === "viewprofile") {
    await interaction.deferReply({ flags: 64 });
    const user = await getUserByDiscordId(targetDiscordId);
    if (!user) {
      await interaction.editReply({ content: "❌ User profile not found." });
      return;
    }

    const embed = makeEmbed(COLORS.PRIMARY)
      .setTitle(`📋 Worker Profile: ${user.discordUsername}`)
      .setDescription(
        `**Discord:** <@${targetDiscordId}> (\`${targetDiscordId}\`)\n` +
        `**Reddit:** ${user.redditUsername ? `[u/${user.redditUsername}](https://www.reddit.com/user/${user.redditUsername})` : "*(none)*"}\n` +
        `**Trust Score:** ${user.trustScore}/100\n` +
        `**Available Balance:** ${formatMoney(user.balanceAvailable)}\n` +
        `**Pending Balance:** ${formatMoney(user.balancePending)}\n` +
        `**Lifetime Earned:** ${formatMoney(user.totalEarned)}\n` +
        `**UPI:** \`${user.upiId || "(none)"}\`\n` +
        `**GCash:** \`${user.gcashNumber || "(none)"}\`\n` +
        `**PayPal:** \`${user.paypalEmail || "(none)"}\``
      );

    await interaction.editReply({ embeds: [embed] });
  }
}
