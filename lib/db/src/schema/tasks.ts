import { pgTable, serial, text, integer, numeric, timestamp, boolean } from "drizzle-orm/pg-core";

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  creatorDiscordId: text("creator_discord_id").notNull(),
  title: text("title").notNull(),
  type: text("type").notNull(),
  reward: numeric("reward", { precision: 12, scale: 2 }).notNull(),
  instructions: text("instructions").notNull(),
  redditLink: text("reddit_link").notNull(),
  prewrittenComment: text("prewritten_comment"),
  timeLimitMinutes: integer("time_limit_minutes").notNull().default(60),
  maxSlots: integer("max_slots").notNull().default(1),
  slotsFilled: integer("slots_filled").notNull().default(0),
  pendingDelayHours: integer("pending_delay_hours").notNull().default(24),
  minTrustScore: integer("min_trust_score").notNull().default(0),
  minKarma: integer("min_karma").notNull().default(0),
  minAccountAgeDays: integer("min_account_age_days").notNull().default(0),
  status: text("status").notNull().default("open"),
  channelMessageId: text("channel_message_id"),
  imageUrl: text("image_url"),
  // When true, the same Discord user can claim/submit this task multiple times
  // (intended for campaigns where one user can do many tasks with their single
  // Reddit account, e.g. drip-feed comment campaigns). Default false preserves
  // the original "one submission per user per task" rule.
  allowMultiClaim: boolean("allow_multi_claim").notNull().default(false),
  // Phase 2: per-task cooldown override. When false, this task ignores the
  // global task-cooldown gate (still respects MAX_CONCURRENT_CLAIMS). The
  // column is added by lib/bootstrapSchema.ts on every boot — declared here
  // so drizzle's typed SELECT actually returns it.
  cooldownEnabled: boolean("cooldown_enabled").notNull().default(true),
  // Per-user claim cap (added via raw migration; declared here so it's
  // returned by typed SELECTs and the cooldown/multi-claim gates can read it
  // without `(task as any)` casts).
  maxClaimsPerUser: integer("max_claims_per_user").notNull().default(1),
  // Feature #3: auto-marked "hot" when a task fills fast (>=50% in <15 min, or
  // >=80% in <30 min). When set, the public #tasks embed prepends 🔥 and
  // shows a "HOT" footer line to draw extra attention.
  isHot: boolean("is_hot").notNull().default(false),
  hotMarkedAt: timestamp("hot_marked_at", { withTimezone: true }),
  // Feature #9: Dutch auction auto-bump. Disabled by default
  // (auto_bump_percent = 0). When >0, the autoBumper cron raises the reward
  // by N% every interval if no slots have been claimed, capped at
  // cap_percent of the original. original_reward is set on first bump so we
  // never lose the starting price.
  originalReward: numeric("original_reward", { precision: 12, scale: 2 }),
  autoBumpPercent: integer("auto_bump_percent").notNull().default(0),
  autoBumpIntervalMin: integer("auto_bump_interval_min").notNull().default(60),
  autoBumpCapPercent: integer("auto_bump_cap_percent").notNull().default(50),
  autoBumpCount: integer("auto_bump_count").notNull().default(0),
  lastBumpAt: timestamp("last_bump_at", { withTimezone: true }),
  // Repeating unclaimed-task notifier. When enabled (set by bulk task creation),
  // the unclaimedNotifier scheduler deletes the current channel message and
  // re-posts it with an @here ping on an escalating cadence (5/5/5 min, then
  // 10/15 min, then 30 min steady) until the first claim arrives or it caps.
  unclaimedNotifyEnabled: boolean("unclaimed_notify_enabled").notNull().default(false),
  unclaimedNotifyCount: integer("unclaimed_notify_count").notNull().default(0),
  unclaimedLastNotifyAt: timestamp("unclaimed_last_notify_at", { withTimezone: true }),
  // Backref to the campaign this task belongs to (NULL for one-off tasks
  // created directly via /createtask or the admin form). Nullable, no FK
  // constraint to keep deletes loose. Used to render the campaign-progress
  // mini-embed at the bottom of each public #tasks card.
  campaignId: integer("campaign_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closesAt: timestamp("closes_at", { withTimezone: true }),
});

export type Task = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;
