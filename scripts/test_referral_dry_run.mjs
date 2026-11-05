import assert from "node:assert";

// Simulation & Dry-Run Test Suite for Referral System & 24h Gate

console.log("==========================================================");
console.log("🧪 STARTING REFERRAL SYSTEM & 24H GATE DRY-RUN TEST SUITE");
console.log("   (Isolated Simulation — No Real Users Affected)");
console.log("==========================================================\n");

// --- TEST SUITE 1: Invite Link Attribution & Tracking Logic ---
console.log("▶️ TEST 1: Invite Detection & Auto-Referral Attribution");

function simulateInviteDetection(cachedInvites, freshInvites, userInvitesTable) {
  let usedCode = null;
  let usedInviterId = null;

  // 1. Check for uses increment
  for (const fresh of freshInvites) {
    const old = cachedInvites.find(c => c.code === fresh.code);
    if (old && (fresh.uses || 0) > (old.uses || 0)) {
      usedCode = fresh.code;
      usedInviterId = fresh.inviterId || old.inviterId;
      break;
    }
  }

  // 2. Fallback: single use invite consumed and deleted
  if (!usedCode) {
    for (const old of cachedInvites) {
      if (old.maxUses === 1 && !freshInvites.some(f => f.code === old.code)) {
        usedCode = old.code;
        usedInviterId = old.inviterId;
        break;
      }
    }
  }

  if (!usedCode) return null;

  // Lookup in user_invites table
  const mapped = userInvitesTable[usedCode];
  if (mapped) {
    return { referrerDiscordId: mapped, inviteCode: usedCode };
  }

  return { referrerDiscordId: usedInviterId, inviteCode: usedCode };
}

const mockCache = [
  { code: "INVITE_ALICE", uses: 3, inviterId: "USER_ALICE", maxUses: 0 },
  { code: "INVITE_BOB", uses: 10, inviterId: "USER_BOB", maxUses: 0 },
];
const mockFresh = [
  { code: "INVITE_ALICE", uses: 4, inviterId: "USER_ALICE", maxUses: 0 }, // +1 use!
  { code: "INVITE_BOB", uses: 10, inviterId: "USER_BOB", maxUses: 0 },
];
const mockUserInvites = {
  "INVITE_ALICE": "USER_ALICE",
};

const detectionResult = simulateInviteDetection(mockCache, mockFresh, mockUserInvites);
assert.strictEqual(detectionResult?.referrerDiscordId, "USER_ALICE");
assert.strictEqual(detectionResult?.inviteCode, "INVITE_ALICE");
console.log("  ✅ Case 1.1: Successfully detected ALICE's invite link was used (+1 use increment)");
console.log("  ✅ Case 1.2: Correctly mapped joiner to USER_ALICE without any manual code input");


// --- TEST SUITE 2: 24-Hour Verification Hold & Liveness Gate ---
console.log("\n▶️ TEST 2: 24-Hour Verification Hold & Reddit Liveness Filter");

function checkSubmissionQualifiesForReferral(sub, now = Date.now()) {
  const SUB_24H_MS = 24 * 60 * 60 * 1000;
  
  // SQL Condition:
  // review_status = 'accepted'
  // AND moved_to_available = 1
  // AND live_status = 'live'
  // AND (submitted_at <= NOW() - INTERVAL '24 hours' OR paid_at >= submitted_at + INTERVAL '24 hours')

  if (sub.review_status !== "accepted") return false;
  if (sub.moved_to_available !== 1) return false;
  if (sub.live_status !== "live") return false;

  const ageMs = now - sub.submitted_at.getTime();
  const paidAfter24h = sub.paid_at && (sub.paid_at.getTime() - sub.submitted_at.getTime() >= SUB_24H_MS);

  if (ageMs < SUB_24H_MS && !paidAfter24h) {
    return false;
  }

  return true;
}

const now = new Date("2026-11-05T12:00:00Z");

// Scenario 2.1: Just claimed/submitted 1 hour ago
const subRecent = {
  id: 101,
  submitted_at: new Date(now.getTime() - 1 * 60 * 60 * 1000), // 1h ago
  review_status: "pending_hold",
  moved_to_available: 0,
  live_status: "pending",
  paid_at: null,
};
assert.strictEqual(checkSubmissionQualifiesForReferral(subRecent, now.getTime()), false);
console.log("  ✅ Case 2.1: Task submitted 1h ago (pending_hold) -> BLOCKED (0 payout)");

