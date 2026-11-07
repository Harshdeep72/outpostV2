import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { recheckRedditLiveness } from "../bot/reddit-validator.js";
import { invalidateUser } from "../bot/cache.js";

interface PendingSub extends Record<string, unknown> {
  id: string;
  task_id: string;
  user_id: string;
  discord_id: string;
  discord_username: string;
  proof_link: string;
  review_status: string;
  live_status: string;
  reward: string;
  submitted_at: string;
  available_at: string | null;
  moved_to_available: number;
  balance_available: string;
  balance_pending: string;
  upi_id: string | null;
  paypal_email: string | null;
  gcash_number: string | null;
  crypto_wallets: any;
}

async function main() {
  const shouldApprove = process.argv.includes("--approve");
  console.log(`\n==================================================`);
  console.log(`  AUDITING PENDING / HOLD SUBMISSIONS (Mode: ${shouldApprove ? "APPROVE" : "DRY RUN"})`);
  console.log(`==================================================\n`);

  const query = sql`
    SELECT s.id, s.task_id, s.user_id, s.discord_id, s.proof_link, s.review_status, s.live_status,
           s.reward, s.submitted_at, s.available_at, s.moved_to_available,
           u.discord_username, u.balance_available, u.balance_pending,
           u.upi_id, u.paypal_email, u.gcash_number, u.crypto_wallets
      FROM submissions s
      JOIN users u ON u.id = s.user_id
     WHERE s.review_status IN ('pending', 'pending_hold', 'checking')
     ORDER BY s.id ASC;
  `;

  const res = await db.execute<PendingSub>(query);
  console.log(`Found ${res.rows.length} pending/hold submissions.\n`);

  const results: any[] = [];
  let liveCount = 0;
  let deletedCount = 0;
  let removedCount = 0;
  let unknownCount = 0;
  let totalLiveReward = 0;

  for (const row of res.rows) {
    const subId = row.id;
    const worker = row.discord_username;
    const link = row.proof_link;
    const reward = parseFloat(row.reward) || 1.0;

    // Detect payment info
    let method = "Not Set";
    let destination = "Not Set";
    if (row.upi_id) {
      method = "UPI";
      destination = row.upi_id;
    } else if (row.paypal_email) {
      method = "PayPal";
      destination = row.paypal_email;
    } else if (row.gcash_number) {
      method = "GCash";
      destination = row.gcash_number;
    } else if (row.crypto_wallets && typeof row.crypto_wallets === "object") {
      const entries = Object.entries(row.crypto_wallets);
      if (entries.length > 0) {
        const [coin, val] = entries[0]!;
        method = coin;
        destination = typeof val === "object" ? ((val as any)?.address ?? JSON.stringify(val)) : String(val);
      }
    }

    console.log(`[#${subId}] Worker: ${worker} | Checking: ${link} ...`);
    const check = await recheckRedditLiveness(link).catch((err) => ({
      liveStatus: "unknown" as const,
      statusLabel: err?.message || "error",
      detailedStatus: null,
      reason: String(err),
    }));

    const status = check.liveStatus;
    if (status === "live") {
      liveCount++;
      totalLiveReward += reward;
    } else if (status === "deleted") {
      deletedCount++;
    } else if (status === "removed") {
      removedCount++;
    } else {
      unknownCount++;
    }

    console.log(`  -> Status: ${status.toUpperCase()} (${check.statusLabel || "OK"}) | Reward: $${reward.toFixed(2)}`);

    results.push({
      id: subId,
      worker,
      discordId: row.discord_id,
      userId: row.user_id,
      proofLink: link,
      prevReviewStatus: row.review_status,
      prevLiveStatus: row.live_status,
      newLiveStatus: status,
      statusLabel: check.statusLabel,
      reason: check.reason,
      reward: reward,
      balanceAvailableBefore: parseFloat(row.balance_available) || 0,
      balancePendingBefore: parseFloat(row.balance_pending) || 0,
      paymentMethod: method,
      paymentDestination: destination,
    });

    if (shouldApprove) {
      if (status === "live") {
        // Approve submission
        await db.execute(sql`
          UPDATE submissions
             SET review_status = 'accepted',
                 live_status = 'live',
                 moved_to_available = 1,
                 paid_at = NOW(),
                 last_checked_at = NOW(),
                 review_reason = 'Early approved for payout by operator (verified live)'
           WHERE id = ${parseInt(subId)}
        `);

        // Credit user balance
        await db.execute(sql`
          UPDATE users
             SET balance_pending   = GREATEST(0, balance_pending - ${row.reward}::numeric),
                 balance_available = balance_available + ${row.reward}::numeric,
                 total_earned      = total_earned + ${row.reward}::numeric,
                 trust_score       = LEAST(1000, trust_score + 2),
                 last_task_completed_at = NOW()
           WHERE id = ${parseInt(row.user_id)}
        `);
        invalidateUser(row.discord_id, parseInt(row.user_id));
        console.log(`  [APPROVED] Credited $${reward.toFixed(2)} to ${worker}'s available balance.`);
      } else if (status === "deleted" || status === "removed") {
        // Mark rejected and deduct pending balance
        await db.execute(sql`
          UPDATE submissions
             SET review_status = 'rejected',
                 live_status = ${status},
                 last_checked_at = NOW(),
                 review_reason = ${`Comment is ${status} on Reddit: ${check.statusLabel || status}`}
           WHERE id = ${parseInt(subId)}
        `);

        await db.execute(sql`
          UPDATE users
             SET balance_pending = GREATEST(0, balance_pending - ${row.reward}::numeric)
           WHERE id = ${parseInt(row.user_id)}
        `);
        invalidateUser(row.discord_id, parseInt(row.user_id));
        console.log(`  [REJECTED] Marked ${status} and cleared pending reward for ${worker}.`);
      }
    }
  }

  console.log(`\n==================================================`);
  console.log(`  AUDIT SUMMARY`);
  console.log(`==================================================`);
  console.log(`Total Checked:   ${results.length}`);
  console.log(`Live:            ${liveCount} (Total Reward: $${totalLiveReward.toFixed(2)})`);
  console.log(`Deleted:         ${deletedCount}`);
  console.log(`Removed:         ${removedCount}`);
  console.log(`Unknown/Error:   ${unknownCount}`);
  console.log(`==================================================\n`);

  // Group live earnings by worker
  const liveByWorker = new Map<string, { worker: string; discordId: string; count: number; total: number; method: string; destination: string }>();
  for (const r of results) {
    if (r.newLiveStatus === "live") {
      let w = liveByWorker.get(r.worker);
      if (!w) {
        w = {
          worker: r.worker,
          discordId: r.discordId,
          count: 0,
          total: 0,
          method: r.paymentMethod,
          destination: r.paymentDestination,
        };
        liveByWorker.set(r.worker, w);
      }
      w.count++;
      w.total += r.reward;
    }
  }

  console.log(`--- Live Workers Summary ---`);
  for (const [worker, data] of liveByWorker.entries()) {
    console.log(`- ${worker}: ${data.count} tasks = $${data.total.toFixed(2)} | Payment: ${data.method} (${data.destination})`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
