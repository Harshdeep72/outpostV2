import { type Client, type Guild } from "discord.js";
import { setupGuild } from "./setup.js";
import { updateServerStats } from "./serverStats.js";
import { logger } from "../lib/logger.js";

const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

export async function pruneUnverifiedMembers(guild: Guild): Promise<number> {
  try {
    const setup = await setupGuild(guild);
    if (!setup.unverifiedRole || !setup.verifiedRole) return 0;

    await guild.members.fetch().catch(() => {});
    const now = Date.now();
    let kickedCount = 0;

    for (const member of guild.members.cache.values()) {
      if (member.user.bot) continue;

      // Never touch staff
      if (
        (setup.adminRole && member.roles.cache.has(setup.adminRole.id)) ||
        (setup.modRole && member.roles.cache.has(setup.modRole.id)) ||
        member.id === guild.ownerId
      ) {
        continue;
      }

      // If they have the verified role, they are safe
      if (member.roles.cache.has(setup.verifiedRole.id)) {
        continue;
      }

      // Check if they joined > 48 hours ago
      const joinedAtMs = member.joinedTimestamp;
      if (joinedAtMs && now - joinedAtMs >= FORTY_EIGHT_HOURS_MS) {
        try {
          // Attempt courteous DM before kick
          await member
            .send(
              `👋 You have been removed from **${guild.name}** because your account was not verified within 48 hours.\n\n` +
              `You are welcome to rejoin anytime when you are ready to link your Reddit account and start earning!`
            )
            .catch(() => {});

          await member.kick("Unverified after 48 hours");
          kickedCount++;
          logger.info(
            { guildId: guild.id, userId: member.id, username: member.user.username },
            "Pruned member unverified for >48 hours"
          );

          // Rate limit protection
          await new Promise((r) => setTimeout(r, 600));
        } catch (kickErr) {
          logger.warn(
            { err: kickErr, userId: member.id, guildId: guild.id },
            "Failed pruning unverified member"
          );
        }
      }
    }

    if (kickedCount > 0) {
      await updateServerStats(guild).catch(() => {});
    }

    return kickedCount;
  } catch (err) {
    logger.error({ err, guildId: guild.id }, "Error in pruneUnverifiedMembers");
    return 0;
  }
}

export function startUnverifiedPruner(client: Client): void {
  // Run on startup
  for (const guild of client.guilds.cache.values()) {
    pruneUnverifiedMembers(guild).catch(() => {});
  }

  // Periodic check every 2 hours
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      pruneUnverifiedMembers(guild).catch(() => {});
    }
  }, 2 * 60 * 60 * 1000).unref();
}