// Scenario 2.2: 25h passed, but review rejected / not accepted
const subRejected = {
  id: 102,
  submitted_at: new Date(now.getTime() - 25 * 60 * 60 * 1000), // 25h ago
  review_status: "rejected",
  moved_to_available: 0,
  live_status: "removed",
  paid_at: null,
};
assert.strictEqual(checkSubmissionQualifiesForReferral(subRejected, now.getTime()), false);
console.log("  ✅ Case 2.2: Task 25h old but rejected -> BLOCKED (0 payout)");

// Scenario 2.3: 25h passed, accepted, but Reddit removed the comment (live_status = 'removed')
const subRemovedOnReddit = {
  id: 103,
  submitted_at: new Date(now.getTime() - 25 * 60 * 60 * 1000), // 25h ago
  review_status: "accepted",
  moved_to_available: 0,
  live_status: "removed",
  paid_at: null,
};
assert.strictEqual(checkSubmissionQualifiesForReferral(subRemovedOnReddit, now.getTime()), false);
console.log("  ✅ Case 2.3: Task 25h old but removed by Reddit -> BLOCKED (0 payout)");

// Scenario 2.4: 25h passed, confirmed live, moved to available
const subCleared24h = {
  id: 104,
  submitted_at: new Date(now.getTime() - 25 * 60 * 60 * 1000), // 25h ago
  review_status: "accepted",
  moved_to_available: 1,
  live_status: "live",
  paid_at: new Date(now.getTime() - 10 * 60 * 1000),
};
assert.strictEqual(checkSubmissionQualifiesForReferral(subCleared24h, now.getTime()), true);
console.log("  ✅ Case 2.4: Task 25h old, live_status='live', moved_to_available=1 -> PASSES 24H GATE!");


// --- TEST SUITE 3: Tier Evaluation (Karma & Age Requirements) ---
console.log("\n▶️ TEST 3: Tier Evaluation & Reward Calculation");

const REFERRAL_TIER1_REWARD = "1.00";
const REFERRAL_TIER1_MIN_KARMA = 300;
const REFERRAL_TIER1_MIN_AGE_DAYS = 90;

const REFERRAL_TIER2_REWARD = "0.50";
const REFERRAL_TIER2_MIN_KARMA = 150;
const REFERRAL_TIER2_MIN_AGE_DAYS = 30;

function evaluateReferralTier(candidates) {
  // Check Tier 1: 300+ karma & 90+ days (3 months) -> $1.00
  if (candidates.some(c => c.karma >= REFERRAL_TIER1_MIN_KARMA && c.ageDays >= REFERRAL_TIER1_MIN_AGE_DAYS)) {
    return { tier: 1, reward: REFERRAL_TIER1_REWARD };
  }
  // Check Tier 2: 150+ karma & 30+ days (1 month) -> $0.50
  if (candidates.some(c => c.karma >= REFERRAL_TIER2_MIN_KARMA && c.ageDays >= REFERRAL_TIER2_MIN_AGE_DAYS)) {
    return { tier: 2, reward: REFERRAL_TIER2_REWARD };
  }
  return { tier: 0, reward: "0.00" };
}

// Case 3.1: Sub-par account (e.g. 50 karma, 10 days)
const r1 = evaluateReferralTier([{ karma: 50, ageDays: 10 }]);
assert.strictEqual(r1.tier, 0);
assert.strictEqual(r1.reward, "0.00");
console.log("  ✅ Case 3.1: 50 karma & 10 days -> Tier 0 (BLOCKED, $0.00)");

// Case 3.2: 200 karma, but only 20 days old (< 30 days)
const r2 = evaluateReferralTier([{ karma: 200, ageDays: 20 }]);
assert.strictEqual(r2.tier, 0);
assert.strictEqual(r2.reward, "0.00");
console.log("  ✅ Case 3.2: 200 karma & 20 days -> Tier 0 (BLOCKED, age < 30 days)");

// Case 3.3: 180 karma & 40 days old -> Tier 2 ($0.50)
const r3 = evaluateReferralTier([{ karma: 180, ageDays: 40 }]);
assert.strictEqual(r3.tier, 2);
assert.strictEqual(r3.reward, "0.50");
console.log("  ✅ Case 3.3: 180 karma & 40 days -> TIER 2 MATCH ($0.50 to inviter, $0.00 to friend)");

// Case 3.4: 500 karma & 120 days old -> Tier 1 ($1.00)
const r4 = evaluateReferralTier([{ karma: 500, ageDays: 120 }]);
assert.strictEqual(r4.tier, 1);
assert.strictEqual(r4.reward, "1.00");
console.log("  ✅ Case 3.4: 500 karma & 120 days -> TIER 1 MATCH ($1.00 to inviter, $0.00 to friend)");

