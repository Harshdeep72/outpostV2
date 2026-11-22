import { type ChatInputCommandInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { makeEmbed } from "../util.js";
import { COLORS } from "../constants.js";
import { getUserByDiscordId } from "../db.js";
import { checkRedditAccountHealth } from "../shadowbanChecker.js";

export async function handleCheckRedditCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 }); // Ephemeral: private to the user

  const discordId = interaction.user.id;
  const targetUserOpt = interaction.options.getString("username")?.trim();

  // If a specific username was passed: check just that one
  if (targetUserOpt) {
    const health = await checkRedditAccountHealth(targetUserOpt, { bypassCache: true });

    let statusText: string;
    let color: number;

    if (health.isHealthy) {
      statusText =
        `✅ **Active & Healthy**\n` +
        `• Total Karma: **${(health.karma ?? 0).toLocaleString()}**\n` +
        `• Account Age: **${health.accountAgeDays ?? 0} days**\n\n` +
        `Comments from this account are publicly visible!`;
      color = COLORS.SUCCESS;
    } else if (health.isSuspended) {
      statusText =
        `🚫 **Suspended by Reddit**\n` +
        `• This Reddit account is banned/suspended by Reddit.\n` +
        `• Comments cannot be posted or viewed by anyone.`;
      color = COLORS.DANGER;
    } else {
      statusText =
        `❌ **Shadowbanned / 404 Not Found**\n` +
        `• This profile returns **404 Not Found** to the public and Reddit API.\n` +
        `• To you inside the Reddit app, everything may look normal, but **any comments you post are automatically invisible to everyone else** and will be rejected.\n\n` +
        `💡 *Verify this yourself by opening your profile or comment link in an **Incognito / Private window** (while logged out).*`;
      color = COLORS.DANGER;
    }

    const embed = makeEmbed(color)
      .setTitle(`🔍 Reddit Account Check: u/${health.username}`)
      .setDescription(statusText)
      .setFooter({ text: "Reddit Microtasks • Account Health Inspector" });

    return interaction.editReply({ embeds: [embed] });
  }

  // Otherwise: check all linked accounts for this Discord user
  const user = await getUserByDiscordId(discordId);
  const accountsRes = await db.execute<{ reddit_username: string }>(
    sql`SELECT reddit_username FROM reddit_accounts WHERE discord_id = ${discordId}`
  );

  const accountNames = new Set<string>();
  if (user?.redditUsername?.trim()) {
    accountNames.add(user.redditUsername.trim().toLowerCase());
  }
  for (const r of accountsRes.rows) {
    if (r.reddit_username?.trim()) {
      accountNames.add(r.reddit_username.trim().toLowerCase());
    }
  }

  if (accountNames.size === 0) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("verify:start")
        .setLabel("🔗 Link Reddit Account")
        .setStyle(ButtonStyle.Success)
    );

    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.WARNING)
          .setTitle("No Reddit Accounts Linked")
          .setDescription(
            "You don't have any Reddit accounts linked to your Discord profile yet.\n\n" +
            "Click the button below to verify and link your account in seconds:"
          ),
      ],
      components: [row],
    });
  }

  const results = await Promise.all(
    Array.from(accountNames).map((name) => checkRedditAccountHealth(name, { bypassCache: true }))
  );

  const lines = results.map((h) => {
    if (h.isHealthy) {
      return `• **u/${h.username}**: ✅ **Healthy** (Karma: ${(h.karma ?? 0).toLocaleString()} | Age: ${h.accountAgeDays ?? 0}d)`;
    } else if (h.isSuspended) {
      return `• **u/${h.username}**: 🚫 **Suspended** (Banned by Reddit)`;
    } else {
      return `• **u/${h.username}**: ❌ **Shadowbanned** (Invisible / 404 on Reddit)`;
    }
  });

  const hasDead = results.some((h) => !h.isHealthy);
  const allDead = results.every((h) => !h.isHealthy);

  let color: number = COLORS.SUCCESS;
  if (allDead) color = COLORS.DANGER;
  else if (hasDead) color = COLORS.WARNING;

  const desc =
    `**Your Linked Reddit Accounts (${results.length}):**\n\n` +
    lines.join("\n") +
    (hasDead
      ? `\n\n⚠️ **Shadowban Warning:**\n` +
        `Comments posted from shadowbanned accounts are invisible on Reddit and will be rejected. Please use healthy accounts or link a clean account with \`/verify\`.\n\n` +
        `💡 *You can test any comment by opening its permalink in an **Incognito Window**.*`
      : `\n\n🎉 All your linked accounts are healthy and ready to claim tasks!`);

  const embed = makeEmbed(color)
    .setTitle("📊 Reddit Account Health Check")
    .setDescription(desc)
    .setFooter({ text: "Reddit Microtasks • Account Health Inspector" });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  if (hasDead) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("verify:start")
          .setLabel("🔗 Link Clean Reddit Account")
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  return interaction.editReply({ embeds: [embed], components });
}
