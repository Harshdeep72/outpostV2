# Outpost Bot — Full Technical Guide

> **Stack:** Node.js 20 · TypeScript · discord.js v14 · Express 5 · Drizzle ORM · PostgreSQL (Neon) · React 19 + Vite · Python curl_cffi
> **Monorepo layout:** `artifacts/api-server/` (bot + API) · `artifacts/db/` (schema) · `artifacts/dashboard/` (React admin UI)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Full User Journey — Verification → Payout](#2-full-user-journey)
3. [Discord Commands Reference](#3-discord-commands-reference)
4. [Background Schedulers](#4-background-schedulers)
5. [Reddit Validation Pipeline](#5-reddit-validation-pipeline)
6. [Proxy Pool System](#6-proxy-pool-system)
7. [Database Schema](#7-database-schema)
8. [Admin Dashboard](#8-admin-dashboard)
9. [Module-by-Module Reference](#9-module-by-module-reference)

---

## 1. System Overview

Outpost Bot is a **task-to-earn** platform layered on Discord. Admins post tasks that require real Reddit activity (commenting, posting, upvoting, etc.) or social media actions (Twitter, Quora). Verified members claim a task, do the work, submit a Reddit URL as proof, and get paid automatically in crypto, PayPal, or UPI.

The system has three major components that all run together as one Node.js process:

```
┌─────────────────────────────────────────────────────────────┐
│                    api-server (Node.js)                      │
│                                                             │
│   ┌──────────────┐   ┌──────────────┐   ┌───────────────┐  │
│   │  Discord Bot  │   │  Express API  │   │  Schedulers   │  │
│   │  (discord.js) │   │  (REST + auth)│   │  (10 loops)   │  │
│   └──────────────┘   └──────────────┘   └───────────────┘  │
│            │                  │                   │          │
│            └──────────────────┴───────────────────┘         │
│                          PostgreSQL (Neon)                    │
└─────────────────────────────────────────────────────────────┘

┌──────────────────────────────────┐
│    dashboard (React + Vite)      │
│    Served by Express on /        │
│    Consumes REST API on /admin/  │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│  Python sidecar (curl_cffi)      │
│  Spawned on demand for stealth   │
│  Reddit fetching (TLS spoofing)  │
└──────────────────────────────────┘
```

---

## 2. Full User Journey

### Step 1 — Admin posts the verification panel

An admin runs `/verify` in any channel. The bot posts a persistent embed with a **"Verify Me"** button. This only needs to be done once — the panel persists forever and survives bot restarts.

### Step 2 — User clicks "Verify Me"

A Discord modal pops up asking for the user's Reddit username.

### Step 3 — Reddit account checks

The bot immediately calls the Reddit API (via `reddit.ts → fetchRedditProfile`) to validate:

| Check | Minimum |
|---|---|
| Karma | ≥ 100 |
| Account age | ≥ 30 days |
| Not already linked | Each Reddit account can be linked to one Discord ID (configurable max accounts per user, default 3) |
| Not flagged | User must not be `is_flagged = true` in the DB |

**If Reddit's API is unreachable:** The request falls into `#verification-logs` and a mod can manually approve it with the canvas-rendered review card (shows karma, account age, a direct old.reddit.com link).

### Step 4 — Role assignment + workspace channel

On success:
- The user gets the **Verified** role.
- The bot creates or finds a private workspace channel (`#workspace-username`) visible only to that user and mods.
- A referral code is auto-generated for the user.
- If the user submitted a referral code earlier via `/referraluse`, the referrer gets credited.

### Step 5 — Task discovery

Tasks appear in `#tasks` channel as embeds. Each shows:
- Task type (Reddit: Comment, Reddit: Post, Twitter: Follow, etc.)
- Reward amount
- Slots available / filled
- Time limit to complete after claiming
- Hold period (time the reward is withheld before paying out)
- Minimum trust score required

### Step 6 — Claiming a task

User clicks **"Claim Task"** on a task embed.

Pre-claim guards:
- Must be verified
- Must not already have an active claim (max 1 concurrent claim by default)
- Cooldown check (per task-type cooldown in minutes, configurable)
- Minimum trust score check
- Task must not be full or closed
- If a `max_claims_per_user` was set on the campaign, enforced here

On success: a `claim` row is written with `expires_at = now + timeLimit`. A control panel embed appears in the user's workspace channel with full instructions, the target URL, and a **"Submit Proof"** button.

### Step 7 — User does the work and submits proof

User clicks **"Submit Proof"** in their workspace channel. A modal appears asking for:
- Proof URL (required) — their Reddit comment/post/share link
- Screenshot (optional, for Twitter/Quora tasks)

### Step 8 — Auto-validation

For Reddit tasks, the bot runs the full validation pipeline (see §5). Outcomes:

| Result | Action |
|---|---|
| ✅ Valid + live | Submission accepted, enters `pending_hold` state |
| ❌ Wrong author | Rejected with explanation |
| ❌ Wrong subreddit | Rejected with explanation |
| ❌ Deleted/removed | Rejected with explanation |
| ❌ App URL (i.e. reddit.com/app) | Rejected, user shown how to get a direct URL |
| ⚠️ Inconclusive | Moved to manual review queue in `#task-logs` |

For Twitter and Quora tasks: auto-validation is skipped, submission goes directly to manual review.

### Step 9 — Hold period

Accepted submissions sit in `pending_hold` for `holdHours` (default 168 hours = 7 days, configurable per task). The reward shows as `balance_pending` on the user's profile — it is NOT yet payable.

During the hold, `redditLivenessChecker` (§4) continues monitoring the proof link every 30 minutes. If the comment is deleted or removed during the hold, a **clawback** is triggered — the submission is rejected and the pending balance is reversed.

### Step 10 — Hold ends → Payout released

`pendingProcessor` runs every minute. When a submission's hold period expires:

1. Re-checks Reddit liveness one final time.
2. If **still live**: moves reward from `balance_pending` → `balance_available`. User is DMed and a green embed appears in their workspace.
3. If **now removed/deleted**: auto-rejects the submission, reverses the pending balance, DMs the user.
4. If **inconclusive** (network error, Reddit down): flags for manual review, pings `@Admin` in `#task-logs`.

### Step 11 — Weekly automatic payouts (Wednesdays)

Every hour, `weeklyPayoutScheduler` checks if it is Wednesday. When it fires, it sweeps all users with `balance_available > 0` into new `withdrawal` rows (status: `pending`). Users get a DM notifying them a payout is being processed.

### Step 12 — Admin approves withdrawals

`#withdrawal-logs` shows each pending withdrawal. Each withdrawal embed has:
- User's wallet/UPI/PayPal info
- Amount breakdown by task creator (for campaigns with multiple funders)
- **"Mark Paid"** buttons — one per task creator

Admins click "Mark Paid" as they send each payment. Once all creators have marked paid, the withdrawal is finalized and the user's `balance_available` is zeroed out.

---

## 3. Discord Commands Reference

### User-facing commands (DM-safe)

| Command | What it does |
|---|---|
| `/digest on/off/status` | Opt in/out of once-daily DM summarizing earnings and new tasks |
| `/referral` | View your referral code and total referral earnings |
| `/referraluse <code>` | Apply someone's referral code before verifying (8-char code) |
| `/setupi <upi_id>` | Save a UPI ID for INR payouts |
| `/setpaypal <email>` | Save a PayPal email for payouts |
| `/setwallet <coin> <address> [network]` | Save a crypto wallet (ETH/USDT/BTC/Binance Pay) with optional network (TRC20, ERC20, BEP20, SOL, etc.) |
| `/wallet [user]` | Show a public wallet card for yourself or another user |
| `/profile [user]` | View a user's Reddit profile, karma, and earnings history |
| `/mystatus` | View your pending submissions — reward, live status, time until payout |
| `/ping` | Show bot latency, DB speed, proxy pool status, and cache stats |
| `/stats` | Show community stats — total earnings, tasks completed, top earner this week |

### Admin / Mod commands

| Command | Who can use | What it does |
|---|---|---|
| `/verify` | Admin/Mod | Post the public verification panel in current channel |
| `/setup` | Admin | Bootstrap categories, channels, and roles for a fresh server |
| `/createtask <type> <reward> [options]` | Admin/Mod | Open the task creation modal. `type` is the platform action. Options: `time_limit`, `hold_hours`, `min_trust`, `cooldown_enabled`, `image` |
| `/bulktask [sheets_url] [interval_minutes] [max_claims_per_user]` | Admin/Mod | Create tasks from a Google Sheets URL or manually pasted CSV. Supports drip-feed scheduling |
| `/canceltask <task_id> [reason]` | Admin/Mod | Cancel an open task by ID |
| `/cancelcampaign <campaign_id> [reason]` | Admin/Mod | Cancel all open tasks in a campaign |
| `/verifyuser <user> <verify/unverify> [reddit_username]` | Admin/Mod | Manually grant or revoke verified status |
| `/addmod <user>` | Admin | Grant Mod role |
| `/removemod <user>` | Admin | Remove Mod role |
| `/addadmin <user>` | Admin | Grant Admin role |
| `/flag <user> [reason]` | Admin/Mod | Flag a user — blocks task claiming and payouts |
| `/unflag <user>` | Admin/Mod | Clear a user's flag |
| `/massdm [user] [target]` | Admin/Mod | DM all verified, all unverified, or everyone in the server |
| `/sendstats` | Admin/Mod | DM each verified user a personalized task stats card |
| `/notifywalletmigration` | Admin | DM users with legacy wallets to re-save with a network |
| `/leaderboard` | Admin/Mod | Manually refresh the leaderboard embed |
| `/resetleaderboard` | Admin/Mod | Repost a fresh leaderboard message |
| `/taskhistory [user]` | Admin/Mod | Show tasks created by an admin |
| `/payouthistory [user]` | Admin/Mod | Show a user's submission/earning history |
| `/adminpayouthistory [user]` | Admin/Mod | Show payouts reviewed by an admin |
| `/checksubmission <id>` | Admin/Mod | Manually re-run Reddit liveness check on a submission right now |
| `/approvesubmission <id>` | Admin/Mod | Manually approve a wrongly rejected submission and credit the reward |
| `/reopenslot <submission_id> [reason]` | Admin/Mod | Re-open the task slot from a rejected submission, making it claimable again |
| `/addbalance <user> <amount> [reason]` | Admin | Add money to a user's available balance |
| `/removebalance <user> <amount> [reason]` | Admin | Deduct money from a user's available balance |
| `/testurl <url> [reddit_username]` | Admin | Run a Reddit URL through the full validation system and print all debug output |
| `/health` | Admin | Deep health check — DB latency, proxy success rate, Reddit API status |

---

## 4. Background Schedulers

All schedulers start inside `client.once("ready")` in `bot/index.ts`. They use `setInterval` with `.unref()` so they don't prevent clean process exit.

### `pendingProcessor` — runs every 1 minute
**File:** `bot/pendingProcessor.ts`

Queries all `submissions` where:
- `review_status = 'pending_hold'`
- `moved_to_available IS NULL`
- `hold_ends_at <= NOW()`

For each expired hold:
1. Calls `recheckRedditLiveness()` (the full validation chain).
2. **Live** → moves reward to `balance_available`, DMs user, logs to Google Sheets.
3. **Removed/Deleted** → rejects submission, reverses pending balance, DMs user.
4. **Inconclusive** → sets `review_status = 'pending_review'`, pings Admin in `#task-logs`.

### `redditLivenessChecker` — runs every 5 minutes
**File:** `bot/redditLivenessChecker.ts`

Monitors all accepted Reddit submissions that are still in the hold period (up to 14 days old). Processes up to 30 rows per pass, each re-checked no more than once per 30 minutes.

For status changes:
- **Live → Removed/Deleted**: Clawback — reverses the pending reward, notifies the user via workspace channel.
- **Early check (5 min post-acceptance)**: Immediately after acceptance, does a quick sanity check. If the comment is already gone (user deleted it to dodge re-checking), clawback fires immediately.
- Skips Twitter/Quora submissions (those are manual-only).

### `claimExpirer` — runs every 1 minute
**File:** `bot/claimExpirer.ts`

Finds `claims` where `expires_at <= NOW()` and `status = 'active'`. Cancels expired claims, re-opens the task slot, and sends the user a DM explaining their claim expired.

### `autoBumper` — runs every 1 minute
**File:** `bot/autoBumper.ts`

Implements Dutch Auction logic — if a task has been open with no claims for a configurable interval, the reward is bumped by a configurable increment. Updates the task embed live in Discord. Keeps bumping until the task is claimed or reaches a configured max.

### `unclaimedNotifier` — runs every 5 minutes
**File:** `bot/unclaimedNotifier.ts`

Re-pings tasks that still have no claims after a threshold time. Posts a follow-up embed in `#tasks` mentioning the task role to draw attention to unclaimed slots.

### `expiryReminder` — runs on a schedule
**File:** `bot/expiryReminder.ts`

DMs users who have an active claim with only a short time left before their claim expires — a heads-up to submit proof before the slot is released.

### `weeklyPayouts` — runs every 1 hour, fires on Wednesdays
**File:** `bot/handlers/weeklyPayouts.ts`

Checks if the current UTC day is Wednesday. If yes:
1. Finds all users with `balance_available > 0`.
2. Creates `withdrawal` rows for each.
3. Posts withdrawal embeds to `#withdrawal-logs` with payment info and per-creator "Mark Paid" buttons.
4. DMs each user that their payout is in progress.

### `submissionRetention` — runs daily
**File:** `bot/submissionRetention.ts`

Safety valve for database cost control (Neon charges by row storage). Deletes `submissions` older than 22 days, but **only after** mirroring each deleted row to a Google Sheet as a permanent archive. The Google Sheet is the source of truth for long-term earnings history.

### `pendingReviewSweeper` — runs periodically
**File:** `bot/pendingReviewSweeper.ts`

Re-checks submissions that are sitting in `pending_review` (manual review queue). After 24 hours, if the Reddit post is now live → auto-accepts. If still removed/deleted → auto-rejects (no trust score penalty since the delay was on our end).

### `campaignQueueProcessor` — runs every 1 minute
**File:** `bot/campaignQueueProcessor.ts`

Handles drip-feed campaigns. When a campaign has `interval_minutes > 0`, tasks are released one at a time on the configured schedule. This processor fires the next task drop.

### `postPayoutChecker` — runs periodically
**File:** `bot/postPayoutChecker.ts`

After a payout is finalized, spot-checks that the corresponding withdrawal was actually marked paid. Guards against cases where the flow completed partially.

### `leaderboard + weekRollover` — runs every 5 minutes
**File:** `bot/handlers/leaderboard.ts`

Checks if the UTC week has rolled over. If yes, archives the current leaderboard snapshot and resets weekly counters. Then re-renders the leaderboard embed in `#leaderboard` with the latest weekly and all-time rankings.

---

## 5. Reddit Validation Pipeline

This is the most critical and complex system in the bot. It prevents false payments for non-existent or removed Reddit activity.

### Entry points

There are two validation entry points:

| Entry point | When used |
|---|---|
| `validateRedditProof()` in `reddit-validator.ts` | Called synchronously when a user submits proof |
| `recheckRedditLiveness()` in `reddit-validator.ts` | Called by schedulers to re-check an already-accepted submission |

### URL resolution

Before any check, the URL is normalized:

1. **Share link resolution** (`resolveShareLink`): Reddit mobile share links (`reddit.com/r/sub/s/XXXX`) are resolved to full URLs by following the `301` redirect with a `HEAD` request. Falls back to a `GET` + HTML parse if `HEAD` fails.

2. **App URL detection** (`detectAppUrl`): Rejects `reddit.com/app/...` deep links that can't be validated. Shows the user how to get a proper URL.

3. **Old.reddit.com normalization**: Forces all URLs to `old.reddit.com` for parsing. Old Reddit is more stable, less rate-limited, and has simpler HTML structure.

### Fetch strategy (3-tier, in priority order)

#### Tier 1 — Direct undici fetch with session cookie (PRIMARY)
`fetchCommentThreadViaDirectJson` in `deepRedditCommentChecker.ts`

Uses `undici` (Node.js HTTP client) to call `old.reddit.com/r/sub/comments/postid/comment/commentid.json` directly with the Reddit session cookie loaded from `redditCookieManager.ts`. This is the fastest and most accurate path — no subprocess spawn, full JSON response, can read authorship and body text cleanly.

- If Reddit returns HTML instead of JSON (cookie expired or cloudflare challenge): triggers a background cookie refresh via `forceRefreshCookie()`.
- If 401/403: triggers cookie refresh, falls through to Tier 2.

#### Tier 2 — Python curl_cffi subprocess (FALLBACK)
`executePythonRedditClient()` in `pythonClient.ts`

Spawns a Python process running `curl_cffi` to impersonate a real browser's TLS fingerprint (Chrome 120). Reddit's CDN blocks datacenter IPs using JA3/JA4 TLS fingerprinting — `curl_cffi` bypasses this by using Chrome's exact TLS stack. The Python sidecar:
- Receives a JSON payload from Node.js via stdin.
- Makes the HTTP request with the spoofed TLS fingerprint.
- Returns the response body + status via stdout.
- Subprocess timeout: 15 seconds.

#### Tier 3 — Reddit OAuth API (LAST RESORT)
Uses `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` from environment. Calls the official `oauth.reddit.com` API. Most reliable for reading comment data but rate-limited (60 req/min per app) and doesn't bypass content that's hidden from logged-out users.

### Liveness detection logic

After fetching the comment thread JSON/HTML:

**Positive signals (comment is live):**
- Comment body is non-empty and not `[deleted]` or `[removed]`
- Author field is the expected Reddit username (not `[deleted]`)
- `thing_t1_<commentId>` element present in old.reddit.com HTML
- `commentarea` div present

**Negative signals:**
- Body = `[removed]` → moderator removed it → `status: "removed"`
- Body = `[deleted]` OR author = `[deleted]` → user deleted it → `status: "deleted"`
- Comment missing from thread entirely → shadow-removed → `status: "removed"`
- Thread itself is removed/deleted → `status: "removed"`

**Author check:**
The submission's linked `reddit_username` is compared against the comment's actual author. A mismatch is an immediate hard rejection regardless of liveness.

**Subreddit check:**
The URL's subreddit is compared against the task's required subreddit (extracted from the target URL). Wrong subreddit = hard rejection.

### Confirmation pass (anti-false-positive guard)

When the first check returns `removed` or `deleted` during the **initial submission** (not a re-check), the system waits ~45 seconds and runs the check a second time. This prevents rejecting a submission because of a momentary Reddit API hiccup, CDN inconsistency, or a comment that hasn't fully propagated yet.

Only if both passes agree does the rejection become final.

---

## 6. Proxy Pool System

**File:** `bot/proxy.ts`

### Why proxies?

Reddit's CDN identifies and rate-limits datacenter IP ranges (AWS, Render, Fly, etc.). Without proxies, the liveness checker would get 429s or Cloudflare challenges within minutes of heavy checking. Proxies rotate the outbound IP so each request appears to come from a different residential or ISP address.

### Proxy sources (in priority order)

1. **Database (`system_settings.proxies`)** — The primary source. Admins paste a proxy list into the dashboard → Settings → Proxies. Supports Webshare's native `host:port:user:pass` export format and standard `http://user:pass@host:port` format.
2. **`proxies.txt` on disk** — Fallback for legacy setups or local development. Only used if no DB row exists at all.

Reloads every **60 seconds** automatically. Dashboard "Save" triggers an immediate reload (`reloadProxiesNow`).

### Scored pool + circuit breaking

Each proxy is tracked with a rolling window of the last 100 requests:
- **Success rate** (2xx responses)
- **Average latency**
- **Failure type** (timeout, 429, 403, Cloudflare)

Proxies that hit:
- **429 (rate limit)**: 10 minute cooldown
- **403 / Cloudflare block**: 30–60 minute cooldown
- **Connection timeout**: 5 minute cooldown

Cooldown proxies are skipped during rotation. Proxy selection prefers high success rate + low latency.

### Request modes

| Mode | When used |
|---|---|
| `proxyFetchText()` | General Reddit HTML/RSS fetching |
| `proxyFetchJson()` | Reddit JSON API calls |
| Racing (3 proxies + 1 direct) | Critical checks where speed matters |

The racing mode fires 3 proxy requests + 1 direct connection simultaneously and takes the first valid 2xx response, cancelling the rest. This gives a worst-case latency equal to the fastest proxy, not the average.

### Monitoring

`getProxyStats()` returns the full pool metrics to the dashboard. The `/ping` Discord command shows a summary. When more than 50% of proxies are on cooldown simultaneously, a warning embed is posted to `#task-logs`.

---

## 7. Database Schema

All tables are in `artifacts/db/src/schema.ts`, managed by Drizzle ORM migrations.

### `users`
The central user record. One row per Discord user.

| Column | Purpose |
|---|---|
| `discord_id` | Primary key — Discord snowflake |
| `balance_available` | Funds ready to withdraw (numeric) |
| `balance_pending` | Funds in hold period (not yet payable) |
| `trust_score` | 0–500 integer. Increased by on-time completions, decreased by violations |
| `is_verified` | Boolean — has the Verified role |
| `is_flagged` | Boolean — blocked from claiming/withdrawing |
| `referral_code` | Unique 8-char code auto-generated on verification |
| `referred_by` | Foreign key to the user who referred them |
| `workspace_channel_id` | Discord channel ID of their private workspace |
| `streak_days` | Consecutive days with accepted submissions |
| `last_submission_date` | For streak calculation |

### `reddit_accounts`
Maps Discord users to their Reddit accounts. One user can have multiple (configurable max, default 3).

| Column | Purpose |
|---|---|
| `discord_id` | FK → users |
| `reddit_username` | The Reddit handle |
| `last_used_at` | Timestamp of last submission using this account (for cooldowns) |
| `is_primary` | Whether this is the default account for validation |

### `tasks`
One row per task. Tasks can be standalone or part of a campaign.

| Column | Purpose |
|---|---|
| `id` | Auto-increment integer |
| `type` | Enum: `comment`, `post`, `upvote`, `share`, `join`, `twitter_*`, `quora_*` |
| `target_url` | The Reddit post/subreddit/tweet the user must interact with |
| `reward` | Decimal dollar amount |
| `max_slots` | How many users can claim this task |
| `slots_filled` | Current claim count |
| `status` | `open`, `closed`, `cancelled` |
| `time_limit_minutes` | How long a user has to submit proof after claiming |
| `hold_hours` | How long the reward is held after acceptance |
| `min_trust_score` | Minimum trust score to claim |
| `cooldown_enabled` | Whether the global cooldown applies to this task |
| `campaign_id` | FK → campaigns (null for standalone tasks) |
| `image_url` | Optional reference image shown on the task card |
| `created_by_discord_id` | Who created it |
| `discord_message_id` | The Discord message ID of the task embed (for live-editing) |

### `campaigns`
Groups of tasks. Created when using `/bulktask`.

| Column | Purpose |
|---|---|
| `id` | Auto-increment integer |
| `name` | Display name |
| `max_claims_per_user` | How many tasks from this campaign one user can claim |
| `interval_minutes` | Drip-feed delay between task drops (0 = post all at once) |
| `status` | `active`, `completed`, `cancelled` |

### `claims`
Active work-in-progress. One row per user per task (while active).

| Column | Purpose |
|---|---|
| `user_id` | FK → users |
| `task_id` | FK → tasks |
| `claimed_at` | When the user clicked Claim |
| `expires_at` | `claimed_at + time_limit_minutes` |
| `status` | `active`, `expired`, `completed` |

### `submissions`
The core earnings ledger. One row per completed claim.

| Column | Purpose |
|---|---|
| `id` | Auto-increment integer |
| `discord_id` | FK → users |
| `task_id` | FK → tasks |
| `proof_link` | The submitted Reddit/screenshot URL |
| `review_status` | `pending`, `accepted`, `rejected`, `pending_hold`, `pending_review` |
| `live_status` | `live`, `removed`, `deleted`, `unknown` (last known Reddit state) |
| `reward` | Snapshot of reward at time of submission |
| `hold_ends_at` | When the hold period expires |
| `moved_to_available` | Timestamp when reward was moved to `balance_available` |
| `reddit_username` | Which Reddit account was used |
| `rejection_reason` | Human-readable reason shown to user on rejection |
| `workspace_channel_id` | For posting status updates |

### `withdrawals`
Payout requests, one per user per payout cycle.

| Column | Purpose |
|---|---|
| `id` | Auto-increment integer |
| `discord_id` | FK → users |
| `amount` | Total amount |
| `status` | `pending`, `completed` |
| `payment_method` | `crypto`, `paypal`, `upi` |
| `payment_address` | Wallet/email/UPI at time of withdrawal |
| `creator_breakdown` | JSON — per-creator amounts for multi-funder campaigns |

### `system_settings`
Key-value store for runtime configuration. All values editable from the dashboard without redeploying.

| Key | Purpose |
|---|---|
| `proxies` | Proxy list (newline-separated) |
| `task_cooldown_minutes` | Global cooldown between task claims per user |
| `max_reddit_accounts` | How many Reddit accounts one Discord user can link |
| `weekly_payout_day` | Day of week for automatic payouts |
| `auto_bumper_*` | Dutch auction config (increment, interval, max reward) |

---

## 8. Admin Dashboard

**Location:** `artifacts/dashboard/`  
**Served at:** `/` (the root — the React SPA is served by Express)  
**API prefix:** `/admin/`  
**Auth:** Session cookie from OAuth2 Discord login, checked against `DISCORD_GUILD_ID`'s admin role list

### Pages

#### Overview / Stats (`/admin/stats`)
Live counters for:
- Total users, verified users, flagged users
- Total tasks created, open tasks, filled tasks
- Total submissions, acceptance rate, rejection rate
- Total paid out, pending balance across all users
- Proxy pool health (success rate, proxies on cooldown)

#### Users (`/admin/users`)
Full user table with:
- Discord tag, Reddit username(s), trust score, balance
- Flag/unflag, manual verify/unverify
- Balance adjustment (add/remove)
- Click-through to submission history

#### Tasks (`/admin/tasks`)
Full task list with filtering by status/type/campaign. Can cancel individual tasks or entire campaigns.

#### Submissions (`/admin/submissions`)
Every submission with:
- Proof link (opens in new tab)
- Current `live_status` (live/removed/deleted)
- Manual approve/reject controls
- Reopen slot button

#### Campaigns (`/admin/campaigns`)
Campaign summary cards showing:
- Total tasks, filled slots, total reward budget
- Per-task breakdown
- Cancel campaign button

#### Withdrawals (`/admin/withdrawals`)
Mirrors `#withdrawal-logs` in the dashboard. Shows pending payouts with per-creator payment status.

#### Settings (`/admin/settings`)
Tabbed settings panel:

| Tab | What it controls |
|---|---|
| **Proxies** | Paste or edit the proxy list. Save triggers immediate bot reload |
| **Cooldowns** | Task cooldown duration, per-task-type overrides |
| **Reddit** | Max accounts per user, karma/age minimums |
| **Payout** | Weekly payout day, minimum payout threshold |
| **Auto-bumper** | Enable/disable Dutch auction, bump amount, interval, max |

#### Audit Log
Rolling log of all admin actions (flag, unflag, balance changes, manual approvals, etc.) with actor, target, and timestamp.

---

## 9. Module-by-Module Reference

### `bot/index.ts`
Entry point for the Discord bot. Creates the `Client`, wires all event listeners, calls `startBot()`. Handles Discord reconnects with exponential backoff. Starts all schedulers inside `client.once("ready")`.

### `bot/interactions.ts`
Central router for all Discord interactions (slash commands, button clicks, modal submissions, select menus, autocomplete). Maps `customId` patterns to handler functions. All interaction handling goes through here.

### `bot/setup.ts`
Idempotent guild bootstrapper. `setupGuild(guild)` finds or creates:
- Category: Outpost
- Channels: `#tasks`, `#leaderboard`, `#verification-logs`, `#task-logs`, `#withdrawal-logs`
- Roles: Verified, Mod, Admin, Earner tiers (Bronze/Silver/Gold/Diamond)
Returns references to all channels and roles for use in handlers.

### `bot/reddit-validator.ts`
Validates Reddit proof URLs. See §5 for full pipeline description. Key exports:
- `validateRedditProof(url, redditUsername, taskType, targetUrl)` — full validation
- `recheckRedditLiveness(url, redditUsername)` — re-check only
- `resolveShareLink(url)` — resolve mobile share links
- `parseRedditProofUrl(url)` — extract postId, commentId, subreddit

### `bot/deepRedditCommentChecker.ts`
The primary Reddit fetch engine. Implements Tier 1 (direct JSON with session cookie) with fallback to Python and OAuth. Exposes `deepCheckComment(commentId, postId, subreddit, expectedAuthor)`.

### `bot/redditCookieManager.ts`
Manages a Reddit session cookie in memory. The cookie is set once via the dashboard (Settings → Reddit Cookie) and stored in `system_settings`. On startup, it's loaded into memory. If a fetch fails with 401/403, `forceRefreshCookie()` is called which re-fetches a fresh cookie from Reddit using the stored credentials.

### `bot/pythonClient.ts`
Interface to the Python curl_cffi sidecar. Serializes a request spec to JSON, spawns `python3 reddit_client.py` as a subprocess via stdin/stdout, and deserializes the response. Includes a 15-second subprocess timeout and structured error handling.

### `bot/proxy.ts`
Full proxy pool implementation. Scored pool, circuit breaking, rotation, metrics, racing. See §6 for full description.

### `bot/task-creation.ts`
Shared logic for creating tasks (used by both `/createtask` and `/bulktask`). Handles:
- Input normalization and validation
- DB insertion
- Discord embed construction and posting to `#tasks`
- Campaign grouping and drip-feed scheduling

### `bot/handlers/tasks.ts`
All task-related interaction handlers:
- `handleCreateTaskCommand` — `/createtask` slash command
- `handleTaskClaim` — "Claim Task" button
- `handleSubmitProof` — "Submit Proof" modal
- `handleBulkTask` — `/bulktask` slash command + CSV parsing
- `handleCancelTask`, `handleCancelCampaign`

### `bot/handlers/verification.ts`
All verification-related handlers:
- `handleVerifyCommand` — posts the verify panel
- `handleVerifyButton` — user clicks "Verify Me" → opens modal
- `handleVerifyModal` — processes Reddit username + runs checks
- `handleVerifyAccept` — mod manually accepts a pending verification
- `handleVerifyRevoke` — mod revokes a user's verification
- `handleVerifyUser` — `/verifyuser` command for manual admin override

### `bot/handlers/withdrawals.ts`
- `handleWithdrawalApprove` — admin clicks "Approve" on a withdrawal
- `handleMarkPaid` — per-creator "Mark Paid" button

### `bot/handlers/wallet.ts`
Handles `/setupi`, `/setwallet`, `/setpaypal` (saves payment info to user row) and `/wallet` (renders wallet card embed).

### `bot/handlers/leaderboard.ts`
`refreshLeaderboard(guild)` queries top earners (weekly + all-time), builds the leaderboard embed, and edits the pinned message in `#leaderboard`. `checkAndRolloverWeek(guild)` archives the current week and resets weekly counters if the UTC week has changed.

### `bot/handlers/admin.ts`
Admin-only commands: `/setup`, `/addmod`, `/removemod`, `/addadmin`, `/flag`, `/unflag`, `/addbalance`, `/removebalance`, `/massdm`, `/sendstats`, `/approvesubmission`, `/checksubmission`, `/reopenslot`, `/testurl`, `/health`, `/notifywalletmigration`.

### `bot/earnerRoles.ts`
Manages Earner tier roles (Bronze, Silver, Gold, Diamond). Called after each payout and on bot startup. Compares a user's total lifetime earnings against tier thresholds and assigns/removes roles accordingly.

### `bot/streak.ts`
Calculates and updates the `streak_days` counter. A streak increments when a user has an accepted submission on consecutive calendar days. Used for trust score bonuses.

### `bot/cache.ts`
In-memory LRU cache for frequently-read DB rows (users, tasks, claims). TTL-based expiry with manual invalidation on writes. `startCacheSweeper()` runs every 60 seconds to evict expired entries. Prevents N+1 DB queries during high-traffic interactions.

### `bot/db.ts`
Cached database access helpers: `getUserByDiscordId`, `getTaskByIdCached`, `getClaimByIdCached`, `upsertUser`, `invalidateTask`, `invalidateClaim`. All writes go through these helpers to ensure the in-memory cache stays consistent.

### `bot/discord-client.ts`
Singleton for the Discord `Client` instance. `setDiscordClient(client)` stores it; `getDiscordClient()` / `getPrimaryGuild()` retrieves it from anywhere in the codebase without circular imports.

### `bot/card-renderer.ts`
Renders PNG images using the `canvas` npm package (node-canvas). Used for:
- Verification review cards (shown to mods during manual review — includes Reddit karma, account age, profile link)
- Task stats cards (`/sendstats`)

### `lib/sheetsLogger.ts`
Logs submission events to a Google Sheet (configured via `GOOGLE_SHEETS_ID` + service account credentials). Every acceptance, rejection, and payout is appended as a row. This is the long-term archive used when `submissionRetention.ts` prunes the database.

### `lib/settings.ts`
Runtime settings loader. Reads from `system_settings` table with an in-memory cache (5 minute TTL). Exports typed getters: `getCooldownConfig()`, `getProxiesWithMeta()`, `getMaxRedditAccounts()`, etc.

### `lib/logger.ts`
`pino` logger configured for JSON output (structured logging). All bot code uses this instead of `console.log`. In development, output is pretty-printed; in production, raw JSON for log aggregation.

### `bot/constants.ts`
Central home for magic numbers and configuration: `COLORS` (embed hex colors), `TASK_TYPES`, `COIN_CHOICES`, `TASK_COOLDOWN_MINUTES`, `MAX_CONCURRENT_CLAIMS`, `ANTI_FRAUD` thresholds, `TASK_PING_DELAY_MS`.

### `bot/util.ts`
Shared utilities: `makeEmbed()` (creates an `EmbedBuilder` with brand color), `formatMoney()` (formats `$5.00`), `hasVerifiedRole()`, `hasModRole()`, `hasAdminRole()` (checks Discord member roles).

---

## Environment Variables Required

| Variable | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot authentication token |
| `DISCORD_CLIENT_ID` | Application ID (for slash command registration) |
| `DISCORD_GUILD_ID` | The server ID the bot operates in |
| `DATABASE_URL` | PostgreSQL connection string (Neon) |
| `SESSION_SECRET` | Express session signing secret |
| `REDDIT_CLIENT_ID` | OAuth app client ID (for Tier 3 validation fallback) |
| `REDDIT_CLIENT_SECRET` | OAuth app client secret |
| `GOOGLE_SHEETS_ID` | Google Sheet for long-term submission archiving |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account credentials for Sheets API |

---

*Guide generated from source: `artifacts/api-server/src/bot/` — last updated to match the deepRedditCommentChecker.ts primary-fetch refactor and mystatus description fix.*
