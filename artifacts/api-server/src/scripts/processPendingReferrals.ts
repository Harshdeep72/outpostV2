import { db, users, referrals, redditAccounts } from "@workspace/db";
import { sql } from "drizzle-orm";
import { invalidateUser } from "../bot/cache.js";
import { REFERRAL_TIER1_REWARD, REFERRAL_TIER1_MIN_KARMA, REFERRAL_TIER1_MIN_AGE_DAYS, REFERRAL_TIER2_REWARD, REFERRAL_TIER2_MIN_KARMA, REFERRAL_TIER2_MIN_AGE_DAYS } from "../bot/constants.js";

async function completeReferralManually(referredDiscordId: string, name: string) {
  console.log(`\nChecking referral for ${name} (${referredDiscordId})...`);

  // 1. Get referral row
  const refRes = await db.execute<{ id: number; referrer_discord_id: string; status: string; reward_paid: boolean }>(sql`
    SELECT id, referrer_discord_id, status, reward_paid 
      FROM referrals 
     WHERE referred_discord_id = ${referredDiscordId}
  `);

  const ref = refRes.rows[0];
  if (!ref) {
    console.log(`  -> No referral row found.`);
    return;
  }
  if (ref.reward_paid || ref.status === "completed") {
    console.log(`  -> Already completed/paid.`);
    return;
  }

  // 2. Check submissions
  const subRes = await db.execute<{ id: number; submitted_at: string; paid_at: string }>(sql`
    SELECT id, submitted_at, paid_at
      FROM submissions
     WHERE discord_id = ${referredDiscordId}
       AND review_status = 'accepted'
       AND moved_to_available = 1
       AND live_status = 'live'
     ORDER BY id ASC
     LIMIT 1
  `);

  if (subRes.rows.length === 0) {
    console.log(`  -> No accepted live submission with moved_to_available = 1.`);
    return;
  }
  console.log(`  -> Valid live submission found: #${subRes.rows[0].id}`);

  // 3. Check Reddit account age and karma
  const accRes = await db.execute<{ account_age_days: number; post_karma: number; comment_karma: number }>(sql`
    SELECT account_age_days, post_karma, comment_karma 
      FROM reddit_accounts 
     WHERE discord_id = ${referredDiscordId}
     ORDER BY (post_karma + comment_karma) DESC
     LIMIT 1
  `);

  const acc = accRes.rows[0];
  const karma = (acc?.post_karma ?? 0) + (acc?.comment_karma ?? 0);
  const ageDays = acc?.account_age_days ?? 0;
  console.log(`  -> Reddit stats: ${karma} karma, ${ageDays} days old`);

  let calculatedReward = "0.00";
  let tier = 0;
  if (karma >= REFERRAL_TIER1_MIN_KARMA && ageDays >= REFERRAL_TIER1_MIN_AGE_DAYS) {
    calculatedReward = REFERRAL_TIER1_REWARD; // 1.00
    tier = 1;
  } else if (karma >= REFERRAL_TIER2_MIN_KARMA && ageDays >= REFERRAL_TIER2_MIN_AGE_DAYS) {
    calculatedReward = REFERRAL_TIER2_REWARD; // 0.50
    tier = 2;
  }

  if (tier === 0) {
    console.log(`  -> Did not meet Tier 1 or Tier 2 requirements.`);
    return;
  }

  console.log(`  -> Qualified for Tier ${tier}! Reward amount: $${calculatedReward}`);

  const shouldExecute = process.argv.includes("--apply");
  if (!shouldExecute) {
    console.log(`  [DRY RUN] Would credit $${calculatedReward} to referrer <@${ref.referrer_discord_id}>.`);
    return;
  }

  // Update referrals table
  await db.execute(sql`
    UPDATE referrals
       SET status = 'completed',
           reward_paid = true,
           reward_amount = ${calculatedReward}::numeric,
           task_completed_at = NOW()
     WHERE id = ${ref.id}
  `);

  // Credit referrer user
  await db.execute(sql`
    UPDATE users
       SET referral_earnings = referral_earnings + ${calculatedReward}::numeric,
           total_earned      = total_earned + ${calculatedReward}::numeric,
           balance_available = balance_available + ${calculatedReward}::numeric
     WHERE discord_id = ${ref.referrer_discord_id}
  `);

  invalidateUser(ref.referrer_discord_id);
  console.log(`  ✅ [SUCCESS] Credited $${calculatedReward} to referrer <@${ref.referrer_discord_id}>!`);
}

async function main() {
  await completeReferralManually("967771117504856077", "mikay2584");
  await completeReferralManually("198797926674202637", "aaladotcom");
  process.exit(0);
}

main().catch(console.error);
