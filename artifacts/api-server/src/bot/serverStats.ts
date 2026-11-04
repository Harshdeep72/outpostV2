import { type Client, type Guild, ChannelType, PermissionFlagsBits } from "discord.js";
import { setupGuild } from "./setup.js";
import { logger } from "../lib/logger.js";

const STATS_CATEGORY_NAME = "📊 SERVER STATS";

export async function updateServerStats(guild: Guild): Promise<void> {
  try {
    const setup = await setupGuild(guild);
    await guild.members.fetch().catch(() => {});

    const members = guild.members.cache.filter((m) => !m.user.bot);
    const totalCount = members.size;
    const verifiedCount = setup.verifiedRole
      ? members.filter((m) => m.roles.cache.has(setup.verifiedRole.id)).size
      : 0;
    const unverifiedCount = setup.unverifiedRole
      ? members.filter((m) => m.roles.cache.has(setup.unverifiedRole.id)).size
      : 0;

    let cat = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toUpperCase().includes("SERVER STATS")
    );

    if (!cat) {
      cat = await guild.channels.create({
        name: STATS_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        position: 0,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel],
            deny: [PermissionFlagsBits.Connect],
          },
        ],
      });
    }

    const desired = [
      { prefix: "👥 Members:", target: `👥 Members: ${totalCount}` },
      { prefix: "✅ Verified:", target: `✅ Verified: ${verifiedCount}` },
      { prefix: "⏳ Unverified:", target: `⏳ Unverified: ${unverifiedCount}` },
    ];

    for (let i = 0; i < desired.length; i++) {
      const item = desired[i];
      let ch = guild.channels.cache.find(
        (c) => c.parentId === cat!.id && c.name.startsWith(item.prefix)
      );

      if (!ch) {
        await guild.channels.create({
          name: item.target,
          type: ChannelType.GuildVoice,
          parent: cat.id,
          position: i,
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              allow: [PermissionFlagsBits.ViewChannel],
              deny: [PermissionFlagsBits.Connect],
            },
          ],
        });
      } else {
        if (ch.type === ChannelType.GuildVoice) {
          const overwrite = (ch as any).permissionOverwrites?.cache?.get(guild.roles.everyone.id);
          if (!overwrite || !overwrite.deny.has(PermissionFlagsBits.Connect)) {
            await (ch as any).permissionOverwrites?.edit?.(guild.roles.everyone.id, {
              ViewChannel: true,
              Connect: false,
            }).catch(() => {});
          }
        }
        if (ch.name !== item.target) {
          await ch.setName(item.target).catch((err) =>
            logger.warn({ err, chId: ch!.id }, "Failed renaming stats channel (rate limit)")
          );
        }
      }
    }
  } catch (err) {
    logger.warn({ err, guildId: guild.id }, "Error updating server stats channels");
  }
}

export function startServerStatsUpdater(client: Client): void {
  for (const guild of client.guilds.cache.values()) {
    updateServerStats(guild).catch(() => {});
  }

  // Periodic refresh every 10 minutes (Discord channel rename rate limit is 2 per 10m)
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      updateServerStats(guild).catch(() => {});
    }
  }, 10 * 60 * 1000).unref();
}
