import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { type Client } from "discord.js";
import { logger } from "../lib/logger.js";
import { TASK_REMINDER_MINUTES_BEFORE_EXPIRY, COLORS } from "./constants.js";
import { makeEmbed } from "./util.js";

let started = false;

export function startExpiryReminder(client: Client) {
  if (started) return;
  started = true;

  setInterval(async () => {
    try {
      const now = new Date();
      const windowEnd = new Date(now.getTime() + TASK_REMINDER_MINUTES_BEFORE_EXPIRY * 60_000);

      // Atomic claim-and-flag in a single statement so overlapping ticks can never
      // pick up the same row twice. Only rows whose reminder_sent is flipped from
      // 0 -> 1 by THIS statement are returned; any concurrent tick gets nothing.
      const rows = await db.execute<{
        id: string;
        discord_id: string;
        task_id: string;
        expires_at: string;
      }>(
        sql`UPDATE claims
            SET reminder_sent = 1
            WHERE id IN (
              SELECT id FROM claims
              WHERE status = 'claimed'
                AND reminder_sent = 0
                AND expires_at IS NOT NULL
                AND expires_at > ${now}
                AND expires_at <= ${windowEnd}
              ORDER BY expires_at ASC
              LIMIT 100
              FOR UPDATE SKIP LOCKED
            )
            RETURNING id, discord_id, task_id, expires_at`
      );

      for (const row of rows.rows) {
        const claimId = parseInt(row.id);

        let title = `Task #${row.task_id}`;
        try {
          const t = await db.execute<{ title: string }>(
            sql`SELECT title FROM tasks WHERE id = ${parseInt(row.task_id)} LIMIT 1`
          );
          if (t.rows[0]?.title) title = t.rows[0].title;
        } catch {}

        const expiresUnix = Math.floor(new Date(row.expires_at).getTime() / 1000);

        try {
          const user = await client.users.fetch(row.discord_id);
          await user.send({
            embeds: [
              makeEmbed(COLORS.WARNING)
                .setTitle("⏰ Claim Expiry Reminder")
                .setDescription(
                  `Your claim on **${title}** expires <t:${expiresUnix}:R>.\n\n` +
                  `Submit your proof **before time runs out** or you'll lose the slot!`
                )
            ],
          });
        } catch {
          logger.warn({ discordId: row.discord_id, claimId }, "Could not DM expiry reminder");
        }
      }

      if (rows.rows.length > 0) {
        logger.info({ count: rows.rows.length }, "Expiry reminders sent");
      }
    } catch (err) {
      logger.error({ err }, "Expiry reminder error");
    }
  }, 60_000);
}