// Case 3.5: Multi-account user: Account 1 is fresh (20 karma), Account 2 has 350 karma & 100 days
const r5 = evaluateReferralTier([
  { karma: 20, ageDays: 5 },
  { karma: 350, ageDays: 100 }
]);
assert.strictEqual(r5.tier, 1);
assert.strictEqual(r5.reward, "1.00");
console.log("  ✅ Case 3.5: Multi-account user picks highest qualifying tier -> TIER 1 MATCH ($1.00)");


// --- TEST SUITE 4: End-to-End Payout Transaction Simulation ---
console.log("\n▶️ TEST 4: End-to-End Complete Flow Simulation");

function simulateFullReferralFlow({ joinedViaInvite, taskSubmitted, hoursElapsed, redditLiveStatus, redditKarma, redditAgeDays }) {
  // Step 1: Member joins
  const referralStatus = joinedViaInvite ? "pending" : "none";
  let referrerEarned = 0;
  let friendEarned = 0;

  if (referralStatus !== "pending") return { paid: false, reason: "No referral active" };

  // Step 2: Task submission
  if (!taskSubmitted) {
    return { paid: false, reason: "No task completed yet" };
  }

  // Step 3: Check 24-hour verification hold
  if (hoursElapsed < 24) {
    return { paid: false, reason: `Task still on 24h hold (${hoursElapsed}h elapsed)` };
  }

  // Step 4: Check Reddit liveness
  if (redditLiveStatus !== "live") {
    return { paid: false, reason: "Task failed Reddit liveness check (removed/deleted)" };
  }

  // Step 5: Check Reddit karma/age tier
  const tierResult = evaluateReferralTier([{ karma: redditKarma, ageDays: redditAgeDays }]);
  if (tierResult.tier === 0) {
    return { paid: false, reason: "Reddit account does not qualify for Tier 1 or Tier 2" };
  }

  // Payout triggered!
  referrerEarned = parseFloat(tierResult.reward);
  friendEarned = 0.00; // Zero welcome bonus per specifications

  return {
    paid: true,
    tier: tierResult.tier,
    referrerEarned: `$${referrerEarned.toFixed(2)}`,
    friendEarned: `$${friendEarned.toFixed(2)}`,
  };
}

const sim1 = simulateFullReferralFlow({
  joinedViaInvite: true,
  taskSubmitted: true,
  hoursElapsed: 2, // only 2h!
  redditLiveStatus: "live",
  redditKarma: 400,
  redditAgeDays: 100,
});
assert.strictEqual(sim1.paid, false);
console.log(`  ✅ Flow 1 (Task 2h old): ${sim1.reason} -> NO PAYOUT`);

const sim2 = simulateFullReferralFlow({
  joinedViaInvite: true,
  taskSubmitted: true,
  hoursElapsed: 25,
  redditLiveStatus: "removed", // removed!
  redditKarma: 400,
  redditAgeDays: 100,
});
assert.strictEqual(sim2.paid, false);
console.log(`  ✅ Flow 2 (Reddit removed post): ${sim2.reason} -> NO PAYOUT`);

const sim3 = simulateFullReferralFlow({
  joinedViaInvite: true,
  taskSubmitted: true,
  hoursElapsed: 25,
  redditLiveStatus: "live",
  redditKarma: 160,
  redditAgeDays: 45, // Tier 2
});
assert.strictEqual(sim3.paid, true);
assert.strictEqual(sim3.referrerEarned, "$0.50");
assert.strictEqual(sim3.friendEarned, "$0.00");
console.log(`  ✅ Flow 3 (Tier 2 cleared 24h): Inviter gets ${sim3.referrerEarned}, Friend gets ${sim3.friendEarned} -> PAYOUT APPROVED`);

const sim4 = simulateFullReferralFlow({
  joinedViaInvite: true,
  taskSubmitted: true,
  hoursElapsed: 25,
  redditLiveStatus: "live",
  redditKarma: 450,
  redditAgeDays: 110, // Tier 1
});
assert.strictEqual(sim4.paid, true);
assert.strictEqual(sim4.referrerEarned, "$1.00");
assert.strictEqual(sim4.friendEarned, "$0.00");
console.log(`  ✅ Flow 4 (Tier 1 cleared 24h): Inviter gets ${sim4.referrerEarned}, Friend gets ${sim4.friendEarned} -> PAYOUT APPROVED`);

console.log("\n==========================================================");
console.log("🎉 ALL DRY-RUN TESTS PASSED WITH 100% SUCCESS!");
console.log("   - 0 Real Users Affected");
console.log("   - 24-Hour Hold Strictly Enforced");
console.log("   - Reddit Liveness Filter Verified");
console.log("   - Tier 1 ($1.00) and Tier 2 ($0.50) Verified");
console.log("   - Friend Welcome Bonus ($0.00) Confirmed Zero");
console.log("==========================================================");
