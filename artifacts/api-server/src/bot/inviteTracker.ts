import {
  type Client,
  type Guild,
  type GuildMember,
  type Invite,
  Collection,
} from "discord.js";
import { pool, db, users, referrals } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getUserByDiscordId, upsertUser } from "./db.js";
import { invalidateUser, referralStatsCache } from "./cache.js";
import { makeEmbed } from "./util.js";
import { COLORS } from "./constants.js";
import { logger } from "../lib/logger.js";

interface CachedInvite {
  code: string;
  uses: number;
  inviterId?: string;
  maxUses?: number;
}

// In-memory cache: guildId -> (inviteCode -> CachedInvite)
const guildInvitesCache = new Map<string, Map<string, CachedInvite>>();

export async function initInviteTracker(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    await cacheGuildInvites(guild);
  }
}

export async function cacheGuildInvites(guild: Guild): Promise<void> {
  try {
    const invites = await guild.invites.fetch().catch(() => new Collection<string, Invite>());
    const map = new Map<string, CachedInvite>();

    for (const inv of invites.values()) {
      map.set(inv.code, {
        code: inv.code,
        uses: inv.uses ?? 0,
        inviterId: inv.inviter?.id,
        maxUses: inv.maxUses ?? 0,
      });

      // If created by a human member, register in user_invites
      if (inv.inviter?.id && !inv.inviter.bot) {
        pool.query(
          `INSERT INTO user_invites (invite_code, discord_id)
           VALUES ($1, $2)
           ON CONFLICT (invite_code) DO NOTHING`,
          [inv.code, inv.inviter.id]
        ).catch(() => {});
      }
    }

    guildInvitesCache.set(guild.id, map);
    logger.debug({ guildId: guild.id, inviteCount: map.size }, "Cached guild invites for tracking");
  } catch (err) {
    logger.warn({ err, guildId: guild.id }, "Failed caching guild invites");
  }
}

export function handleInviteCreate(invite: Invite): void {
  const guildId = invite.guild?.id;
  if (!guildId) return;

  let map = guildInvitesCache.get(guildId);
  if (!map) {
    map = new Map();
    guildInvitesCache.set(guildId, map);
  }

  map.set(invite.code, {
    code: invite.code,
    uses: invite.uses ?? 0,
    inviterId: invite.inviter?.id,
    maxUses: invite.maxUses ?? 0,
  });

  if (invite.inviter?.id && !invite.inviter.bot) {
    pool.query(
      `INSERT INTO user_invites (invite_code, discord_id)
       VALUES ($1, $2)
       ON CONFLICT (invite_code) DO NOTHING`,
      [invite.code, invite.inviter.id]
    ).catch(() => {});
  }
}

export function handleInviteDelete(invite: Invite): void {
  const guildId = invite.guild?.id;
  if (!guildId) return;

  const map = guildInvitesCache.get(guildId);
  if (map) {
    map.delete(invite.code);
  }
}

export function registerTrackedInvite(guildId: string, code: string, discordId: string): void {
  let map = guildInvitesCache.get(guildId);
  if (!map) {
    map = new Map();
    guildInvitesCache.set(guildId, map);
  }
  const existing = map.get(code);
  map.set(code, {
    code,
    uses: existing?.uses ?? 0,
    inviterId: discordId,
    maxUses: 0,
  });
}

/**
 * Compares current guild invites with cached snapshot to detect
 * which invite was used when a member joins.
 */
