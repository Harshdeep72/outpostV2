import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";

export const submissions = pgTable("submissions", {
  id: serial("id").primaryKey(),
  claimId: integer("claim_id").notNull(),
  taskId: integer("task_id").notNull(),
  userId: integer("user_id").notNull(),
  discordId: text("discord_id").notNull(),
  proofLink: text("proof_link").notNull(),
  screenshotUrl: text("screenshot_url"),
  reward: numeric("reward", { precision: 12, scale: 2 }).notNull(),
  reviewStatus: text("review_status").notNull().default("pending"),
  reviewerDiscordId: text("reviewer_discord_id"),
  reviewReason: text("review_reason"),
  logMessageId: text("log_message_id"),
  availableAt: timestamp("available_at", { withTimezone: true }),
  movedToAvailable: integer("moved_to_available").notNull().default(0),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  liveStatus: text("live_status").notNull().default("unknown"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  removalReason: text("removal_reason"),
  liveStatusChangedAt: timestamp("live_status_changed_at", { withTimezone: true }),
  // Timestamp when pendingProcessor moved this submission's reward from
  // balance_pending → balance_available. Surfaces "paid date" to the
  // accountant's Google Sheet so they can reconcile payouts by date.
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export type Submission = typeof submissions.$inferSelect;
export type InsertSubmission = typeof submissions.$inferInsert;
