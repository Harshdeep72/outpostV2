import { sql, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { users, trustLogs, referrals, tasks, claims } from "@workspace/db";
import type { User } from "@workspace/db";
import { REFERRAL_REWARD, MAX_REFERRAL_COMPLETIONS_PER_DAY, MAX_REFERRALS_PER_HOUR } from "./constants.js";
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
): Promise<{ completed: boolean; referrerDiscordId?: string }> {
  const referredUser = await getUserByDiscordId(referredDiscordId);
  if (!referredUser?.referredBy) return { completed: false };

  const pendingReferral = await db.select().from(referrals)
    .where(eq(referrals.referredDiscordId, referredDiscordId))
    .limit(1);

  const ref = pendingReferral[0];
  if (!ref || ref.status !== "verified" || ref.rewardPaid) return { completed: false };

  const referrerDiscordId = ref.referrerDiscordId;

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

  await db.update(referrals).set({
    status: "completed",
    rewardPaid: true,
    taskCompletedAt: now,
  }).where(eq(referrals.id, ref.id));

  await db.execute(
    sql`UPDATE users SET referral_earnings = referral_earnings + ${REFERRAL_REWARD}::numeric, total_earned = total_earned + ${REFERRAL_REWARD}::numeric, balance_available = balance_available + ${REFERRAL_REWARD}::numeric WHERE discord_id = ${referrerDiscordId}`
  );
  invalidateUser(referrerDiscordId);

  // Lazy import to avoid a circular dep between db <-> earnerRoles.
  import("./earnerRoles.js").then((m) => m.safeSyncEarnerRoles(referrerDiscordId)).catch(() => {});

  logger.info({ referrerDiscordId, referredDiscordId, reward: REFERRAL_REWARD }, "Referral completed and credited");
  return { completed: true, referrerDiscordId };
}
