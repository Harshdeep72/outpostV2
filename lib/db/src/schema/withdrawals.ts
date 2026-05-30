import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";

export const withdrawals = pgTable("withdrawals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  discordId: text("discord_id").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  method: text("method").notNull(),
  destination: text("destination").notNull(),
  status: text("status").notNull().default("pending"),
  reviewerDiscordId: text("reviewer_discord_id"),
  reason: text("reason"),
  logMessageId: text("log_message_id"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

export type Withdrawal = typeof withdrawals.$inferSelect;
export type InsertWithdrawal = typeof withdrawals.$inferInsert;
