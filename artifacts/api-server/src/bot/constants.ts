export const CHANNELS = {
  VERIFICATION_LOG: "verification-log",
  TASKS: "tasks",
  TASK_LOGS: "task-logs",
  WITHDRAWAL_LOG: "withdrawal-log",
  LEADERBOARD: "leaderboard",
  START_HERE: "start-here",
  GUIDE: "guide",
  GENERAL: "general",
  REFERRAL_EVENTS: "referral-events",
  ANNOUNCEMENTS: "announcements",
  UPDATES: "updates",
  // Mod-only log channel for tasks rejected by the worker who claimed them.
  // Created lazily by setupGuild on next bot boot or first setup() call.
  REJECTED_TASKS: "rejected-tasks",
} as const;

export const CATEGORIES = {
  EARN: "Earn",
  WORKSPACES: "Workspaces",
  COMMUNITY: "Community",
} as const;

export const ROLES = {
  ADMIN: "Admin",
  MOD: "Mod",
  VERIFIED: "Verified",
  UNVERIFIED: "Unverified",
  BRONZE_EARNER: "Bronze Earner",
  SILVER_EARNER: "Silver Earner",
  GOLD_EARNER: "Gold Earner",
  KARMA_10K: "10k+ Karma",
  KARMA_5K: "5k+ Karma",
} as const;

export const EARNER_TIERS = [
  { key: "bronze", roleName: ROLES.BRONZE_EARNER, threshold: 50,  color: 0xcd7f32 },
  { key: "silver", roleName: ROLES.SILVER_EARNER, threshold: 100, color: 0xc0c0c0 },
  { key: "gold",   roleName: ROLES.GOLD_EARNER,   threshold: 500, color: 0xffd700 },
] as const;

export const ANTI_FRAUD = {
  BURST_WINDOW_SECONDS: 60,
  BURST_MAX_SUBMISSIONS: 5,
  MIN_REDDIT_ACCOUNT_AGE_DAYS: 7,
} as const;

export const TASK_REMINDER_MINUTES_BEFORE_EXPIRY = 10;

export const TRUST = {
  ACCEPT: 2,
  REJECT: -3,
  FLAG: -10,
  STARTING: 100,
  MIN_TO_CLAIM: 50,
} as const;

export const COLORS = {
  PRIMARY: 0x5865f2,
  SUCCESS: 0x57f287,
  WARNING: 0xfee75c,
  DANGER: 0xed4245,
  MUTED: 0x4f545c,
  ACCENT: 0xeb5528,
} as const;

export const COIN_CHOICES = ["USDT"] as const;
export type CoinChoice = (typeof COIN_CHOICES)[number];

export const PAYOUT_DAY_UTC = 6; // Saturday (0=Sun, 1=Mon, ..., 6=Sat)

// `thread_reply` = a worker replies inside an existing Reddit thread (not the
// top-level OP). `op_reply` = the worker is the OP of the thread and replies
// to a commenter on their own post (used for persona/follow-up tasks).
// Both are validated through the same Reddit author/subreddit gate as
// `comment`, so no extra validator branch is needed.
export const REDDIT_TASK_TYPES = ["comment", "thread_reply", "op_reply", "post", "upvote", "share", "join"] as const;
export const TWITTER_TASK_TYPES = ["twitter_follow", "twitter_like", "twitter_retweet", "twitter_reply", "twitter_tweet"] as const;
export const QUORA_TASK_TYPES = ["quora_answer", "quora_follow", "quora_upvote"] as const;
export const TASK_TYPES = [...REDDIT_TASK_TYPES, ...TWITTER_TASK_TYPES, ...QUORA_TASK_TYPES] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export function isTwitterTask(type: string): boolean {
  return (TWITTER_TASK_TYPES as readonly string[]).includes(type);
}

export function isQuoraTask(type: string): boolean {
  return (QUORA_TASK_TYPES as readonly string[]).includes(type);
}

export function isRedditTask(type: string): boolean {
  return (REDDIT_TASK_TYPES as readonly string[]).includes(type);
}

export function getPlatformLabel(type: string): string {
  if (isTwitterTask(type)) return "Twitter";
  if (isQuoraTask(type)) return "Quora";
  return "Reddit";
}

export const TASK_PING_DELAY_MS = 5 * 60 * 1000;

// Default global cooldown after a user submits a task (2 hours / 120 minutes).
// Overridable via the dashboard Settings page and per-task / per-reddit-account.
export const TASK_COOLDOWN_MINUTES = 120; // 2 hours
// Default claim window duration (1 hour / 60 minutes).
// Gives workers ample time to engage authentically in the subreddit before commenting.
export const CLAIM_TIMEOUT_MINUTES = 60; // 1 hour
// One active claim at a time per user. Once they submit (proof entered), the
// claim moves to "submitted" status and stops counting toward this cap, AND
// the 30-min cooldown begins — so they can claim a new task only after the
// cooldown elapses, never while a prior claim is still un-submitted.
export const MAX_CONCURRENT_CLAIMS = 1;

export const REFERRAL_REWARD = "1.00";
export const REFERRAL_REWARD_REFERRER = "1.00";
export const REFERRAL_REWARD_REFERRED = "0.00";

// Tier 1: 300+ karma & 3+ months (90 days) -> $1.00
export const REFERRAL_TIER1_REWARD = "1.00";
export const REFERRAL_TIER1_MIN_KARMA = 300;
export const REFERRAL_TIER1_MIN_AGE_DAYS = 90;

// Tier 2: 150+ karma & 1+ month (30 days) -> $0.50
export const REFERRAL_TIER2_REWARD = "0.50";
export const REFERRAL_TIER2_MIN_KARMA = 150;
export const REFERRAL_TIER2_MIN_AGE_DAYS = 30;

export const REFERRAL_MIN_KARMA = 150;
export const REFERRAL_MIN_AGE_DAYS = 30;
export const MAX_REFERRAL_COMPLETIONS_PER_DAY = 10;
export const MAX_REFERRALS_PER_HOUR = 5;
