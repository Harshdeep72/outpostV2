import { Client } from "discord.js";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { campaignQueue, campaigns } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { createTaskAndPost, type NormalizedTask } from "./task-creation.js";

const TICK_MS = 30_000;
const BATCH_LIMIT = 5;
const MAX_ATTEMPTS = 3;

let started = false;

async function tick(client: Client): Promise<void> {
  let dueRows;
  try {
    dueRows = await db
      .select()
      .from(campaignQueue)
      .where(and(eq(campaignQueue.status, "pending"), lte(campaignQueue.scheduledAt, new Date())))
      .orderBy(asc(campaignQueue.scheduledAt))
      .limit(BATCH_LIMIT);
  } catch (err) {
    logger.error({ err }, "Drip queue tick: SELECT failed");
    return;
  }
  if (dueRows.length === 0) return;

  for (const row of dueRows) {
    // Atomically claim the row so concurrent ticks (or restarts mid-tick)
    // don't double-post the same task.
    const claimed = await db.execute(
      sql`UPDATE "campaign_queue" SET "status" = 'processing', "attempts" = "attempts" + 1
          WHERE "id" = ${row.id} AND "status" = 'pending'
          RETURNING "id"`,
    );
    if (claimed.rowCount === 0) continue;

    const guild = client.guilds.cache.get(row.guildId);
    if (!guild) {
      logger.warn({ queueId: row.id, guildId: row.guildId }, "Drip queue: guild not in cache, retrying later");
      await db.update(campaignQueue)
        .set({ status: "pending", lastError: "guild not in cache" })
        .where(eq(campaignQueue.id, row.id));
      continue;
    }

    const norm = row.payload as unknown as NormalizedTask;
    try {
      // Drip-feed: each task IS its own announcement (spaced apart from the
      // others), so it gets a real @here @everyone ping. We skip the per-task
      // 5-min reminder because the next drip drop arrives on the same cadence
      // and would stack on top of the reminder.
      const task = await createTaskAndPost(norm, guild, { silent: false, skipReminder: true });
      await db.update(campaignQueue)
        .set({ status: "posted", postedTaskId: task.id, lastError: null })
        .where(eq(campaignQueue.id, row.id));
      await db.execute(
        sql`UPDATE campaigns SET tasks_created = tasks_created + 1 WHERE id = ${row.campaignId}`,
      );
      logger.info({ queueId: row.id, taskId: task.id, campaignId: row.campaignId }, "Drip queue: task posted");
    } catch (err: any) {
      const attempts = (row.attempts ?? 0) + 1;
      const next = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      await db.update(campaignQueue)
        .set({ status: next, lastError: String(err?.message ?? err).slice(0, 500) })
        .where(eq(campaignQueue.id, row.id));
      logger.warn({ err, queueId: row.id, attempts, next }, "Drip queue: post failed");
    }
  }

  // Mark the campaign 'completed' once the queue has fully drained.
  const campaignIds = Array.from(new Set(dueRows.map((r: any) => r.campaignId)));
  for (const cid of campaignIds) {
    try {
      const remaining = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(campaignQueue)
        .where(and(eq(campaignQueue.campaignId, cid), eq(campaignQueue.status, "pending")));
      if ((remaining[0]?.n ?? 0) === 0) {
        await db.update(campaigns).set({ status: "completed" }).where(eq(campaigns.id, cid));
      }
    } catch (err) {
      logger.warn({ err, campaignId: cid }, "Drip queue: campaign completion check failed");
    }
  }
}

/**
 * Reclaim orphaned rows: any row left in `processing` belongs to a previous
 * bot process that crashed between claim and the final status update. Since
 * this bot runs as a single process per environment, we can safely reset all
 * such rows back to `pending` on startup so the next tick picks them up.
 *
 * Without this, a crash mid-post would strand the row forever (the SELECT
 * filter only pulls `status='pending'`).
 */
async function reclaimOrphanedRows(): Promise<void> {
  try {
    const result = await db.execute(
      sql`UPDATE "campaign_queue"
          SET "status" = 'pending'
          WHERE "status" = 'processing'
          RETURNING "id"`,
    );
    if (result.rowCount && result.rowCount > 0) {
      logger.info({ count: result.rowCount }, "Drip queue: reclaimed orphaned 'processing' rows from prior bot process");
    }
  } catch (err) {
    logger.error({ err }, "Drip queue: failed to reclaim orphaned rows on startup");
  }
}

export function startCampaignQueueProcessor(client: Client): void {
  if (started) return;
  started = true;
  logger.info({ tickMs: TICK_MS }, "Campaign drip-feed queue processor started");
  // Reclaim any rows the previous process was mid-posting when it died, then kick a tick.
  void reclaimOrphanedRows().then(() => tick(client));
  setInterval(() => void tick(client), TICK_MS).unref();
}
