import { type Client, type TextChannel } from "discord.js";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { setupGuild } from "./setup.js";
import { getPrimaryGuild } from "./discord-client.js";
import { buildPublicTaskEmbed, buildPublicButtons, buildCampaignProgressEmbed } from "./task-creation.js";
import { getAutoBumpConfig } from "../lib/settings.js";

/**
 * Auto-bumper for unclaimed tasks in Discord.
 *
 * For tasks left unclaimed (slots_filled = 0, status = 'open') for the configured
 * interval (default: 60 minutes / 1 hour), re-posts the task card to the bottom
 * of the #tasks channel with an @here ping to bring it back to workers' attention.
 *
 * NOTE: Rewards are strictly NEVER modified (flat $1.00/comment rate preserved).
 */
const TICK_MS = 60_000; // Check every 60s
const MAX_BUMPS = 12;   // Safety cap: up to 12 bumps per task

export function startAutoBumper(client: Client): void {
  const tick = async () => {
    try {
      await runBumpTick(client);
    } catch (err) {
      logger.error({ err }, "autoBumper tick failed");
    }
  };
  setTimeout(() => { tick(); setInterval(tick, TICK_MS).unref(); }, 60 * 1000).unref();
  logger.info("Auto-bumper scheduler started");
}

async function runBumpTick(client: Client): Promise<void> {
  const cfg = await getAutoBumpConfig();
  if (!cfg.enabled) return;

  const intervalMin = Math.max(5, cfg.intervalMin ?? 60);

  // Find open tasks that have 0 slots claimed and have been unclaimed for >= intervalMin
  // (either since creation if never bumped, or since last bump).
  const r = await pool.query(
    `SELECT id, title, reward, slots_filled, max_slots, channel_message_id,
            auto_bump_count, last_bump_at, created_at, campaign_id,
            creator_discord_id, reddit_link, prewritten_comment,
            time_limit_minutes, image_url, is_hot, status, instructions, type
       FROM tasks
      WHERE status = 'open'
        AND slots_filled = 0
        AND auto_bump_count < $1
        AND (
          (last_bump_at IS NULL AND created_at < NOW() - ($2 || ' minutes')::interval)
          OR
          (last_bump_at IS NOT NULL AND last_bump_at < NOW() - ($2 || ' minutes')::interval)
        )
      LIMIT 50`,
    [MAX_BUMPS, intervalMin],
  );
  if (r.rowCount === 0) return;

  const guild = getPrimaryGuild() ?? client.guilds.cache.first();
  if (!guild) return;

  let tasksChannel: TextChannel;
  try {
    const setup = await setupGuild(guild);
    tasksChannel = setup.tasksChannel as TextChannel;
  } catch (err) {
    logger.warn({ err, guildId: guild.id }, "autoBumper: setupGuild failed, skipping tick");
    return;
  }

  for (const row of r.rows) {
    try {
      const taskId: number = row.id;

      // Update bump count and timestamp without touching reward
      const upd = await pool.query(
        `UPDATE tasks
            SET auto_bump_count = auto_bump_count + 1,
                last_bump_at    = NOW()
          WHERE id = $1 AND status = 'open' AND slots_filled = 0
          RETURNING *`,
        [taskId],
      );
      if (upd.rowCount === 0) continue; // someone claimed between SELECT and UPDATE

      const taskRow = upd.rows[0];
      logger.info(
        { taskId, bumpCount: taskRow.auto_bump_count },
        "Unclaimed task bumped in #tasks channel",
      );

      // Best-effort delete of previous card to keep the channel clean
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
      const embed = buildPublicTaskEmbed(camelTask);
      embed.setFooter({
        text: `Task #${taskId} — ⏰ Still unclaimed (Bump #${taskRow.auto_bump_count})`,
      });
      const progressEmbed = taskRow.campaign_id
        ? await buildCampaignProgressEmbed(taskRow.campaign_id)
        : null;

      const newMsg = await tasksChannel.send({
        content: `@here ⏰ **Still unclaimed!** Bumping Task #${taskId} — **"${taskRow.title}"** to the top. Grab it before it closes!`,
        embeds: progressEmbed ? [embed, progressEmbed] : [embed],
        components: [buildPublicButtons(taskId, false)],
        allowedMentions: { parse: ["everyone"] },
      });

      await pool.query(
        `UPDATE tasks SET channel_message_id = $1 WHERE id = $2`,
        [newMsg.id, taskId],
      );
    } catch (err) {
      logger.warn({ err, taskId: row.id }, "autoBumper: bump failed for task");
    }
  }
}
