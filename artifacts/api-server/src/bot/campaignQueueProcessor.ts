import { Client, type Guild, type TextChannel } from "discord.js";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { campaignQueue, campaigns } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { COLORS } from "./constants.js";
import { setupGuild } from "./setup.js";
import { createTaskAndPost, type NormalizedTask } from "./task-creation.js";
import { makeEmbed } from "./util.js";

const TICK_MS = 15_000;
const BATCH_LIMIT = 20;
const MAX_ATTEMPTS = 3;
const MAX_PASSES_PER_TICK = 25;

let started = false;
let ticking = false;

type CampaignBatchState = {
  guildId: string;
  postedNow: number;
  singleCardPinged: boolean;
  hadPriorPosted: boolean;
  totalTasks: number;
  intervalMinutes: number;
  title: string;
};

/**
 * Send one @here @everyone summary announcement card to #tasks so workers get a
 * single notification for a scheduled drop instead of one ping per task card.
 */
async function sendDropAnnouncement(guild: Guild, title: string, description: string): Promise<void> {
  const { tasksChannel } = await setupGuild(guild);
  await (tasksChannel as TextChannel).send({
    content: "@here @everyone",
    embeds: [makeEmbed(COLORS.SUCCESS).setTitle(title).setDescription(description)],
    allowedMentions: { parse: ["everyone"] },
  });
}

async function getOrInitCampaignState(
  batchMap: Map<number, CampaignBatchState>,
  campaignId: number,
  guildId: string,
): Promise<CampaignBatchState> {
  const existing = batchMap.get(campaignId);
  if (existing) return existing;

  const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  const state: CampaignBatchState = {
    guildId,
    postedNow: 0,
    singleCardPinged: false,
    hadPriorPosted: (camp?.tasksCreated ?? 0) > 0,
    totalTasks: camp?.totalTasks ?? 1,
    intervalMinutes: camp?.intervalMinutes ?? 0,
    title: camp?.title ?? "Scheduled Drop",
  };
  batchMap.set(campaignId, state);
  return state;
}

async function processQueuedRow(
  client: Client,
  row: typeof campaignQueue.$inferSelect,
  batchMap: Map<number, CampaignBatchState>,
): Promise<void> {
  // Atomically claim the row so concurrent ticks (or restarts mid-tick)
  // don't double-post the same task.
  const claimed = await db.execute(
    sql`UPDATE "campaign_queue" SET "status" = 'processing', "attempts" = "attempts" + 1
        WHERE "id" = ${row.id} AND "status" = 'pending'
        RETURNING "id"`,
  );
  if (claimed.rowCount === 0) return;

  const guild = client.guilds.cache.get(row.guildId);
  if (!guild) {
    logger.warn({ queueId: row.id, guildId: row.guildId }, "Drip queue: guild not in cache, retrying later");
    await db.update(campaignQueue)
      .set({ status: "pending", lastError: "guild not in cache" })
      .where(eq(campaignQueue.id, row.id));
    return;
  }

  const state = await getOrInitCampaignState(batchMap, row.campaignId, row.guildId);
  const isSingleTaskCampaign = state.totalTasks === 1 && !state.hadPriorPosted && state.postedNow === 0;
  const norm = row.payload as unknown as NormalizedTask;

  try {
    // Single-task drops ping directly on the card; multi-task drops post cards
    // silently and emit ONE @here @everyone summary ping per drop below.
    const task = await createTaskAndPost(norm, guild, { silent: !isSingleTaskCampaign, skipReminder: true });
    await db.update(campaignQueue)
      .set({ status: "posted", postedTaskId: task.id, lastError: null })
      .where(eq(campaignQueue.id, row.id));
    await db.execute(
      sql`UPDATE campaigns SET tasks_created = tasks_created + 1 WHERE id = ${row.campaignId}`,
    );
    if (isSingleTaskCampaign) state.singleCardPinged = true;
    state.postedNow++;
    logger.info({ queueId: row.id, taskId: task.id, campaignId: row.campaignId }, "Drip queue: task posted");
    // Add brief delay to prevent Discord card-burst rate limiting during batch drops
    await new Promise((r) => setTimeout(r, 1000));
  } catch (err: any) {
    const attempts = (row.attempts ?? 0) + 1;
    const next = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    await db.update(campaignQueue)
      .set({ status: next, lastError: String(err?.message ?? err).slice(0, 500) })
      .where(eq(campaignQueue.id, row.id));
    logger.warn({ err, queueId: row.id, attempts, next }, "Drip queue: post failed");
  }
}

async function finalizeCampaignBatch(
  client: Client,
  campaignId: number,
  state: CampaignBatchState,
): Promise<void> {
  try {
    const now = new Date();
    const [counts] = await db
      .select({
        remainingAny: sql<number>`COUNT(*) FILTER (WHERE ${or(eq(campaignQueue.status, "pending"), eq(campaignQueue.status, "processing"))})::int`,
        remainingDueNow: sql<number>`COUNT(*) FILTER (WHERE ${or(eq(campaignQueue.status, "pending"), eq(campaignQueue.status, "processing"))} AND ${lte(campaignQueue.scheduledAt, now)})::int`,
      })
      .from(campaignQueue)
      .where(eq(campaignQueue.campaignId, campaignId));

    const remainingAny = counts?.remainingAny ?? 0;
    const remainingDueNow = counts?.remainingDueNow ?? 0;

    if (remainingAny === 0) {
      await db.update(campaigns).set({ status: "completed" }).where(eq(campaigns.id, campaignId));
    }

    if (state.singleCardPinged || state.postedNow === 0) return;

    const guild = client.guilds.cache.get(state.guildId);
    if (!guild) return;

    if (state.intervalMinutes === 0 && remainingDueNow === 0) {
      const [freshCamp] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      const totalPosted = freshCamp?.tasksCreated ?? state.postedNow;
      await sendDropAnnouncement(
        guild,
        `📦 ${totalPosted} New Task${totalPosted === 1 ? "" : "s"} Dropped!`,
        `Campaign: **${state.title}**\n\nGrab your slots now before they fill up!`,
      );
      logger.info({ campaignId, totalPosted }, "Drip queue: sent batch drop @everyone ping");
    } else if (state.intervalMinutes > 0 && !state.hadPriorPosted) {
      await sendDropAnnouncement(
        guild,
        `📦 New Campaign Dropping Now (${state.totalTasks} Total Tasks)`,
        `Campaign: **${state.title}**\n\n` +
          `First task${state.postedNow === 1 ? " is" : "s are"} live — new tasks will keep dropping every **${state.intervalMinutes}m**. Grab your slots now!`,
      );
      logger.info({ campaignId, intervalMinutes: state.intervalMinutes }, "Drip queue: sent drip-start @everyone ping");
    }
  } catch (err) {
    logger.warn({ err, campaignId }, "Drip queue: campaign completion/ping check failed");
  }
}

async function tick(client: Client): Promise<void> {
  if (ticking) return;
  ticking = true;

  const batchMap = new Map<number, CampaignBatchState>();
  const attemptedRowIds = new Set<number>();

  try {
    for (let pass = 0; pass < MAX_PASSES_PER_TICK; pass++) {
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
        break;
      }
      if (dueRows.length === 0) break;
      if (dueRows.every((r) => attemptedRowIds.has(r.id))) break;

      for (const row of dueRows) {
        if (attemptedRowIds.has(row.id)) continue;
        attemptedRowIds.add(row.id);
        await processQueuedRow(client, row, batchMap);
      }
    }

    for (const [cid, state] of batchMap) {
      await finalizeCampaignBatch(client, cid, state);
    }
  } finally {
    ticking = false;
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
