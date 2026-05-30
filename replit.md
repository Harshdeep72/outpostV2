# Outpost Bot Monorepo

## Overview

The Outpost Bot is a pnpm workspace monorepo designed to provide a full-featured Reddit micro-task earning system integrated with Discord. It allows users to earn rewards by completing micro-tasks on Reddit. The project also includes a full-stack admin dashboard for managing the system.

**Key Capabilities:**
- Reddit verification and task management.
- User wallet and trust score system.
- Leaderboard and weekly auto-payouts.
- Admin dashboard for comprehensive management.
- Robust anti-cheat mechanisms and performance optimizations.

## User Preferences

I prefer iterative development with clear communication at each step. Please ask for confirmation before making any significant architectural changes or adding new external dependencies. For code changes, prioritize readability and maintainability.

## System Architecture

The project is built as a pnpm monorepo using TypeScript, targeting Node.js 24. The backend API is developed with Express 5, interacting with a PostgreSQL database via Drizzle ORM. Discord bot functionalities are implemented using discord.js v14. Zod is used for validation, and Orval generates API hooks from an OpenAPI specification.

**UI/UX Decisions (Admin Dashboard):**
- **Theme:** Dark theme with a color palette of `#0c0c0c` for background, `#111111` for sidebar, and `#1a1a1a` for cards, accented with red-600 and yellow-400.
- **Login:** Cookie-based, httpOnly Express sessions stored in Postgres via `connect-pg-simple`.
- **Navigation:** Sidebar grouped by Overview, Members, Tasks, Admin, and Tools, with admin-only items hidden for client users.

**Technical Implementations:**
- **Bot Features:**
    - **Reddit Verification:** `/verify` command for user verification, involving Reddit API fetches and mod review.
    - **Task System:** `/createtask` command for mod/admin to create various Reddit-based tasks. Includes claim validation, submission proof, and review workflow.
    - **Wallet System:** `/wallet` to view balances and trust score, `/setupi` and `/setwallet` to configure payout methods.
    - **Trust Score:** Dynamic scoring system based on task performance.
    - **Leaderboard:** Auto-updated, pinned message displaying weekly, all-time, and most trusted users.
    - **Admin Balance Adjustment:** Slash commands and dashboard interface for managing user balances.
    - **Weekly Auto-Payout:** Automated payout system with admin approval/rejection.
    - **Anti-Cheat:** Duplicate checks, minimum trust gating, and flagged user blocking.
    - **Reddit Liveness Checker:** Background job that re-checks accepted Reddit submissions every 5 minutes. If a post is removed by mods or deleted by the user within 14 days of submission, it flips `submissions.live_status` to `removed`/`deleted`, records the reason, and posts a colored alert embed to the task-logs channel pinging the admin role. Manual run available at `POST /api/admin/liveness/run-now`.
    - **Update Notifier / Patch Notes:** `CHANGELOG.md` at the repo root is the source of truth for bot release notes. On every boot, the bot parses it, compares each guild's `server_config.last_changelog_version` against the available versions, and posts any newer entries as embeds to that guild's `#updates` channel (created automatically by `/setup`, never duplicated if it already exists). First-ever boot for a guild silently records the latest version as a baseline so historical entries don't spam the channel. To ship a new release: add a `## v1.2.0 — YYYY-MM-DD — Title` section at the top of `CHANGELOG.md` and restart the bot.
- **Performance & Reliability:**
    - **DB Pool:** Configured with `max:20 min:2` connections and keep-alive.
    - **TTL Cache:** LRU caches for various entities (users, tasks, claims, etc.) with a periodic sweeper for optimal performance.
    - **Smart Upsert:** Optimizes user creation by skipping DB writes when possible.
    - **Atomic Slot Reservation:** Ensures integrity of task slot claims using SQL transactions.
    - **Proxy Layer:** Uses a rotating proxy pool (`proxies.txt`) for Reddit API access to bypass IP blocks, with success-rate metrics.
    - **Asynchronous Operations:** `interactionCreate` does not await `upsertUser()`, and slow handlers use `defer/showModal` early.
    - **Combined Queries:** Optimized database queries for efficiency.
- **Admin Dashboard Functionality:**
    - Pages for Overview, Users, Verified Users (with admin Unverify action that flips `users.verified` and removes the Verified Discord role via `POST /api/admin/users/:id/unverify`), Tasks, Create Task, Bulk Create, Submissions (auto-refreshes every 15s with a live/removed/deleted status badge per row driven by the Reddit Liveness Checker), Campaigns, Applications, Dashboard Users, Reddit Test, Console.
    - Public pages for `/login`, `/register`, `/setup-password`.
    - Admin API routes for managing users, submissions, tasks, applications, and system settings.

**System Design Choices:**
- **Monorepo:** Organized with pnpm workspaces for managing multiple packages.
- **Database Schema:** Defined using Drizzle ORM, with tables for users, tasks, claims, submissions, withdrawals, trust_logs, server_config, weekly_winners, referrals, campaigns, and admin_users.
- **Modularity:** Bot logic is separated into handlers for different commands (verification, tasks, wallet, etc.).
- **Error Handling:** Robust error handling, including specific Discord permission error messages for `/leaderboard`.
- **Branding:** Consistent branding across all embeds with a custom footer.

## External Dependencies

- **PostgreSQL:** Primary database for all application data.
- **Discord API:** Used for bot interactions, commands, and guild management.
- **Reddit API:** Accessed for user verification, profile fetching, and submission validation, via a proxy layer.
- **Orval:** Used for API client and schema generation from OpenAPI.
- **Zod:** Schema validation library.
- **connect-pg-simple:** PostgreSQL session store for Express.
- **undici:** HTTP/1.1 client used by the proxy agent.