import { pgTable, serial, text, boolean, integer, numeric, jsonb, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").unique().notNull(),
  discordUsername: text("discord_username").notNull(),
  redditUsername: text("reddit_username"),
  redditAccountAgeDays: integer("reddit_account_age_days"),
  redditPostKarma: integer("reddit_post_karma"),
  redditCommentKarma: integer("reddit_comment_karma"),
  verified: boolean("verified").notNull().default(false),
  workspaceChannelId: text("workspace_channel_id"),
  trustScore: integer("trust_score").notNull().default(100),
  balanceAvailable: numeric("balance_available", { precision: 12, scale: 2 }).notNull().default("0"),
  balancePending: numeric("balance_pending", { precision: 12, scale: 2 }).notNull().default("0"),
  totalEarned: numeric("total_earned", { precision: 12, scale: 2 }).notNull().default("0"),
  referralEarnings: numeric("referral_earnings", { precision: 12, scale: 2 }).notNull().default("0"),
  referralCode: text("referral_code").unique(),
  referredBy: text("referred_by"),
  lastTaskCompletedAt: timestamp("last_task_completed_at", { withTimezone: true }),
  upiId: text("upi_id"),
  paypalEmail: text("paypal_email"),
  cryptoWallets: jsonb("crypto_wallets").notNull().default({}),
  isMod: boolean("is_mod").notNull().default(false),
  isAdmin: boolean("is_admin").notNull().default(false),
  flagged: boolean("flagged").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
