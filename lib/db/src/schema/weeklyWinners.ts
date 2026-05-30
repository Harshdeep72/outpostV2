import { pgTable, serial, text, integer, numeric, timestamp } from "drizzle-orm/pg-core";

export const weeklyWinners = pgTable("weekly_winners", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
  weekEnd: timestamp("week_end", { withTimezone: true }).notNull(),
  userId: integer("user_id").notNull(),
  discordId: text("discord_id").notNull(),
  discordUsername: text("discord_username").notNull(),
  totalEarned: numeric("total_earned", { precision: 12, scale: 2 }).notNull(),
  taskCount: integer("task_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WeeklyWinner = typeof weeklyWinners.$inferSelect;
export type InsertWeeklyWinner = typeof weeklyWinners.$inferInsert;
