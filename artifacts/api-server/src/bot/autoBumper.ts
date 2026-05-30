import { type Client, type TextChannel } from "discord.js";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { setupGuild } from "./setup.js";
import { buildPublicTaskEmbed, buildPublicButtons, buildCampaignProgressEmbed } from "./task-creation.js";
import { getAutoBumpConfig } from "../lib/settings.js";

/**
 * Feature #9 — Dutch auction auto-bumper.
 *
 * For tasks with auto_bump_percent > 0 (admin opt-in), raise the reward by
 * that percent every auto_bump_interval_min if NO slots have been claimed
 * yet (slots_filled = 0). Stops bumping once cumulative bumps would exceed
 * auto_bump_cap_percent of the original reward.
 *
 * Defaults are off — auto_bump_percent column defaults to 0 so existing
 * tasks are never touched. New tasks also default to 0 unless explicitly
 * configured via POST /admin/tasks/:id/auto-bump.
 *
 * The cron edits the public #tasks embed to reflect the new reward and
 * appends a "↑ bumped Nx" footer note, then writes auto_bump_count,
 * last_bump_at, and the new reward back to the row.
 */
const TICK_MS = 5 * 60 * 1000; // 5 minutes

export function startAutoBumper(client: Client): void {
  const tick = async () => {
    try {
      await runBumpTick(client);
    } catch (err) {
      logger.error({ err }, "autoBumper tick failed");
    }
  };
  setTimeout(() => { tick(); setInterval(tick, TICK_MS).unref(); }, 3 * 60 * 1000).unref();
  logger.info("Auto-bumper scheduler started");
}

async function runBumpTick(client: Client): Promise<void> {
  // Master kill-switch — when the admin toggles auto-bump off in Settings,
  // the cron skips the entire tick even if individual tasks have
  // auto_bump_percent > 0. Defaults to off.
  const cfg = await getAutoBumpConfig();
  if (!cfg.enabled) return;

  // Find tasks that are: opted in, open, totally unclaimed, past their
  // bump interval since last bump (or since creation if never bumped), and
  // not yet at the cap.
  const r = await pool.query(
    `SELECT id, reward, original_reward, auto_bump_percent, auto_bump_interval_min,
            auto_bump_cap_percent, auto_bump_count, channel_message_id
       FROM tasks
      WHERE status = 'open'
        AND slots_filled = 0
        AND auto_bump_percent > 0
        AND (last_bump_at IS NULL
             AND created_at < NOW() - (auto_bump_interval_min || ' minutes')::interval
          OR  last_bump_at IS NOT NULL
             AND last_bump_at < NOW() - (auto_bump_interval_min || ' minutes')::interval)
      LIMIT 100`,
  );
  if (r.rowCount === 0) return;

  for (const row of r.rows) {
    try {
      const taskId: number = row.id;
      const currentReward = Number(row.reward);
      const originalReward = row.original_reward != null
        ? Number(row.original_reward)
        : currentReward; // first bump — seed from current reward
      const cap = originalReward * (1 + Number(row.auto_bump_cap_percent) / 100);
      const proposed = currentReward * (1 + Number(row.auto_bump_percent) / 100);
      if (proposed > cap + 0.001) {
        // Already at cap — disable further bumps quietly by setting last_bump_at
        // so we don't re-evaluate every tick.
        await pool.query(
          `UPDATE tasks SET last_bump_at = NOW() WHERE id = $1`,
          [taskId],
        );
        continue;
      }
      const newReward = Math.min(proposed, cap);

      // Update DB first — if the message edit fails the bump is still recorded
      // and we won't double-bump on the next tick.
      const upd = await pool.query(
        `UPDATE tasks
            SET reward          = $2,
                original_reward = COALESCE(original_reward, $3),
                auto_bump_count = auto_bump_count + 1,
                last_bump_at    = NOW()
          WHERE id = $1 AND status = 'open' AND slots_filled = 0
          RETURNING *`,
        [taskId, newReward.toFixed(2), originalReward.toFixed(2)],
      );
      if (upd.rowCount === 0) continue; // someone claimed between SELECT and UPDATE

      const taskRow = upd.rows[0];
      logger.info(
        { taskId, oldReward: currentReward, newReward, bumpCount: taskRow.auto_bump_count },
        "Task reward auto-bumped",
      );

      // Edit the public #tasks card.
      if (taskRow.channel_message_id) {
        for (const guild of client.guilds.cache.values()) {
          try {
            const { tasksChannel } = await setupGuild(guild);
            const msg = await (tasksChannel as TextChannel).messages
              .fetch(taskRow.channel_message_id)
              .catch(() => null);
            if (!msg) continue;
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
            embed.setFooter({ text: `Task #${taskId} — ↑ bumped ${taskRow.auto_bump_count}× (was $${currentReward.toFixed(2)})` });
            const progressEmbed = taskRow.campaign_id
              ? await buildCampaignProgressEmbed(taskRow.campaign_id)
              : null;
            await msg.edit({
              embeds: progressEmbed ? [embed, progressEmbed] : [embed],
              components: [buildPublicButtons(taskId, false)],
            });
            break; // task lives in one guild's tasks channel
          } catch (err) {
            logger.debug({ err, guildId: guild.id, taskId }, "autoBumper edit failed for guild");
          }
        }
      }
    } catch (err) {
      logger.warn({ err, taskId: row.id }, "autoBumper: per-task bump failed");
    }
  }
}
