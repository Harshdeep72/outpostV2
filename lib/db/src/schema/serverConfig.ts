import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const serverConfig = pgTable("server_config", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").unique().notNull(),
  leaderboardChannelId: text("leaderboard_channel_id"),
  leaderboardMessageId: text("leaderboard_message_id"),
  currentWeekStart: timestamp("current_week_start", { withTimezone: true }),
  lastWeeklyPayoutAt: timestamp("last_weekly_payout_at", { withTimezone: true }),
  lastChangelogVersion: text("last_changelog_version"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ServerConfig = typeof serverConfig.$inferSelect;
export type InsertServerConfig = typeof serverConfig.$inferInsert;
