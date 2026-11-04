import { sql, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { users, trustLogs, referrals, tasks, claims, redditAccounts } from "@workspace/db";
import type { User } from "@workspace/db";
import {
  REFERRAL_REWARD,
  REFERRAL_REWARD_REFERRER,
  REFERRAL_REWARD_REFERRED,
  REFERRAL_TIER1_REWARD,
  REFERRAL_TIER1_MIN_KARMA,
  REFERRAL_TIER1_MIN_AGE_DAYS,
  REFERRAL_TIER2_REWARD,
  REFERRAL_TIER2_MIN_KARMA,
  REFERRAL_TIER2_MIN_AGE_DAYS,
  MAX_REFERRAL_COMPLETIONS_PER_DAY,
  MAX_REFERRALS_PER_HOUR,
} from "./constants.js";
import { logger } from "../lib/logger.js";
import {
  userCache,
  userByIdCache,
  userByReferralCodeCache,
  userExistsCache,
  taskCache,
  claimCache,
  invalidateUser,
  invalidateTask,
  invalidateClaim,
} from "./cache.js";

function generateReferralCode(): string {
  return Math.random().toString(36).substring(2, 6).toUpperCase() +
    Math.random().toString(36).substring(2, 6).toUpperCase();
}

/**
 * Full upsert — always touches DB. Use when you need the latest User row.
 */
export async function upsertUser(discordId: string, discordUsername: string): Promise<User> {
  const existing = await db.select().from(users).where(eq(users.discordId, discordId)).limit(1);
  if (existing.length > 0) {
    const updates: Record<string, any> = { discordUsername };
    if (!existing[0]!.referralCode) {
      updates.referralCode = generateReferralCode();
    }
    const [updated] = await db.update(users).set(updates).where(eq(users.discordId, discordId)).returning();
    const finalUser = updated ?? existing[0]!;
    userCache.set(discordId, finalUser);
    userByIdCache.set(finalUser.id, finalUser);
    userExistsCache.set(discordId, discordUsername);
    return finalUser;
  }
  const referralCode = generateReferralCode();
  const [user] = await db.insert(users).values({ discordId, discordUsername, referralCode }).returning();
  userCache.set(discordId, user!);
  userByIdCache.set(user!.id, user!);
  userExistsCache.set(discordId, discordUsername);
  return user!;
}

/**
 * Lazy upsert for fire-and-forget use (e.g. interactionCreate).
 * Skips DB entirely if we've recently seen this discordId with the same username.
 */
export async function upsertUserSmart(discordId: string, discordUsername: string): Promise<void> {
  const cachedUsername = userExistsCache.get(discordId);
  if (cachedUsername === discordUsername) return;
  await upsertUser(discordId, discordUsername);
}

export async function getUserByDiscordId(discordId: string): Promise<User | undefined> {
  const cached = userCache.get(discordId);
  if (cached) return cached;
  const rows = await db.select().from(users).where(eq(users.discordId, discordId)).limit(1);
  const user = rows[0];
  if (user) {
    userCache.set(discordId, user);
    userByIdCache.set(user.id, user);
    userExistsCache.set(discordId, user.discordUsername);
  }
  return user;
}

export async function getUserById(id: number): Promise<User | undefined> {
  const cached = userByIdCache.get(id);
  if (cached) return cached;
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const user = rows[0];
  if (user) {
    userByIdCache.set(id, user);
    userCache.set(user.discordId, user);
  }
  return user;
}

export async function getUserByReferralCode(code: string): Promise<User | undefined> {
  const upper = code.toUpperCase();
  const cached = userByReferralCodeCache.get(upper);
  if (cached) return cached;
  const rows = await db.select().from(users).where(eq(users.referralCode, upper)).limit(1);
  const user = rows[0];
  if (user) {
    userByReferralCodeCache.set(upper, user);
    userCache.set(user.discordId, user);
    userByIdCache.set(user.id, user);
  }
  return user;
}

export async function applyTrust(
  userId: number,
  discordId: string,
  delta: number,
  reason: string,
  relatedSubmissionId?: number
): Promise<void> {
  await db.execute(
    sql`UPDATE users SET trust_score = GREATEST(0, trust_score + ${delta}) WHERE id = ${userId}`
  );
  await db.insert(trustLogs).values({ userId, discordId, delta, reason, relatedSubmissionId });
  invalidateUser(discordId, userId);
}

export async function creditPending(userId: number, amount: string): Promise<void> {
  await db.execute(
    sql`UPDATE users SET balance_pending = balance_pending + ${amount}::numeric, total_earned = total_earned + ${amount}::numeric WHERE id = ${userId}`
  );
  const cached = userByIdCache.get(userId);
  if (cached) invalidateUser(cached.discordId, userId);
  else userByIdCache.delete(userId);
}

export async function movePendingToAvailable(userId: number, amount: string): Promise<void> {
  await db.execute(
    sql`UPDATE users SET balance_pending = GREATEST(0, balance_pending - ${amount}::numeric), balance_available = balance_available + ${amount}::numeric WHERE id = ${userId}`
  );
  const cached = userByIdCache.get(userId);
  if (cached) invalidateUser(cached.discordId, userId);
  else userByIdCache.delete(userId);
}

export async function deductAvailable(userId: number, amount: string): Promise<void> {
  await db.execute(
    sql`UPDATE users SET balance_available = GREATEST(0, balance_available - ${amount}::numeric) WHERE id = ${userId}`
  );
  const cached = userByIdCache.get(userId);
  if (cached) invalidateUser(cached.discordId, userId);
  else userByIdCache.delete(userId);
}

export async function refundAvailable(userId: number, amount: string): Promise<void> {
  await db.execute(
    sql`UPDATE users SET balance_available = balance_available + ${amount}::numeric WHERE id = ${userId}`
  );
  const cached = userByIdCache.get(userId);
  if (cached) invalidateUser(cached.discordId, userId);
  else userByIdCache.delete(userId);
}

export async function getTaskByIdCached(id: number): Promise<typeof tasks.$inferSelect | undefined> {
  const cached = taskCache.get(id);
  if (cached) return cached;
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  const t = rows[0];
  if (t) taskCache.set(id, t);
  return t;
}

export async function getClaimByIdCached(id: number): Promise<typeof claims.$inferSelect | undefined> {
  const cached = claimCache.get(id);
  if (cached) return cached;
  const rows = await db.select().from(claims).where(eq(claims.id, id)).limit(1);
  const c = rows[0];
  if (c) claimCache.set(id, c);
  return c;
}

export { invalidateTask, invalidateClaim };

export async function tryCompleteReferral(
  referredDiscordId: string,
  referredUserId: number
): Promise<{
  completed: boolean;
  referrerDiscordId?: string;
  referredDiscordId?: string;
  referrerReward?: string;
  referredReward?: string;
}> {
  const referredUser = await getUserByDiscordId(referredDiscordId);
  if (!referredUser?.referredBy) return { completed: false };

  const pendingReferral = await db.select().from(referrals)
    .where(eq(referrals.referredDiscordId, referredDiscordId))
    .limit(1);

  const ref = pendingReferral[0];
  if (!ref || ref.rewardPaid || ref.status === "completed") return { completed: false };

  const referrerDiscordId = ref.referrerDiscordId;

  // 1. Task verification requirement: Invited user must have at least 1 task that passed the 24hr live check
  const liveClearedSub = await db.execute<{ id: number }>(
    sql`SELECT id FROM submissions
        WHERE discord_id = ${referredDiscordId}
          AND review_status = 'accepted'
          AND moved_to_available = 1
          AND live_status = 'live'
        LIMIT 1`
  );
  if (liveClearedSub.rows.length === 0) {
    logger.debug({ referredDiscordId }, "tryCompleteReferral: invited user has not yet passed 24hr live check on a task");
    return { completed: false };
  }

  // 2. Reddit account requirement: Invited user must have 300+ karma and 3+ months old (90+ days)
  const linkedAccounts = await db.select().from(redditAccounts).where(eq(redditAccounts.discordId, referredDiscordId));

  const candidates: Array<{ username: string; ageDays: number; karma: number }> = [];
  if (referredUser.redditUsername) {
    candidates.push({
      username: referredUser.redditUsername,
      ageDays: referredUser.redditAccountAgeDays ?? 0,
      karma: (referredUser.redditPostKarma ?? 0) + (referredUser.redditCommentKarma ?? 0),
    });
  }
  for (const acc of linkedAccounts) {
    candidates.push({
      username: acc.redditUsername,
      ageDays: acc.accountAgeDays ?? 0,
      karma: (acc.postKarma ?? 0) + (acc.commentKarma ?? 0),
    });
  }

  // If stored karma is below threshold, perform live check to refresh fresh karma from Reddit
  for (const c of candidates) {
    if (c.karma < REFERRAL_MIN_KARMA && c.username) {
      try {
        const { fetchRedditProfile } = await import("./reddit.js");
        const fresh = await fetchRedditProfile(c.username);
        if (fresh.ok && fresh.profile) {
          c.karma = fresh.profile.totalKarma;
          c.ageDays = fresh.profile.accountAgeDays;
          await db.execute(sql`
            UPDATE reddit_accounts
            SET post_karma = ${fresh.profile.linkKarma}, comment_karma = ${fresh.profile.commentKarma}, account_age_days = ${fresh.profile.accountAgeDays}
            WHERE reddit_username = ${c.username.toLowerCase()}
          `);
          await db.execute(sql`
            UPDATE users
            SET reddit_post_karma = ${fresh.profile.linkKarma}, reddit_comment_karma = ${fresh.profile.commentKarma}, reddit_account_age_days = ${fresh.profile.accountAgeDays}
            WHERE discord_id = ${referredDiscordId} AND reddit_username = ${c.username.toLowerCase()}
          `);
        }
      } catch (err) {
        logger.debug({ err, username: c.username }, "tryCompleteReferral: live reddit refresh failed (non-fatal)");
      }
    }
  }

  // Evaluate Tier 1 ($1.00) vs Tier 2 ($0.50)
  let calculatedReward = "0.00";
  let tierMatched = 0;

  // Check Tier 1: 300+ karma & 90+ days (3 months) -> $1.00
  if (candidates.some((c) => c.karma >= REFERRAL_TIER1_MIN_KARMA && c.ageDays >= REFERRAL_TIER1_MIN_AGE_DAYS)) {
    calculatedReward = REFERRAL_TIER1_REWARD;
    tierMatched = 1;
  }
  // Check Tier 2: 150+ karma & 30+ days (1 month) -> $0.50
  else if (candidates.some((c) => c.karma >= REFERRAL_TIER2_MIN_KARMA && c.ageDays >= REFERRAL_TIER2_MIN_AGE_DAYS)) {
    calculatedReward = REFERRAL_TIER2_REWARD;
    tierMatched = 2;
  }

  if (tierMatched === 0) {
    logger.info(
      {
        referredDiscordId,
        referrerDiscordId,
        candidates,
      },
      "tryCompleteReferral: invited user does not meet Tier 1 (300k/90d) or Tier 2 (150k/30d) requirements"
    );
    return { completed: false };
  }

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const todayCount = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text as count FROM referrals WHERE referrer_discord_id = ${referrerDiscordId} AND status = 'completed' AND task_completed_at >= ${todayStart}`
  );
  if (parseInt(todayCount.rows[0]?.count ?? "0") >= MAX_REFERRAL_COMPLETIONS_PER_DAY) {
    logger.warn({ referrerDiscordId }, "Referral daily limit reached — not crediting");
    return { completed: false };
  }

  const hourCount = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text as count FROM referrals WHERE referrer_discord_id = ${referrerDiscordId} AND status = 'completed' AND task_completed_at >= ${hourAgo}`
  );
  if (parseInt(hourCount.rows[0]?.count ?? "0") >= MAX_REFERRALS_PER_HOUR) {
    logger.warn({ referrerDiscordId }, "Referral hourly limit reached — flagging as suspicious");
    await db.execute(sql`UPDATE users SET flagged = true WHERE discord_id = ${referrerDiscordId}`);
    invalidateUser(referrerDiscordId);
    return { completed: false };
  }

  // Atomic update to avoid race conditions: ensure reward_paid is false and status is not completed
  const updateResult = await db.execute<{ id: number }>(
    sql`UPDATE referrals
        SET status = 'completed',
            reward_paid = true,
            reward_amount = ${calculatedReward}::numeric,
            task_completed_at = ${now}
        WHERE id = ${ref.id} AND reward_paid = false AND status != 'completed'
        RETURNING id`
  );
  if (updateResult.rows.length === 0) {
    return { completed: false };
  }

  // 1. Credit Referrer (+calculatedReward: $1.00 or $0.50)
  await db.execute(
    sql`UPDATE users
        SET referral_earnings = referral_earnings + ${calculatedReward}::numeric,
            total_earned = total_earned + ${calculatedReward}::numeric,
            balance_available = balance_available + ${calculatedReward}::numeric
        WHERE discord_id = ${referrerDiscordId}`
  );
  invalidateUser(referrerDiscordId);

  // 2. Credit Referred member (+$0.20)
  await db.execute(
    sql`UPDATE users
        SET total_earned = total_earned + ${REFERRAL_REWARD_REFERRED}::numeric,
            balance_available = balance_available + ${REFERRAL_REWARD_REFERRED}::numeric
        WHERE discord_id = ${referredDiscordId}`
  );
  invalidateUser(referredDiscordId, referredUserId);

  // Lazy import to avoid a circular dep between db <-> earnerRoles.
  import("./earnerRoles.js").then((m) => {
    m.safeSyncEarnerRoles(referrerDiscordId);
    m.safeSyncEarnerRoles(referredDiscordId);
  }).catch(() => {});

  logger.info(
    {
      referrerDiscordId,
      referredDiscordId,
      tierMatched,
      referrerReward: calculatedReward,
      referredReward: REFERRAL_REWARD_REFERRED,
    },
    "Referral completed and credited to both inviter and new member"
  );

  return {
    completed: true,
    referrerDiscordId,
    referredDiscordId,
    referrerReward: calculatedReward,
    referredReward: REFERRAL_REWARD_REFERRED,
  };
}
