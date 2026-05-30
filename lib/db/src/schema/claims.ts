import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const claims = pgTable("claims", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull(),
  userId: integer("user_id").notNull(),
  discordId: text("discord_id").notNull(),
  status: text("status").notNull().default("claimed"),
  workspaceMessageId: text("workspace_message_id"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export type Claim = typeof claims.$inferSelect;
export type InsertClaim = typeof claims.$inferInsert;
