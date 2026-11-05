import { type Client, type Guild } from "discord.js";
import { pool } from "@workspace/db";
import { setupGuild } from "./setup.js";
import { updateServerStats } from "./serverStats.js";
import { makeEmbed } from "./util.js";
import { COLORS } from "./constants.js";
import { logger } from "../lib/logger.js";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

export async function processUnverifiedLifecycle(guild: Guild): Promise<{ warned: number; kicked: number }> {
  try {
    const setup = await setupGuild(guild);
    if (!setup.unverifiedRole || !setup.verifiedRole) return { warned: 0, kicked: 0 };

    await guild.members.fetch().catch(() => {});
    const now = Date.now();
    let kickedCount = 0;
    let warnedCount = 0;

    for (const member of guild.members.cache.values()) {
      if (member.user.bot) continue;

      // Never touch staff or server owner
      if (
        (setup.adminRole && member.roles.cache.has(setup.adminRole.id)) ||
        (setup.modRole && member.roles.cache.has(setup.modRole.id)) ||
        member.id === guild.ownerId
      ) {
        continue;
      }

      // If they have the verified role, ensure cleanup from reminders table and skip
      if (member.roles.cache.has(setup.verifiedRole.id)) {
        continue;
      }

      const joinedAtMs = member.joinedTimestamp;
      if (!joinedAtMs) continue;

      const ageMs = now - joinedAtMs;

      // --- STAGE 2: 48+ Hours Unverified -> Kick from server ---
      if (ageMs >= FORTY_EIGHT_HOURS_MS) {
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

          pool.query(`DELETE FROM unverified_reminders WHERE discord_id = $1`, [member.id]).catch(() => {});

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
      // --- STAGE 1: 24+ Hours Unverified (<48h) -> Send Reminder DM Warning ---
      else if (ageMs >= TWENTY_FOUR_HOURS_MS) {
        try {
          // Atomic dedup: insert only if not already warned
          const claim = await pool.query(
            `INSERT INTO unverified_reminders (discord_id, warned_at)
             VALUES ($1, NOW())
             ON CONFLICT (discord_id) DO NOTHING
             RETURNING discord_id`,
            [member.id]
          );

          if (claim.rowCount && claim.rowCount > 0) {
            const hoursLeft = Math.max(1, Math.round((FORTY_EIGHT_HOURS_MS - ageMs) / (60 * 60 * 1000)));

            const reminderEmbed = makeEmbed(COLORS.WARNING)
              .setTitle("⚠️ Action Required: Verify Your Reddit Account")
              .setDescription(
                `Hey <@${member.id}>! You joined **${guild.name}** over 24 hours ago, but you haven't linked your Reddit account yet.\n\n` +
                `⏰ **48-Hour Inactivity Notice:**\n` +
                `To keep our community active, accounts that remain unverified for **48 hours** are automatically removed from the server.\n` +
                `You have approximately **${hoursLeft} hours left** to verify before removal.\n\n` +
                `**How to keep your spot & start earning:**\n` +
                `1. Go to <#${setup.startHereChannel?.id || "start-here"}>\n` +
                `2. Click **Verify Reddit Account** (or run \`/verify\`)\n` +
                `3. Enter your Reddit username\n\n` +
                `Once verified, your private workspace unlocks and you can begin claiming tasks immediately!`
              )
              .setFooter({ text: "Reddit Microtasks • Verification Reminder" })
              .setTimestamp();

            await member.send({ embeds: [reminderEmbed] }).catch(() => {
              logger.debug({ userId: member.id }, "Could not DM 24h reminder (DMs closed)");
            });

            warnedCount++;
            logger.info(
              { guildId: guild.id, userId: member.id, username: member.user.username, hoursLeft },
              "Sent 24-hour verification reminder warning"
            );

            // Rate limit protection
            await new Promise((r) => setTimeout(r, 600));
          }
        } catch (warnErr) {
          logger.warn(
            { err: warnErr, userId: member.id, guildId: guild.id },
            "Failed processing 24h reminder for member"
          );
        }
      }
    }

    if (kickedCount > 0) {
      await updateServerStats(guild).catch(() => {});
    }

    return { warned: warnedCount, kicked: kickedCount };
  } catch (err) {
    logger.error({ err, guildId: guild.id }, "Error in processUnverifiedLifecycle");
    return { warned: 0, kicked: 0 };
  }
}

export function startUnverifiedPruner(client: Client): void {
  // Run on startup
  for (const guild of client.guilds.cache.values()) {
    processUnverifiedLifecycle(guild).catch(() => {});
  }

  // Periodic check every 1 hour (catches members as they cross 24h and 48h windows)
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      processUnverifiedLifecycle(guild).catch(() => {});
    }
  }, 60 * 60 * 1000).unref();
}
