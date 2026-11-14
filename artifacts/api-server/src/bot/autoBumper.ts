import { type Client, type TextChannel } from "discord.js";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { setupGuild } from "./setup.js";
import { getPrimaryGuild } from "./discord-client.js";
import { buildPublicTaskEmbed, buildPublicButtons, buildCampaignProgressEmbed } from "./task-creation.js";
import { getAutoBumpConfig } from "../lib/settings.js";

/**
 * Feature #9 — Dutch auction auto-bumper.
 *
 * Automatically raises the reward for tasks that remain unclaimed (slots_filled = 0).
 * Master configuration in Settings defines:
 *   - intervalMin (default 60m / 1 hour): bump after being unclaimed for this duration
 *   - percent (default 10%): reward increase per bump
 *   - capPercent (default 50%): max cumulative increase above original reward
 *
 * Individual tasks can still override these with per-task settings (auto_bump_percent > 0).
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
  setTimeout(() => { tick(); setInterval(tick, TICK_MS).unref(); }, 60 * 1000).unref();
  logger.info("Auto-bumper scheduler started");
}

async function runBumpTick(client: Client): Promise<void> {
  const cfg = await getAutoBumpConfig();
  if (!cfg.enabled) return;

  const defaultInterval = Math.max(5, cfg.intervalMin ?? 60);
  const defaultPercent = Math.max(1, cfg.percent ?? 10);
  const defaultCap = Math.max(5, cfg.capPercent ?? 50);

  // Find tasks that are: open, totally unclaimed (slots_filled = 0),
  // past their bump interval since last bump (or since creation if never bumped),
  // and not yet at cap.
  const r = await pool.query(
    `SELECT id, reward, original_reward,
            CASE WHEN auto_bump_percent > 0 THEN auto_bump_percent ELSE $1 END AS bump_percent,
            CASE WHEN auto_bump_percent > 0 THEN auto_bump_interval_min ELSE $2 END AS bump_interval_min,
            CASE WHEN auto_bump_percent > 0 THEN auto_bump_cap_percent ELSE $3 END AS bump_cap_percent,
            auto_bump_count, channel_message_id
       FROM tasks
      WHERE status = 'open'
        AND slots_filled = 0
        AND (
          (last_bump_at IS NULL AND created_at < NOW() - ((CASE WHEN auto_bump_percent > 0 THEN auto_bump_interval_min ELSE $2 END) || ' minutes')::interval)
          OR
          (last_bump_at IS NOT NULL AND last_bump_at < NOW() - ((CASE WHEN auto_bump_percent > 0 THEN auto_bump_interval_min ELSE $2 END) || ' minutes')::interval)
        )
        AND (original_reward IS NULL OR reward < (original_reward * (1 + (CASE WHEN auto_bump_percent > 0 THEN auto_bump_cap_percent ELSE $3 END) / 100.0)) - 0.001)
      LIMIT 100`,
    [defaultPercent, defaultInterval, defaultCap],
  );
  if (r.rowCount === 0) return;

  for (const row of r.rows) {
    try {
      const taskId: number = row.id;
      const currentReward = Number(row.reward);
      const originalReward = row.original_reward != null
        ? Number(row.original_reward)
        : currentReward; // first bump — seed from current reward
      const cap = originalReward * (1 + Number(row.bump_cap_percent) / 100);
      const proposed = currentReward * (1 + Number(row.bump_percent) / 100);
      if (proposed > cap + 0.001) {
        // Already at cap — stamp last_bump_at so we don't re-evaluate immediately
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

      // Edit or post the public #tasks card.
      const guild = getPrimaryGuild() ?? client.guilds.cache.first();
      if (guild) {
        try {
          const { tasksChannel } = await setupGuild(guild);
          const channel = tasksChannel as TextChannel;
          let msg = null;
          if (taskRow.channel_message_id) {
            msg = await channel.messages
              .fetch(taskRow.channel_message_id)
              .catch(() => null);
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
          embed.setFooter({ text: `Task #${taskId} — ↑ bumped ${taskRow.auto_bump_count}× (was $${currentReward.toFixed(2)})` });
          const progressEmbed = taskRow.campaign_id
            ? await buildCampaignProgressEmbed(taskRow.campaign_id)
            : null;

          if (msg) {
            await msg.edit({
              embeds: progressEmbed ? [embed, progressEmbed] : [embed],
              components: [buildPublicButtons(taskId, false)],
            });
          } else {
            const newMsg = await channel.send({
              embeds: progressEmbed ? [embed, progressEmbed] : [embed],
              components: [buildPublicButtons(taskId, false)],
            });
            await pool.query(
              `UPDATE tasks SET channel_message_id = $1 WHERE id = $2`,
              [newMsg.id, taskId],
            );
          }
        } catch (err) {
          logger.debug({ err, guildId: guild.id, taskId }, "autoBumper edit failed for guild");
        }
      }
    } catch (err) {
      logger.warn({ err, taskId: row.id }, "autoBumper: per-task bump failed");
    }
  }
}
