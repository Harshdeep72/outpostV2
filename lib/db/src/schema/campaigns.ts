import { pgTable, serial, text, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";

export const campaigns = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  creatorDiscordId: text("creator_discord_id").notNull(),
  title: text("title").notNull(),
  sourceType: text("source_type").notNull().default("csv"),
  sourceUrl: text("source_url"),
  totalTasks: integer("total_tasks").notNull().default(0),
  tasksCreated: integer("tasks_created").notNull().default(0),
  status: text("status").notNull().default("active"),
  intervalMinutes: integer("interval_minutes").notNull().default(0),
  // When true, every task created in this campaign carries allow_multi_claim,
  // so a single Discord user can claim and submit proof for many of its tasks.
  allowMultipleClaims: boolean("allow_multiple_claims").notNull().default(false),
  // Per-campaign Google Sheets webhook URL (Apps Script /exec URL). Each
  // submission tied to a task in this campaign mirrors to this sheet so the
  // client/accountant can audit proofs per campaign. NULL → falls back to the
  // global GOOGLE_SHEETS_WEBHOOK_URL env var (legacy single-sheet behaviour).
  sheetsWebhookUrl: text("sheets_webhook_url"),
  // Per-campaign Google Sheets spreadsheet ID (new flow: bot creates sheet
  // itself via Service Account + Sheets API and writes rows directly with
  // no Apps Script needed). When set, takes precedence over sheets_webhook_url.
  sheetsSpreadsheetId: text("sheets_spreadsheet_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Campaign = typeof campaigns.$inferSelect;
export type InsertCampaign = typeof campaigns.$inferInsert;

/**
 * Drip-feed queue. When a bulk import has interval_minutes > 0, every row is
 * stored here with its own scheduled_at and a background tick releases them
 * one-by-one. Persisting in the DB means the schedule survives bot restarts
 * (Render free-tier sleeps, deploys, etc.) — setTimeout would not.
 */
export const campaignQueue = pgTable("campaign_queue", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull(),
  guildId: text("guild_id").notNull(),
  payload: jsonb("payload").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  postedTaskId: integer("posted_task_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CampaignQueueRow = typeof campaignQueue.$inferSelect;
export type InsertCampaignQueueRow = typeof campaignQueue.$inferInsert;
