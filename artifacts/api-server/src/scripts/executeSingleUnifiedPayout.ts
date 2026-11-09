import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import { runWeeklyPayouts } from "../bot/handlers/weeklyPayouts.js";
import { db, serverConfig } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { invalidateUser } from "../bot/cache.js";

const GUILD_ID = process.env.DISCORD_GUILD_ID || "1565314110621753495";
const WITHDRAWAL_LOG_CHANNEL_ID = "1565661347914453034";

const LIVE_SUB_IDS = [221, 222, 223, 224, 225, 226, 229, 231, 232, 234, 235, 236, 237, 238];
const DELETED_SUB_IDS = [162, 219, 227, 230, 233];

async function main() {
  console.log("=== STARTING SINGLE UNIFIED PAYOUT WORKFLOW ===\n");

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 1: Update Submissions in DB
  // ──────────────────────────────────────────────────────────────────────────
  console.log("Phase 1: Approving 14 live submissions and rejecting 5 deleted submissions...");

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
    console.log(`  - Approved Sub #${row.id} (Worker User #${row.user_id}): +$${rewardNum.toFixed(2)} to available balance`);
  }

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
    console.log(`  - Rejected Sub #${row.id} (Worker User #${row.user_id}): Cleared $${row.reward} pending balance`);
  }

  console.log("Phase 1 complete!\n");

  // ──────────────────────────────────────────────────────────────────────────
  // PHASE 2: Discord Client Initialization & Revert Previous Batch
  // ──────────────────────────────────────────────────────────────────────────
  console.log("Phase 2: Connecting Discord client to revert previous run & delete old messages...");
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  client.once("ready", async () => {
    console.log(`Logged into Discord as ${client.user?.tag}`);

    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      console.log(`Connected to guild: ${guild.name} (${guild.id})`);

      const channel = (await guild.channels.fetch(WITHDRAWAL_LOG_CHANNEL_ID)) as TextChannel | null;
      if (!channel) throw new Error(`Could not find channel ${WITHDRAWAL_LOG_CHANNEL_ID}`);

      // 1. Fetch current pending withdrawals (IDs 31..59)
      const currentPending = await db.execute<{ id: number; user_id: number; discord_id: string; amount: string; log_message_id: string | null }>(sql`
        SELECT id, user_id, discord_id, amount, log_message_id
          FROM withdrawals
         WHERE status = 'pending'
         ORDER BY id ASC
      `);

      console.log(`Found ${currentPending.rows.length} pending withdrawals to refund and revert.`);

      const messageIdsToDelete = new Set<string>();

      for (const w of currentPending.rows) {
        if (w.log_message_id) messageIdsToDelete.add(w.log_message_id);

        // Refund balance
        await db.execute(sql`
          UPDATE users
             SET balance_available = balance_available + ${w.amount}::numeric
           WHERE id = ${w.user_id}
        `);
        invalidateUser(w.discord_id, w.user_id);
      }

      // Fetch recent messages in withdrawal log to find header and summary messages
      console.log("Fetching recent channel messages to purge batch header/footer...");
      const recentMessages = await channel.messages.fetch({ limit: 100 });
      for (const [id, msg] of recentMessages) {
        if (msg.author.id === client.user?.id) {
          const ageHours = (Date.now() - msg.createdTimestamp) / (1000 * 60 * 60);
          if (ageHours < 2) {
            messageIdsToDelete.add(id);
          }
        }
      }

      console.log(`Deleting ${messageIdsToDelete.size} old batch messages from #${channel.name}...`);
      for (const msgId of messageIdsToDelete) {
        try {
          const m = await channel.messages.fetch(msgId).catch(() => null);
          if (m) await m.delete().catch(() => {});
        } catch {
          // ignore
        }
      }
      console.log("Old batch messages deleted successfully.");

      // Delete the pending withdrawals rows so we have a clean slate
      if (currentPending.rows.length > 0) {
        const ids = currentPending.rows.map((r) => r.id);
        await db.execute(sql`DELETE FROM withdrawals WHERE id IN (${sql.raw(ids.join(","))})`);
        console.log(`Deleted ${ids.length} old pending withdrawal records.`);
      }

      // ──────────────────────────────────────────────────────────────────────────
      // PHASE 3: Execute Fresh Single Unified Weekly Payout
      // ──────────────────────────────────────────────────────────────────────────
      console.log("\nPhase 3: Triggering fresh unified runWeeklyPayouts(guild, true)...");
      const result = await runWeeklyPayouts(guild, true);
      console.log("\n=== PAYOUT EXECUTION COMPLETED ===");
      console.log(`Processed Workers: ${result.processed}`);
      console.log(`Total Payout Amount: $${result.totalAmount.toFixed(2)}`);
      console.log(`Skipped (No Method): ${result.skipped}`);

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
