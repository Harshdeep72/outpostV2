import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";

const STREAK_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: number; expires: number }>();

/**
 * Compute a user's current daily streak by counting consecutive UTC days
 * (ending today or yesterday) on which they had at least one accepted submission.
 * Pure SQL — no schema changes required.
 */
export async function getUserStreak(discordId: string): Promise<number> {
  const cached = cache.get(discordId);
  if (cached && cached.expires > Date.now()) return cached.value;

  try {
    const res = await db.execute<{ streak: string }>(sql`
      WITH days AS (
        SELECT DISTINCT (submitted_at AT TIME ZONE 'UTC')::date AS d
        FROM submissions
        WHERE discord_id = ${discordId} AND review_status = 'accepted'
      ),
      anchored AS (
        SELECT d FROM days
        WHERE d = (NOW() AT TIME ZONE 'UTC')::date
           OR d = (NOW() AT TIME ZONE 'UTC')::date - 1
      ),
      ranked AS (
        SELECT d, ROW_NUMBER() OVER (ORDER BY d DESC) AS rn FROM days
        WHERE d <= (NOW() AT TIME ZONE 'UTC')::date
      )
      SELECT COUNT(*)::text AS streak
      FROM ranked
      WHERE EXISTS (SELECT 1 FROM anchored)
        AND d = (NOW() AT TIME ZONE 'UTC')::date - (rn - 1) * INTERVAL '1 day';
    `);
    const value = parseInt(res.rows[0]?.streak ?? "0", 10) || 0;
    cache.set(discordId, { value, expires: Date.now() + STREAK_TTL_MS });
    return value;
  } catch (err) {
    logger.warn({ err, discordId }, "getUserStreak failed");
    return 0;
  }
}

export function invalidateStreak(discordId: string): void {
  cache.delete(discordId);
}
