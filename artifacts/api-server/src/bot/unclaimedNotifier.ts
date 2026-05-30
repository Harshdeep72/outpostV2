import { type Client, type Guild, type TextChannel } from "discord.js";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { setupGuild } from "./setup.js";
import { getPrimaryGuild } from "./discord-client.js";
import { buildPublicTaskEmbed, buildPublicButtons, buildCampaignProgressEmbed } from "./task-creation.js";

/**
 * Repeating unclaimed-task notifier.
 *
 * For tasks with `unclaimed_notify_enabled = TRUE` (set by bulk-task creation
 * paths) that remain fully unclaimed (slots_filled = 0, status = 'open'), the
 * scheduler periodically deletes the existing #tasks channel message and
 * re-posts a fresh card with an @here ping so the task pops back to the
 * bottom of the channel and workers get re-notified.
 *
 * Cadence escalates so we don't spam Discord forever:
 *   - bumps  1–3 : every  5 min
 *   - bumps  4–6 : every 10 min
 *   - bumps  7–9 : every 15 min
 *   - bumps 10+  : every 30 min
 * Hard-capped at MAX_BUMPS total per task; after that the task is left alone.
 *
 * Once the first slot is claimed, slots_filled > 0 and the WHERE clause stops
 * matching — the task is naturally retired from the bump rotation.
 */
const TICK_MS = 60_000; // check every 60s; cadence is gated by per-task interval
const MAX_BUMPS = 24;   // safety cap (~12 hours of 30-min bumps after ramp-up)

function intervalMinutesForCount(count: number): number {
  if (count < 3) return 5;
  if (count < 6) return 10;
  if (count < 9) return 15;
  return 30;
}

let started = false;
let tickRunning = false; // overlap-guard — one tick at a time

export function startUnclaimedNotifier(client: Client): void {
  if (started) return;
  started = true;

  const tick = async () => {
    if (tickRunning) return; // skip if the previous tick is still working
    tickRunning = true;
    try {
      await runNotifyTick(client);
    } catch (err) {
      logger.error({ err }, "unclaimedNotifier tick failed");
    } finally {
      tickRunning = false;
    }
  };
  // First tick after 90s so the bot has time to fully boot and load guild
  // caches; subsequent ticks every TICK_MS.
  setTimeout(() => { tick(); setInterval(tick, TICK_MS).unref(); }, 90_000).unref();
  logger.info("Unclaimed-task notifier scheduler started");
}

