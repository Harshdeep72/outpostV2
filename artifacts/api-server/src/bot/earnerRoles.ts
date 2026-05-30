import { type Guild, type Role } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { EARNER_TIERS } from "./constants.js";
import { getPrimaryGuild } from "./discord-client.js";
import { logger } from "../lib/logger.js";

export async function ensureEarnerRoles(guild: Guild): Promise<Record<string, Role>> {
  const out: Record<string, Role> = {};
  for (const tier of EARNER_TIERS) {
    let role = guild.roles.cache.find((r) => r.name === tier.roleName);
    if (!role) {
      try {
        role = await guild.roles.create({
          name: tier.roleName,
          color: tier.color,
          reason: "Outpost Bot earner-tier auto-create",
          mentionable: false,
          hoist: false,
        });
        logger.info({ guildId: guild.id, role: tier.roleName }, "Earner role created");
      } catch (err) {
        logger.warn({ err, role: tier.roleName, guildId: guild.id }, "Failed to create earner role");
        continue;
      }
    }
    out[tier.key] = role;
  }
  return out;
}

async function getTotalEarned(discordId: string): Promise<number> {
  const res = await db.execute<{ total_earned: string }>(
    sql`SELECT total_earned::text AS total_earned FROM users WHERE discord_id = ${discordId} LIMIT 1`
  );
  return Number(res.rows[0]?.total_earned ?? "0");
}

export async function syncEarnerRoles(discordId: string): Promise<void> {
  const guild = getPrimaryGuild();
  if (!guild) return;

  let member;
  try {
    member = await guild.members.fetch(discordId);
  } catch {
    return;
  }
  if (!member) return;

  const roles = await ensureEarnerRoles(guild);
  const total = await getTotalEarned(discordId);

  for (const tier of EARNER_TIERS) {
    const role = roles[tier.key];
    if (!role) continue;
    const shouldHave = total >= tier.threshold;
    const has = member.roles.cache.has(role.id);
    if (shouldHave && !has) {
      try {
        await member.roles.add(role, `Reached $${tier.threshold} lifetime earned`);
        logger.info({ discordId, role: role.name, total }, "Earner role granted");
      } catch (err) {
        logger.warn({ err, discordId, role: role.name }, "Failed to grant earner role");
      }
    }
  }
}

export function safeSyncEarnerRoles(discordId: string): void {
  syncEarnerRoles(discordId).catch((err) =>
    logger.warn({ err, discordId }, "safeSyncEarnerRoles failed")
  );
}
