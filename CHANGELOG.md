# Outpost Bot — Changelog

This file is the source of truth for the bot's release notes. Each `## v…`
section is parsed by the bot and posted to the `#updates` channel of every
guild it is in. Only **new** versions (newer than the last one a guild has
seen) get posted, so you can safely add a new section without spamming
old ones.

Format rules (please keep them so the parser stays happy):

- Each release starts a heading like `## v1.2.0 — 2026-05-01 — Optional title`
- Use `### Added`, `### Fixed`, `### Changed`, `### Removed` subsections
- Bullet lines start with `- `
- Newest version goes at the **top** of the list

---

## v1.4.2 — 2026-07-01 — Wallet Pending Balance Sync Fix

### Fixed
- Wallet Pending Balance: Fixed a bug where a user's pending balance in the `/wallet` command could become out-of-sync or show positive values (e.g. $0.50) even after their submissions were rejected or cleared. All user pending balances have been recalculated and fully synchronized.

---

## v1.4.1 — 2026-06-29 — Task Claim Window Extension

### Changed
- Task Claim Window: Increased the task claim window from 15 minutes to 20 minutes to give workers more time to complete tasks (such as warming up accounts/tools).

---

## v1.4.0 — 2026-06-26 — Mobile Reddit links & review improvements

### Fixed
- Mobile Reddit Share Links (/s/): Fixed an issue where submitting Reddit mobile share links (URLs containing `/s/`) would occasionally fail automated validation. The bot now correctly resolves these links to verify your comments instantly!

### Added
- Clearer Proof Validation: The bot now provides clearer error feedback when a submitted link does not match a valid Reddit post/comment, helping you catch mistakes early.
- Admin Proof Correction: Admins can now correct minor link typos directly within the manual review interface, ensuring your submissions are processed faster without needing to reject the claim and free the slot.

---

## v1.3.0 — 2026-05-20 — Maintenance

### Fixed
- Cooldown message now tells you **which** Reddit account frees up first, not just when.

### Added
- If your submission gets removed or deleted on Reddit, the bot now DMs you with the reason. (Was silent before.)

---

## v1.2.0 — 2026-05-06 — Verification & dashboard polish

### Fixed
- New users running `/verify` for the first time no longer hit a confusing "your previous account was revoked" error. The first-time path and the additional-account path are now properly separated.
- Multi-account flow: if a previously linked Reddit account was revoked by an admin, running `/verify` again starts a clean fresh verification instead of bouncing the user.
- Update notifications in `#updates` now ping `@everyone` so members actually see new patch notes.

### Changed
- Admin dashboard verify / unverify buttons now sync the Discord verified role in real time and refresh the bot's user cache, so changes show up instantly in both places.
- Cancelling a task or campaign from the dashboard now releases active claims and DMs each affected worker the cancellation reason.

### Added
- `/verifyuser` is now usable by both admins **and** mods (was admin-only).
- More descriptive error messages across `/bulktask` when a Google Docs link is pasted by mistake or the sheet isn't shared publicly.

---

## v1.1.0 — 2026-05-01 — Reddit liveness tracking

### Added
- Background job that re-checks every accepted Reddit submission every 5 minutes for up to 14 days. If a post gets removed by mods or deleted by the user, the bot now posts a colored alert to `#task-logs` and updates the dashboard automatically.
- New `#updates` channel that gets created on `/setup` (existing channels are never duplicated). Patch notes are posted here automatically when the bot is updated.
- Admin dashboard Submissions page now shows a live status badge (Live / Removed / Deleted / Pending / N/A for non-Reddit) and refreshes itself every 15 seconds.

### Changed
- Newly accepted Reddit submissions are immediately marked as `live` so the badge is accurate from the moment of approval.

### Fixed
- Conservative classification — flaky proxy responses no longer flip a `live` post to `deleted`. Only an explicit Reddit 404 or a `[deleted]` / `[removed]` marker on the post body counts.

---

## v1.0.0 — 2026-04-15 — First public release

### Added
- Reddit verification flow with mod review.
- Task system: create, claim, submit proof, auto-validate, manual review fallback.
- Wallet, trust score, weekly auto-payouts.
- Leaderboard with weekly + all-time rankings.
- Admin dashboard for managing users, submissions, tasks, payouts.
- Anti-cheat: duplicate detection, trust-gating, flagged-user blocking.
- Rotating Reddit proxy pool with success-rate metrics.
