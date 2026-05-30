import { pgTable, serial, text, numeric, timestamp, boolean } from "drizzle-orm/pg-core";

export const referrals = pgTable("referrals", {
  id: serial("id").primaryKey(),
  referrerDiscordId: text("referrer_discord_id").notNull(),
  referredDiscordId: text("referred_discord_id").notNull(),
  codeUsed: text("code_used").notNull(),
  status: text("status").notNull().default("pending"),
  rewardPaid: boolean("reward_paid").notNull().default(false),
  rewardAmount: numeric("reward_amount", { precision: 12, scale: 2 }).notNull().default("0.40"),
  taskCompletedAt: timestamp("task_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Referral = typeof referrals.$inferSelect;
export type InsertReferral = typeof referrals.$inferInsert;
