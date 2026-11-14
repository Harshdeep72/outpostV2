import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import { runWeeklyPayouts } from "../bot/handlers/weeklyPayouts.js";
import { db, serverConfig } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { invalidateUser } from "../bot/cache.js";
import { tryCompleteReferral } from "../bot/db.js";
import { notifyReferralCompletion } from "../bot/handlers/referral.js";

const GUILD_ID = process.env.DISCORD_GUILD_ID || "1565314110621753495";
const WITHDRAWAL_LOG_CHANNEL_ID = "1565661347914453034";

// Verified live & deleted submission IDs from earlier audit
const LIVE_SUB_IDS = [395, 398, 404, 405, 406, 412, 413, 414, 415, 416];
const DELETED_SUB_IDS = [397, 399, 400, 401, 402, 403, 407, 408, 409, 410, 411, 417, 418, 419];

async function main() {
  console.log("=== STARTING REPROCESS PAYOUTS UNIFIED WORKFLOW ===\n");

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("ready", async () => {
    console.log(`Logged into Discord as ${client.user?.tag}`);

    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      console.log(`Connected to guild: ${guild.name} (${guild.id})`);

      const channel = (await guild.channels.fetch(WITHDRAWAL_LOG_CHANNEL_ID)) as TextChannel | null;
      if (!channel) throw new Error(`Could not find channel ${WITHDRAWAL_LOG_CHANNEL_ID}`);

      // ──────────────────────────────────────────────────────────────────────────
      // PHASE 1: Approve 10 Live Submissions & Reject 14 Deleted Submissions
      // ──────────────────────────────────────────────────────────────────────────
      console.log("\n--- Phase 1: Clearing 24 pending/hold submissions ---");

      // 1. Live submissions
      const liveRows = await db.execute<{ id: number; user_id: number; discord_id: string; reward: string }>(
        sql`SELECT id, user_id, discord_id, reward FROM submissions WHERE id IN (${sql.raw(LIVE_SUB_IDS.join(","))})`
      );

      for (const row of liveRows.rows) {
        const rewardNum = parseFloat(row.reward) || 1.0;
        await db.execute(sql`
          UPDATE submissions
             SET review_status = 'accepted',
                 live_status = 'live',
                 moved_to_available = 1,
                 paid_at = NOW(),
                 last_checked_at = NOW(),
                 review_reason = 'Early approved for payout by operator (verified live)'
           WHERE id = ${row.id}
        `);

        await db.execute(sql`
          UPDATE users
             SET balance_pending   = GREATEST(0, balance_pending - ${row.reward}::numeric),
                 balance_available = balance_available + ${row.reward}::numeric,
                 total_earned      = total_earned + ${row.reward}::numeric,
                 trust_score       = LEAST(1000, trust_score + 2)
           WHERE id = ${row.user_id}
        `);
        invalidateUser(row.discord_id, row.user_id);
        console.log(`  [APPROVED] Sub #${row.id} (Worker User #${row.user_id}, <@${row.discord_id}>): +$${rewardNum.toFixed(2)} to available balance`);

        try {
          const ref = await tryCompleteReferral(row.discord_id, row.user_id);
          if (ref && ref.completed) {
            await notifyReferralCompletion(guild, ref);
            console.log(`    -> Referral completed for <@${row.discord_id}>! Referrer rewarded.`);
          }
        } catch (err) {
          console.warn(`    -> Referral check non-fatal error:`, err);
        }
      }

      // 2. Deleted submissions
      const delRows = await db.execute<{ id: number; user_id: number; discord_id: string; reward: string }>(
        sql`SELECT id, user_id, discord_id, reward FROM submissions WHERE id IN (${sql.raw(DELETED_SUB_IDS.join(","))})`
      );

      for (const row of delRows.rows) {
        await db.execute(sql`
          UPDATE submissions
             SET review_status = 'rejected',
                 live_status = 'deleted',
                 last_checked_at = NOW(),
                 review_reason = 'Comment deleted on Reddit'
           WHERE id = ${row.id}
        `);

        await db.execute(sql`
          UPDATE users
             SET balance_pending = GREATEST(0, balance_pending - ${row.reward}::numeric)
           WHERE id = ${row.user_id}
        `);
        invalidateUser(row.discord_id, row.user_id);
        console.log(`  [REJECTED] Sub #${row.id} (Worker User #${row.user_id}, <@${row.discord_id}>): cleared $${row.reward} pending balance`);
      }

      console.log("Phase 1 complete: 10 accepted ($10 credited), 14 rejected.\n");

      // ──────────────────────────────────────────────────────────────────────────
      // PHASE 2: Revert Earlier Payout Batch (#93–#123) & Delete Messages
      // ──────────────────────────────────────────────────────────────────────────
      console.log("--- Phase 2: Reverting withdrawals #93–#123 and deleting old batch messages ---");

      // Query the pending withdrawals created today
      const currentPending = await db.execute<{ id: number; user_id: number; discord_id: string; amount: string; log_message_id: string | null }>(sql`
        SELECT id, user_id, discord_id, amount, log_message_id
          FROM withdrawals
         WHERE id >= 93 AND status = 'pending'
         ORDER BY id ASC
      `);

      console.log(`Found ${currentPending.rows.length} pending withdrawals to refund and revert.`);

      const messageIdsToDelete = new Set<string>();

      for (const w of currentPending.rows) {
        if (w.log_message_id) messageIdsToDelete.add(w.log_message_id);

        // Refund balance back to available
        await db.execute(sql`
          UPDATE users
             SET balance_available = balance_available + ${w.amount}::numeric
           WHERE id = ${w.user_id}
        `);
        invalidateUser(w.discord_id, w.user_id);
        console.log(`  - Refunded $${parseFloat(w.amount).toFixed(2)} back to user #${w.user_id} (<@${w.discord_id}>) from WD #${w.id}`);
      }

      // Fetch recent messages in withdrawal log to find header, cards, and summary
      console.log("Fetching recent channel messages from #withdrawal-log...");
      const recentMessages = await channel.messages.fetch({ limit: 100 });
      for (const [id, msg] of recentMessages) {
        if (msg.author.id === client.user?.id) {
          const ageHours = (Date.now() - msg.createdTimestamp) / (1000 * 60 * 60);
          // Messages created within last 6 hours
          if (ageHours < 6) {
            messageIdsToDelete.add(id);
          }
        }
      }

      console.log(`Deleting ${messageIdsToDelete.size} messages from #${channel.name}...`);
      for (const msgId of messageIdsToDelete) {
        try {
          const m = await channel.messages.fetch(msgId).catch(() => null);
          if (m) {
            await m.delete().catch(() => {});
            await new Promise((r) => setTimeout(r, 100)); // slight rate limit cushion
          }
        } catch (e) {
          // ignore
        }
      }
      console.log("Deleted old batch messages from Discord.");

      // Delete the old pending withdrawals records
      if (currentPending.rows.length > 0) {
        const ids = currentPending.rows.map((r) => r.id);
        await db.execute(sql`DELETE FROM withdrawals WHERE id IN (${sql.raw(ids.join(","))})`);
        console.log(`Deleted ${ids.length} old pending withdrawal records from DB.`);
      }

      // Reset last_weekly_payout_at in server_config so it doesn't block
      await db.execute(sql`
        UPDATE server_config
           SET last_weekly_payout_at = '2026-11-07 04:28:31.581+00'
         WHERE guild_id = ${GUILD_ID}
      `);

      console.log("Phase 2 complete!\n");

      // ──────────────────────────────────────────────────────────────────────────
      // PHASE 3: Run Fresh Consolidated Weekly Payouts
      // ──────────────────────────────────────────────────────────────────────────
      console.log("--- Phase 3: Triggering fresh runWeeklyPayouts(guild, true) ---");
      const result = await runWeeklyPayouts(guild, true);

      console.log("\n=== PAYOUT EXECUTION COMPLETED ===");
      console.log(`Processed Workers: ${result.processed}`);
      console.log(`Total Payout Amount: $${result.totalAmount.toFixed(2)}`);
      console.log(`Skipped (No Method): ${result.skipped}`);

      // Stamp lastWeeklyPayoutAt
      await db
        .update(serverConfig)
        .set({ lastWeeklyPayoutAt: new Date(), updatedAt: new Date() })
        .where(eq(serverConfig.guildId, GUILD_ID));
      console.log("Updated last_weekly_payout_at timestamp in server_config.");

    } catch (err) {
      console.error("Workflow failed with error:", err);
    } finally {
      client.destroy();
      console.log("Discord client connection closed. Exiting.");
      process.exit(0);
    }
  });

  await client.login(token);
}

main().catch((err) => {
  console.error("Fatal initialization error:", err);
  process.exit(1);
});