async function runNotifyTick(client: Client): Promise<void> {
  // Pull every candidate task in one query. We filter the cadence in JS so we
  // don't have to embed the (count → interval) ladder into SQL.
  const r = await pool.query<{
    id: number;
    title: string;
    channel_message_id: string | null;
    unclaimed_notify_count: number;
    unclaimed_last_notify_at: Date | null;
    created_at: Date;
    campaign_id: number | null;
  }>(
    `SELECT id, title, channel_message_id,
            unclaimed_notify_count, unclaimed_last_notify_at, created_at,
            campaign_id
       FROM tasks
      WHERE status = 'open'
        AND slots_filled = 0
        AND unclaimed_notify_enabled = TRUE
        AND unclaimed_notify_count < $1
      LIMIT 200`,
    [MAX_BUMPS],
  );
  if (r.rowCount === 0) return;

  const now = Date.now();
  const dueIds: number[] = [];
  for (const row of r.rows) {
    const intervalMs = intervalMinutesForCount(Number(row.unclaimed_notify_count)) * 60_000;
    const lastTs = (row.unclaimed_last_notify_at ?? row.created_at).getTime();
    if (now - lastTs >= intervalMs) dueIds.push(row.id);
  }
  if (dueIds.length === 0) return;

  // Resolve the canonical guild + tasks channel once per tick. This bot is
  // single-guild in practice; using getPrimaryGuild() prevents the previous
  // "iterate every cached guild and post in the first one we find" bug that
  // could blast the wrong server.
  const primaryGuild: Guild | null = getPrimaryGuild();
  if (!primaryGuild) {
    logger.warn({ dueCount: dueIds.length }, "unclaimedNotifier: no primary guild yet, skipping tick");
    return;
  }
  let tasksChannel: TextChannel;
  try {
    const setup = await setupGuild(primaryGuild);
    tasksChannel = setup.tasksChannel as TextChannel;
  } catch (err) {
    logger.warn({ err, guildId: primaryGuild.id }, "unclaimedNotifier: setupGuild failed, skipping tick");
    return;
  }

  for (const taskId of dueIds) {
    try {
      // Atomic claim: bump count + stamp last_notify_at in a single statement
      // gated on the row still being unclaimed AND on the previous timestamp
      // we sampled (compare-and-swap on last_notify_at). If another tick (or a
      // real claim) raced us we skip silently and let the next tick re-evaluate.
      const snapshot = r.rows.find((x) => x.id === taskId);
      if (!snapshot) continue;

      const expectedLast = snapshot.unclaimed_last_notify_at;
      const expectedClause = expectedLast === null
        ? `unclaimed_last_notify_at IS NULL`
        : `unclaimed_last_notify_at = $3`;
      const params: any[] = [taskId, MAX_BUMPS];
      if (expectedLast !== null) params.push(expectedLast);

      const upd = await pool.query(
        `UPDATE tasks
            SET unclaimed_notify_count = unclaimed_notify_count + 1,
                unclaimed_last_notify_at = NOW()
          WHERE id = $1
            AND status = 'open'
            AND slots_filled = 0
            AND unclaimed_notify_enabled = TRUE
            AND unclaimed_notify_count < $2
            AND ${expectedClause}
          RETURNING *`,
        params,
      );
      if (upd.rowCount === 0) continue; // raced by another tick or real claim
      const taskRow = upd.rows[0];

      // Best-effort delete of the stale card so the re-post visibly bumps the
      // channel rather than stacking. Channel-not-found / message-gone is fine
      // (Discord may have purged it, or admin moved it).
      if (taskRow.channel_message_id) {
        await tasksChannel.messages
          .fetch(taskRow.channel_message_id)
          .then((m) => m.delete())
          .catch(() => {});
      }

      const camelTask: any = {
        ...taskRow,
        creatorDiscordId: taskRow.creator_discord_id,
        redditLink: taskRow.reddit_link,
        prewrittenComment: taskRow.prewritten_comment,
        timeLimitMinutes: taskRow.time_limit_minutes,
        maxSlots: taskRow.max_slots,
        slotsFilled: taskRow.slots_filled,
        imageUrl: taskRow.image_url,
        isHot: !!taskRow.is_hot,
        status: taskRow.status,
      };

      const bumpCount = Number(taskRow.unclaimed_notify_count);
      const progressEmbed = taskRow.campaign_id
        ? await buildCampaignProgressEmbed(taskRow.campaign_id)
        : null;
      const cardEmbed = buildPublicTaskEmbed(camelTask);
      const newMsg = await tasksChannel.send({
        content:
          `@here ⏰ **Still unclaimed!** Bumping Task #${taskRow.id} — ` +
          `**"${taskRow.title}"** to the top. Grab it before it closes!`,
        embeds: progressEmbed ? [cardEmbed, progressEmbed] : [cardEmbed],
        components: [buildPublicButtons(taskRow.id)],
        allowedMentions: { parse: ["everyone"] },
      });

      await pool.query(
        `UPDATE tasks SET channel_message_id = $1 WHERE id = $2`,
        [newMsg.id, taskRow.id],
      );

      logger.info(
        { taskId: taskRow.id, bumpCount, guildId: primaryGuild.id },
        "Unclaimed task re-bumped",
      );
    } catch (err) {
      logger.warn({ err, taskId }, "unclaimedNotifier: per-task bump failed");
    }
  }
}
