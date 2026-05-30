import { sql } from "drizzle-orm";
import { db, tasks } from "@workspace/db";
import { eq } from "drizzle-orm";
import { type Client, type TextChannel } from "discord.js";
import { logger } from "../lib/logger.js";
import { invalidateTask, invalidateClaim } from "./cache.js";
import { setupGuild } from "./setup.js";
import { buildPublicTaskEmbed, buildPublicButtons, buildCampaignProgressEmbed, refreshCampaignSummary } from "./task-creation.js";
import { makeEmbed } from "./util.js";
import { COLORS } from "./constants.js";
import { getPrimaryGuild } from "./discord-client.js";

let started = false;

export function startClaimExpirer(client: Client) {
  if (started) return;
  started = true;

  setInterval(async () => {
    try {
      const now = new Date();
      // Atomic transition: only rows whose status is still 'claimed' get
      // flipped to 'expired'. Without this guard, two concurrent ticks (or
      // a manual admin expire racing the cron) could both "expire" the same
      // claim and double-decrement slots_filled, leaving the task with
      // drifted slot counts.
      const rows = await db.execute<{ id: string; discord_id: string; task_id: string }>(
        sql`UPDATE claims
              SET status = 'expired'
            WHERE status = 'claimed'
              AND expires_at <= ${now}
              AND id IN (
                SELECT id FROM claims
                 WHERE status = 'claimed' AND expires_at <= ${now}
                 LIMIT 100
                 FOR UPDATE SKIP LOCKED
              )
        RETURNING id, discord_id, task_id`
      );

      for (const row of rows.rows) {
        const claimId = parseInt(row.id);
        const taskId = parseInt(row.task_id);
        // The slot decrement is now safe to do unconditionally — this row
        // was atomically transitioned above, so we own exactly one slot
        // release for it.
        await db.execute(
          sql`UPDATE tasks SET slots_filled = GREATEST(0, slots_filled - 1) WHERE id = ${taskId}`
        );
        // Refresh merge-mode summary (slot freed by timeout). Best-effort —
        // wrapped to never abort the rest of the expirer loop.
        try {
          const [tRow] = await db.select({ campaignId: tasks.campaignId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
          if (tRow?.campaignId) void refreshCampaignSummary(tRow.campaignId);
        } catch { /* swallow */ }
        // Permanent re-claim block — this user can't grab this specific task
        // again. ON CONFLICT DO NOTHING makes the write idempotent if the same
        // (task, user) pair somehow flows through here twice.
        await db.execute(
          sql`INSERT INTO task_claim_blocks (task_id, discord_id, reason)
              VALUES (${taskId}, ${row.discord_id}, 'claim_expired')
              ON CONFLICT (task_id, discord_id) DO NOTHING`
        );
        invalidateClaim(claimId);
        invalidateTask(taskId);

        // Re-post the freed task to #tasks: refresh the existing public card
        // (Claim button re-enabled) and send a small ping so members notice.
        try {
          const guild = getPrimaryGuild();
          if (guild) {
            const [refreshed] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
            if (refreshed && refreshed.status === "open" && refreshed.slotsFilled < refreshed.maxSlots) {
              const { tasksChannel } = await setupGuild(guild);
              const reopenEmbed = makeEmbed(COLORS.PRIMARY)
                .setTitle("🔄 Slot Reopened")
                .setDescription(
                  `**Task #${refreshed.id}** — **${refreshed.title}**\n\n` +
                  `A claim expired without a submission, so the slot is back. Grab it!`
                );
              let reopenSent = false;
              if (refreshed.channelMessageId) {
                try {
                  const msg = await (tasksChannel as TextChannel).messages.fetch(refreshed.channelMessageId);
                  const card = buildPublicTaskEmbed(refreshed);
                  const prog = refreshed.campaignId
                    ? await buildCampaignProgressEmbed(refreshed.campaignId)
                    : null;
                  await msg.edit({
                    embeds: prog ? [card, prog] : [card],
                    components: [buildPublicButtons(refreshed.id, false)],
                  });
                  // Reply to the original task card so members get a clickable
                  // jump-link back to the actual task instead of a standalone
                  // ping floating in the channel.
                  await msg.reply({
                    embeds: [reopenEmbed],
                    allowedMentions: { repliedUser: false, parse: [] },
                  }).catch(() => {});
                  reopenSent = true;
                } catch (err) {
                  logger.warn({ err, taskId }, "Could not refresh public task message after expiry");
                }
              }
              // Fallback when the original task message is gone (channel
              // cleanup, deleted card, etc) — still notify so the slot
              // doesn't sit silently.
              if (!reopenSent) {
                await (tasksChannel as TextChannel).send({
                  embeds: [reopenEmbed],
                  allowedMentions: { parse: [] },
                }).catch(() => {});
              }
            }
          }
        } catch (err) {
          logger.warn({ err, taskId }, "Failed to repost expired task to channel");
        }

        try {
          const user = await client.users.fetch(row.discord_id);
          await user.send({
            embeds: [
              makeEmbed(COLORS.WARNING)
                .setTitle("⏱️ Claim Expired")
                .setDescription(
                  `Your 15-minute claim on **Task #${taskId}** expired and the slot is back in #tasks.\n\n` +
                  `**You can't reclaim this specific task** — pick a different one.\n` +
                  `If this was a mistake, ping an admin to unblock you.`
                )
            ],
          });
        } catch {
          logger.warn({ discordId: row.discord_id }, "Could not DM user on claim expiry");
        }
      }

      if (rows.rows.length > 0) {
        logger.info({ count: rows.rows.length }, "Claims expired");
      }
    } catch (err) {
      logger.error({ err }, "Claim expirer error");
    }
  }, 60_000);
}
