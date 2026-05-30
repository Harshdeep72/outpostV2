import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const trustLogs = pgTable("trust_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  discordId: text("discord_id").notNull(),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  relatedSubmissionId: integer("related_submission_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TrustLog = typeof trustLogs.$inferSelect;
export type InsertTrustLog = typeof trustLogs.$inferInsert;