export async function trackMemberJoin(
  member: GuildMember
): Promise<{ referrerDiscordId?: string; inviteCode?: string } | null> {
  const guild = member.guild;
  const cached = guildInvitesCache.get(guild.id);

  const freshInvites = await guild.invites.fetch().catch(() => null);
  if (!freshInvites) return null;

  let usedCode: string | undefined;
  let usedInviterId: string | undefined;

  if (cached) {
    // 1. Look for an invite whose uses increased
    for (const fresh of freshInvites.values()) {
      const old = cached.get(fresh.code);
      if (old && (fresh.uses ?? 0) > old.uses) {
        usedCode = fresh.code;
        usedInviterId = fresh.inviter?.id ?? old.inviterId;
        break;
      }
    }

    // 2. If not found, look for single-use invite (maxUses = 1) that was consumed and deleted
    if (!usedCode) {
      for (const old of cached.values()) {
        if (old.maxUses === 1 && !freshInvites.has(old.code)) {
          usedCode = old.code;
          usedInviterId = old.inviterId;
          break;
        }
      }
    }
  }

  // Update in-memory cache to latest state
  const updatedMap = new Map<string, CachedInvite>();
  for (const inv of freshInvites.values()) {
    updatedMap.set(inv.code, {
      code: inv.code,
      uses: inv.uses ?? 0,
      inviterId: inv.inviter?.id ?? cached?.get(inv.code)?.inviterId,
      maxUses: inv.maxUses ?? 0,
    });
  }
  guildInvitesCache.set(guild.id, updatedMap);

  if (!usedCode) return null;

  // Check if this invite code is mapped to a referrer in DB
  try {
    const res = await pool.query<{ discord_id: string }>(
      `SELECT discord_id FROM user_invites WHERE invite_code = $1 LIMIT 1`,
      [usedCode]
    );
    if (res.rows.length > 0 && res.rows[0]?.discord_id) {
      return { referrerDiscordId: res.rows[0].discord_id, inviteCode: usedCode };
    }
  } catch (err) {
    logger.warn({ err, usedCode }, "Failed querying user_invites for code");
  }

  // Fallback to inviterId directly if not the bot and not the member themself
  if (usedInviterId && usedInviterId !== member.client.user?.id && usedInviterId !== member.id) {
    return { referrerDiscordId: usedInviterId, inviteCode: usedCode };
  }

  return null;
}

/**
 * Automatically attributes referral to the referrer when a new member joins via their invite link.
 */
export async function autoApplyReferralOnJoin(
  member: GuildMember,
  referrerDiscordId: string,
  inviteCode?: string
): Promise<boolean> {
  if (member.user.bot) return false;
  if (referrerDiscordId === member.id) return false;

  try {
    await upsertUser(member.id, member.user.username);
    const self = await getUserByDiscordId(member.id);

    // If member already has a referrer or is already verified, do not re-apply
    if (self?.referredBy || self?.verified) {
      return false;
    }

    let referrer = await getUserByDiscordId(referrerDiscordId);
    if (!referrer) {
      referrer = await upsertUser(referrerDiscordId, "referrer");
    }

    // Ensure referrer has a referral code
    if (!referrer.referralCode) {
      const code =
        Math.random().toString(36).substring(2, 6).toUpperCase() +
        Math.random().toString(36).substring(2, 6).toUpperCase();
      await db.update(users).set({ referralCode: code }).where(eq(users.discordId, referrerDiscordId));
      invalidateUser(referrerDiscordId);
      referrer = { ...referrer, referralCode: code };
    }

    // Double check referrals table
    const existingRef = await db
      .select()
      .from(referrals)
      .where(eq(referrals.referredDiscordId, member.id))
      .limit(1);

    if (existingRef.length > 0) {
      return false;
    }

    const codeToUse = referrer.referralCode || inviteCode || "INVITE_LINK";

    await db.update(users).set({ referredBy: referrerDiscordId }).where(eq(users.discordId, member.id));
    invalidateUser(member.id);

    await db.insert(referrals).values({
      referrerDiscordId,
      referredDiscordId: member.id,
      codeUsed: codeToUse,
      status: "pending",
    });

    referralStatsCache.delete(referrerDiscordId);
    logger.info(
      { newMemberId: member.id, referrerDiscordId, inviteCode },
      "Auto-applied referral to new member from Discord invite link"
    );

    // Notify the referrer via DM
    try {
      const referrerUser = await member.client.users.fetch(referrerDiscordId).catch(() => null);
      if (referrerUser) {
        const dmEmbed = makeEmbed(COLORS.SUCCESS)
          .setTitle("👥 New Member Joined via Your Invite Link!")
          .setDescription(
            `**<@${member.id}>** (\`${member.user.username}\`) just joined the server using your personal invite link!\n\n` +
            `Your referral code has been **automatically linked** to them — they don't have to type anything.\n\n` +
            `**How You Earn:**\n` +
            `When they verify their Reddit account and complete their first task clearing the 24-hour verification hold, you will receive your tier reward (**+$1.00** or **+$0.50**) automatically!`
          );
        await referrerUser.send({ embeds: [dmEmbed] }).catch(() => {});
      }
    } catch (dmErr) {
      logger.debug({ dmErr }, "Could not DM referrer of new join");
    }

    return true;
  } catch (err) {
    logger.warn({ err, memberId: member.id, referrerDiscordId }, "Error in autoApplyReferralOnJoin");
    return false;
  }
}
