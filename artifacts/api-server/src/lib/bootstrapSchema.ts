import { pool } from "@workspace/db";
import { logger } from "./logger.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "users" (
  "id"                      SERIAL PRIMARY KEY,
  "discord_id"              TEXT NOT NULL UNIQUE,
  "discord_username"        TEXT NOT NULL,
  "reddit_username"         TEXT,
  "reddit_account_age_days" INTEGER,
  "reddit_post_karma"       INTEGER,
  "reddit_comment_karma"    INTEGER,
  "verified"                BOOLEAN NOT NULL DEFAULT false,
  "workspace_channel_id"    TEXT,
  "trust_score"             INTEGER NOT NULL DEFAULT 100,
  "balance_available"       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "balance_pending"         NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "total_earned"            NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "referral_earnings"       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  "referral_code"           TEXT UNIQUE,
  "referred_by"             TEXT,
  "last_task_completed_at"  TIMESTAMPTZ,
  "upi_id"                  TEXT,
  "paypal_email"            TEXT,
  "crypto_wallets"          JSONB NOT NULL DEFAULT '{}',
  "is_mod"                  BOOLEAN NOT NULL DEFAULT false,
  "is_admin"                BOOLEAN NOT NULL DEFAULT false,
  "flagged"                 BOOLEAN NOT NULL DEFAULT false,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "tasks" (
  "id"                  SERIAL PRIMARY KEY,
  "creator_discord_id"  TEXT NOT NULL,
  "title"               TEXT NOT NULL,
  "type"                TEXT NOT NULL,
  "reward"              NUMERIC(12, 2) NOT NULL,
  "instructions"        TEXT NOT NULL,
  "reddit_link"         TEXT NOT NULL,
  "prewritten_comment"  TEXT,
  "time_limit_minutes"  INTEGER NOT NULL DEFAULT 60,
  "max_slots"           INTEGER NOT NULL DEFAULT 1,
  "slots_filled"        INTEGER NOT NULL DEFAULT 0,
  "pending_delay_hours" INTEGER NOT NULL DEFAULT 24,
  "min_trust_score"     INTEGER NOT NULL DEFAULT 0,
  "status"              TEXT NOT NULL DEFAULT 'open',
  "channel_message_id"  TEXT,
  "image_url"           TEXT,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "closes_at"           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "claims" (
  "id"                   SERIAL PRIMARY KEY,
  "task_id"              INTEGER NOT NULL,
  "user_id"              INTEGER NOT NULL,
  "discord_id"           TEXT NOT NULL,
  "status"               TEXT NOT NULL DEFAULT 'claimed',
  "workspace_message_id" TEXT,
  "claimed_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expires_at"           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "submissions" (
  "id"                      SERIAL PRIMARY KEY,
  "claim_id"                INTEGER NOT NULL,
  "task_id"                 INTEGER NOT NULL,
  "user_id"                 INTEGER NOT NULL,
  "discord_id"              TEXT NOT NULL,
  "proof_link"              TEXT NOT NULL,
  "screenshot_url"          TEXT,
  "reward"                  NUMERIC(12, 2) NOT NULL,
  "review_status"           TEXT NOT NULL DEFAULT 'pending',
  "reviewer_discord_id"     TEXT,
  "review_reason"           TEXT,
  "log_message_id"          TEXT,
  "available_at"            TIMESTAMPTZ,
  "moved_to_available"      INTEGER NOT NULL DEFAULT 0,
  "submitted_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "reviewed_at"             TIMESTAMPTZ,
  "live_status"             TEXT NOT NULL DEFAULT 'unknown',
  "last_checked_at"         TIMESTAMPTZ,
  "removal_reason"          TEXT,
  "live_status_changed_at"  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "withdrawals" (
  "id"                  SERIAL PRIMARY KEY,
  "user_id"             INTEGER NOT NULL,
  "discord_id"          TEXT NOT NULL,
  "amount"              NUMERIC(12, 2) NOT NULL,
  "method"              TEXT NOT NULL,
  "destination"         TEXT NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'pending',
  "reviewer_discord_id" TEXT,
  "reason"              TEXT,
  "log_message_id"      TEXT,
  "requested_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "processed_at"        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "trust_logs" (
  "id"                    SERIAL PRIMARY KEY,
  "user_id"               INTEGER NOT NULL,
  "discord_id"            TEXT NOT NULL,
  "delta"                 INTEGER NOT NULL,
  "reason"                TEXT NOT NULL,
  "related_submission_id" INTEGER,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "server_config" (
  "id"                     SERIAL PRIMARY KEY,
  "guild_id"               TEXT NOT NULL,
  "leaderboard_channel_id" TEXT,
  "leaderboard_message_id" TEXT,
  "current_week_start"     TIMESTAMPTZ,
  "last_weekly_payout_at"  TIMESTAMPTZ,
  "last_changelog_version" TEXT,
  "updated_at"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "weekly_winners" (
  "id"               SERIAL PRIMARY KEY,
  "guild_id"         TEXT NOT NULL,
  "week_start"       TIMESTAMPTZ NOT NULL,
  "week_end"         TIMESTAMPTZ NOT NULL,
  "user_id"          INTEGER NOT NULL,
  "discord_id"       TEXT NOT NULL,
  "discord_username" TEXT NOT NULL,
  "total_earned"     NUMERIC(12, 2) NOT NULL,
  "task_count"       INTEGER NOT NULL,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "referrals" (
  "id"                  SERIAL PRIMARY KEY,
  "referrer_discord_id" TEXT NOT NULL,
  "referred_discord_id" TEXT NOT NULL,
  "code_used"           TEXT NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'pending',
  "reward_paid"         BOOLEAN NOT NULL DEFAULT false,
  "reward_amount"       NUMERIC(12, 2) NOT NULL DEFAULT 0.40,
  "task_completed_at"   TIMESTAMPTZ,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "campaigns" (
  "id"                 SERIAL PRIMARY KEY,
  "creator_discord_id" TEXT NOT NULL,
  "title"              TEXT NOT NULL,
  "source_type"        TEXT NOT NULL DEFAULT 'csv',
  "source_url"         TEXT,
  "total_tasks"        INTEGER NOT NULL DEFAULT 0,
  "tasks_created"      INTEGER NOT NULL DEFAULT 0,
  "status"             TEXT NOT NULL DEFAULT 'active',
  "interval_minutes"   INTEGER NOT NULL DEFAULT 0,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "campaign_queue" (
  "id"              SERIAL PRIMARY KEY,
  "campaign_id"     INTEGER NOT NULL,
  "guild_id"        TEXT NOT NULL,
  "payload"         JSONB NOT NULL,
  "scheduled_at"    TIMESTAMPTZ NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'pending',
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "last_error"      TEXT,
  "posted_task_id"  INTEGER,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "campaign_queue_due_idx"
  ON "campaign_queue" ("status", "scheduled_at");

CREATE TABLE IF NOT EXISTS "withdrawal_creator_payouts" (
  "id"                  SERIAL PRIMARY KEY,
  "withdrawal_id"       INTEGER NOT NULL,
  "creator_discord_id"  TEXT NOT NULL,
  "amount"              NUMERIC(12, 2) NOT NULL,
  "submission_ids"      JSONB NOT NULL DEFAULT '[]',
  "status"              TEXT NOT NULL DEFAULT 'pending',
  "paid_by"             TEXT,
  "paid_at"             TIMESTAMPTZ,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "wcp_withdrawal_idx"
  ON "withdrawal_creator_payouts" ("withdrawal_id");
CREATE INDEX IF NOT EXISTS "wcp_creator_status_idx"
  ON "withdrawal_creator_payouts" ("creator_discord_id", "status");
-- Prevents duplicate per-creator payout rows on concurrent "Mark as Paid" clicks.
CREATE UNIQUE INDEX IF NOT EXISTS "wcp_wd_creator_uniq"
  ON "withdrawal_creator_payouts" ("withdrawal_id", "creator_discord_id");
`;

const POST_FIXES: string[] = [
  // ---- users: add any columns missing on older tables ----
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "discord_username" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reddit_username" TEXT;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reddit_account_age_days" INTEGER;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reddit_post_karma" INTEGER;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reddit_comment_karma" INTEGER;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "verified" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "workspace_channel_id" TEXT;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "trust_score" INTEGER NOT NULL DEFAULT 100;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "balance_available" NUMERIC(12,2) NOT NULL DEFAULT 0;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "balance_pending" NUMERIC(12,2) NOT NULL DEFAULT 0;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "total_earned" NUMERIC(12,2) NOT NULL DEFAULT 0;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referral_earnings" NUMERIC(12,2) NOT NULL DEFAULT 0;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referral_code" TEXT;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referred_by" TEXT;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_task_completed_at" TIMESTAMPTZ;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "upi_id" TEXT;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "paypal_email" TEXT;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "crypto_wallets" JSONB NOT NULL DEFAULT '{}';`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_mod" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "flagged" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
  // Daily DM digest opt-in (feature #1). Opt-in only — defaults to false so
  // existing users don't suddenly get DMs. last_sent_at debounces the cron.
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "daily_digest_optin" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "daily_digest_last_sent_at" TIMESTAMPTZ;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_discord_id_unique')
       AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='users_discord_id_unique')
     THEN BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_discord_id_unique" UNIQUE ("discord_id"); EXCEPTION WHEN others THEN NULL; END; END IF;
   END$$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_referral_code_unique')
       AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='users_referral_code_unique')
     THEN BEGIN ALTER TABLE "users" ADD CONSTRAINT "users_referral_code_unique" UNIQUE ("referral_code"); EXCEPTION WHEN others THEN NULL; END; END IF;
   END$$;`,

  // ---- tasks ----
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "creator_discord_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "title" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'comment';`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "reward" NUMERIC(12,2) NOT NULL DEFAULT 0;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "instructions" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "reddit_link" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "prewritten_comment" TEXT;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "time_limit_minutes" INTEGER NOT NULL DEFAULT 60;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "max_slots" INTEGER NOT NULL DEFAULT 1;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "slots_filled" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "pending_delay_hours" INTEGER NOT NULL DEFAULT 24;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "min_trust_score" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'open';`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "channel_message_id" TEXT;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "image_url" TEXT;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "closes_at" TIMESTAMPTZ;`,

  // ---- claims ----
  `ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "task_id" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "user_id" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "discord_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'claimed';`,
  `ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "workspace_message_id" TEXT;`,
  `ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
  `ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ;`,
  `ALTER TABLE "claims" ADD COLUMN IF NOT EXISTS "reminder_sent" INTEGER NOT NULL DEFAULT 0;`,

  // ---- submissions ----
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "claim_id" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "task_id" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "user_id" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "discord_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "proof_link" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "screenshot_url" TEXT;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "reward" NUMERIC(12,2) NOT NULL DEFAULT 0;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "review_status" TEXT NOT NULL DEFAULT 'pending';`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "reviewer_discord_id" TEXT;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "review_reason" TEXT;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "log_message_id" TEXT;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "available_at" TIMESTAMPTZ;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "moved_to_available" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMPTZ;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "live_status" TEXT NOT NULL DEFAULT 'unknown';`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "last_checked_at" TIMESTAMPTZ;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "removal_reason" TEXT;`,
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "live_status_changed_at" TIMESTAMPTZ;`,
  // Stamped when pendingProcessor moves reward to available — surfaces "paid date" in the accountant's sheet.
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMPTZ;`,
  // Per-campaign Google Sheets webhook URL (NULL → uses global env var fallback).
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "sheets_webhook_url" TEXT;`,
  // Per-campaign Google Sheets spreadsheet ID for the new Service Account flow.
  // When set, bot writes directly via Sheets API; takes precedence over webhook URL.
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "sheets_spreadsheet_id" TEXT;`,
  // v1.3.0 — link a submission to the withdrawal it was paid out under so we
  // can split per-creator "mark as paid" gates on payout day. NULL = unallocated.
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "withdrawal_id" INTEGER;`,
  `CREATE INDEX IF NOT EXISTS "submissions_withdrawal_idx" ON "submissions" ("withdrawal_id");`,
  // v1.4.0 — track which source successfully verified the proof comment so admins
  // can see exposure to Reddit unauthenticated JSON deprecation.
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "proof_verified_via" TEXT;`,

  // ---- withdrawals ----
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "user_id" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "discord_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "amount" NUMERIC(12,2) NOT NULL DEFAULT 0;`,
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "method" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "destination" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending';`,
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "reviewer_discord_id" TEXT;`,
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "reason" TEXT;`,
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "log_message_id" TEXT;`,
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "requested_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
  `ALTER TABLE "withdrawals" ADD COLUMN IF NOT EXISTS "processed_at" TIMESTAMPTZ;`,

  // ---- trust_logs ----
  `ALTER TABLE "trust_logs" ADD COLUMN IF NOT EXISTS "user_id" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "trust_logs" ADD COLUMN IF NOT EXISTS "discord_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "trust_logs" ADD COLUMN IF NOT EXISTS "delta" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "trust_logs" ADD COLUMN IF NOT EXISTS "reason" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "trust_logs" ADD COLUMN IF NOT EXISTS "related_submission_id" INTEGER;`,
  `ALTER TABLE "trust_logs" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,

  // ---- server_config ----
  `ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "guild_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "leaderboard_channel_id" TEXT;`,
  `ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "leaderboard_message_id" TEXT;`,
  `ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "current_week_start" TIMESTAMPTZ;`,
  `ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "last_weekly_payout_at" TIMESTAMPTZ;`,
  `ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "last_changelog_version" TEXT;`,
  `ALTER TABLE "server_config" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
  `DELETE FROM "server_config" a USING "server_config" b WHERE a."guild_id" = b."guild_id" AND a."id" > b."id";`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='server_config_guild_id_unique')
     THEN BEGIN ALTER TABLE "server_config" ADD CONSTRAINT "server_config_guild_id_unique" UNIQUE ("guild_id"); EXCEPTION WHEN others THEN NULL; END; END IF;
   END$$;`,

  // ---- weekly_winners ----
  `ALTER TABLE "weekly_winners" ADD COLUMN IF NOT EXISTS "guild_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "weekly_winners" ADD COLUMN IF NOT EXISTS "week_start" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
  `ALTER TABLE "weekly_winners" ADD COLUMN IF NOT EXISTS "week_end" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,
  `ALTER TABLE "weekly_winners" ADD COLUMN IF NOT EXISTS "user_id" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "weekly_winners" ADD COLUMN IF NOT EXISTS "discord_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "weekly_winners" ADD COLUMN IF NOT EXISTS "discord_username" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "weekly_winners" ADD COLUMN IF NOT EXISTS "total_earned" NUMERIC(12,2) NOT NULL DEFAULT 0;`,
  `ALTER TABLE "weekly_winners" ADD COLUMN IF NOT EXISTS "task_count" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "weekly_winners" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,

  // ---- referrals ----
  `ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "referrer_discord_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "referred_discord_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "code_used" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'pending';`,
  `ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "reward_paid" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "reward_amount" NUMERIC(12,2) NOT NULL DEFAULT 0.40;`,
  `ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "task_completed_at" TIMESTAMPTZ;`,
  `ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,

  // ---- campaigns ----
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "creator_discord_id" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "title" TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "source_type" TEXT NOT NULL DEFAULT 'csv';`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "source_url" TEXT;`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "total_tasks" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "tasks_created" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "interval_minutes" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "allow_multiple_claims" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "allow_multi_claim" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();`,

  // ---- max_claims_per_user: configurable per-user claim limit on tasks/campaigns ----
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "max_claims_per_user" INTEGER NOT NULL DEFAULT 1;`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "max_claims_per_user" INTEGER NOT NULL DEFAULT 1;`,

  // ---- reddit_accounts (multi-Reddit-account support) ----
  // Created lazily here (additive). Each verified Reddit account a Discord
  // user links lives here; the user's "primary" reddit_username also gets
  // mirrored in. UNIQUE on reddit_username preserves the existing anti-alt
  // rule (one Reddit account per Discord user).
  `CREATE TABLE IF NOT EXISTS "reddit_accounts" (
     "id"               SERIAL PRIMARY KEY,
     "discord_id"       TEXT NOT NULL,
     "reddit_username"  TEXT NOT NULL UNIQUE,
     "account_age_days" INTEGER,
     "post_karma"       INTEGER,
     "comment_karma"    INTEGER,
     "created_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE INDEX IF NOT EXISTS "reddit_accounts_discord_idx" ON "reddit_accounts" ("discord_id");`,
  // Backfill: copy each users.reddit_username (if any) into reddit_accounts.
  // Idempotent — UNIQUE constraint + ON CONFLICT DO NOTHING means re-running
  // is a no-op. Safe to leave on every boot.
  `INSERT INTO "reddit_accounts" ("discord_id", "reddit_username", "account_age_days", "post_karma", "comment_karma")
     SELECT u.discord_id, u.reddit_username, u.reddit_account_age_days, u.reddit_post_karma, u.reddit_comment_karma
     FROM "users" u
     WHERE u.reddit_username IS NOT NULL AND u.reddit_username <> ''
   ON CONFLICT ("reddit_username") DO NOTHING;`,

  // ---- Phase 2: per-Reddit-account cooldown + global cooldown setting ----
  // Per-Reddit-account cooldown: only the specific Reddit account a user
  // submits with goes on cooldown, leaving their other linked accounts free.
  `ALTER TABLE "reddit_accounts" ADD COLUMN IF NOT EXISTS "last_used_at" TIMESTAMPTZ;`,
  // Records WHICH Reddit account was used for a given submission so we can
  // attribute the cooldown stamp accurately and audit later.
  `ALTER TABLE "submissions" ADD COLUMN IF NOT EXISTS "reddit_username_used" TEXT;`,
  // Per-task toggle: when false, this task ignores the cooldown gate entirely
  // (still respects MAX_CONCURRENT_CLAIMS and other anti-fraud guards).
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "cooldown_enabled" BOOLEAN NOT NULL DEFAULT TRUE;`,
  // Feature #3: hot-task auto-marker columns.
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "is_hot" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "hot_marked_at" TIMESTAMPTZ;`,
  // Feature #9: Dutch auction auto-bump columns. Defaults keep auto-bump OFF
  // (auto_bump_percent = 0 → cron skips). Admins opt in per-task via the
  // POST /admin/tasks/:id/auto-bump endpoint.
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "original_reward" NUMERIC(12,2);`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_bump_percent" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_bump_interval_min" INTEGER NOT NULL DEFAULT 60;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_bump_cap_percent" INTEGER NOT NULL DEFAULT 50;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "auto_bump_count" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "last_bump_at" TIMESTAMPTZ;`,
  // Repeating unclaimed-task notifier columns (driven by unclaimedNotifier.ts).
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "unclaimed_notify_enabled" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "unclaimed_notify_count" INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "unclaimed_last_notify_at" TIMESTAMPTZ;`,
  // Backref to campaigns (nullable, no FK). Used by buildCampaignProgressEmbed
  // to render the "📦 Campaign progress" mini-embed under each bulk task's
  // public #tasks card. Indexed for cheap per-campaign aggregation.
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "campaign_id" INTEGER;`,
  `CREATE INDEX IF NOT EXISTS "tasks_campaign_id_idx" ON "tasks" ("campaign_id") WHERE "campaign_id" IS NOT NULL;`,
  // Single-embed bulktask mode: each CSV row becomes its own task row with
  // is_merged_subtask=true. Those tasks DO NOT post their own #tasks card.
  // Instead, ONE summary embed is posted for the whole campaign and its
  // "Claim Next Task" button routes the user to the next sub-task they
  // haven't claimed/submitted/blocked yet. Reject reopens the slot for
  // OTHER users (because rejected users are excluded by submissions row).
  `ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "is_merged_subtask" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "merge_mode" BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "summary_message_id" TEXT;`,
  `ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "summary_channel_id" TEXT;`,
  // Generic key/value store for global runtime settings (cooldown minutes,
  // cooldown enabled flag, hold-hours default, etc.). JSONB so a single row
  // can hold structured config; writes go through lib/settings.ts which
  // invalidates a 30s in-memory cache.
  `CREATE TABLE IF NOT EXISTS "system_settings" (
     "key"        TEXT PRIMARY KEY,
     "value"      JSONB NOT NULL,
     "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  // Permanent per-task re-claim block. A row exists ⇒ that discord_id can
  // NEVER reclaim that task_id (admin override via DELETE /admin/claim-blocks).
  // Written by claimExpirer when a 15-min claim auto-expires. Idempotent via
  // the (task_id, discord_id) primary key so retries are safe.
  `CREATE TABLE IF NOT EXISTS "task_claim_blocks" (
     "task_id"       INTEGER NOT NULL,
     "discord_id"    TEXT NOT NULL,
     "reason"        TEXT NOT NULL DEFAULT 'claim_expired',
     "blocked_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY ("task_id", "discord_id")
   );`,
  `CREATE INDEX IF NOT EXISTS "tcb_discord_idx" ON "task_claim_blocks" ("discord_id");`,
  // Admin notes — free-text notes attached to a worker's profile. Multiple
  // notes per user, ordered by created_at. author_username is denormalized
  // for display (we don't FK into admin_users so deleted admins still show).
  `CREATE TABLE IF NOT EXISTS "admin_notes" (
     "id"              SERIAL PRIMARY KEY,
     "discord_id"      TEXT NOT NULL,
     "author_username" TEXT NOT NULL,
     "body"            TEXT NOT NULL,
     "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );`,
  `CREATE INDEX IF NOT EXISTS "admin_notes_discord_idx" ON "admin_notes" ("discord_id", "created_at" DESC);`,
];

export async function bootstrapSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    for (const stmt of POST_FIXES) {
      try {
        await client.query(stmt);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "Schema post-fix skipped");
      }
    }
    logger.info("Schema bootstrap complete (CREATE TABLE IF NOT EXISTS)");
  } catch (err) {
    logger.error({ err }, "Schema bootstrap failed");
    throw err;
  } finally {
    client.release();
  }
}
