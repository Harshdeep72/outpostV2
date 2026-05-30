-- Outpost Bot — Full Database Setup
-- Paste this into Neon SQL Editor and click Run

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
  "guild_id"               TEXT NOT NULL UNIQUE,
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
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
