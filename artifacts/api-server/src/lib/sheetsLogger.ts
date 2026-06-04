// ===========================================================================
// Submission → Google Sheets dispatcher.
// ---------------------------------------------------------------------------
// THREE possible destinations per row (resolved in this order):
//
//   1. campaigns.sheets_spreadsheet_id  →  direct Sheets API call via the
//      service account (NEW flow — created by "Create Sheet" button).
//   2. campaigns.sheets_webhook_url     →  POST to per-campaign Apps Script
//      webhook (legacy Option-A flow).
//   3. process.env.GOOGLE_SHEETS_WEBHOOK_URL → POST to global Apps Script
//      webhook (oldest single-sheet flow).
//
// If NONE of the three are configured anywhere in the system, every hot-
// path call returns IMMEDIATELY (no DB work, no log spam) via the
// hasAnyDestination cache.
//
// SAFETY:
//   * Every hot-path call is fire-and-forget, swallows everything, never
//     throws. The submission flow CANNOT be slowed or broken by Sheets.
//   * postSheetSync() and appendSubmissionRow() return Promise<boolean> for
//     the retention cron's "only delete if archive landed" guarantee.
// ===========================================================================

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";
import {
  appendSubmissionRow,
  appendSubmissionRowsBulk,
  writeSubmissionRowAt,
  writeSubmissionRowsBatch,
  isGoogleSheetsConfigured,
  isAnyGoogleAuthAvailable,
} from "./googleSheets.js";

// ---------------------------------------------------------------------------
// Positional row layout: "task #N in campaign → sheet row N+1".
// ---------------------------------------------------------------------------
// Tasks have global serial IDs (id=5 in campaign A, id=11 in campaign B are
// both "tasks"). For per-campaign sheets the operator wants the Nth task of
// THAT campaign to land in row N+1 (row 1 = header). We compute the position
// with ROW_NUMBER() OVER (PARTITION BY campaign_id ORDER BY id ASC), so the
// FIRST task of a campaign is position 1 → row 2, regardless of global id.
//
// Returns null when the task has no campaign (one-off /createtask) or when
// the lookup fails — callers fall back to plain append in that case.
async function getTaskCampaignPosition(taskId: string | number): Promise<number | null> {
  try {
    const r = await db.execute<{ pos: string | null }>(sql`
      WITH target AS (
        SELECT campaign_id FROM tasks WHERE id = ${taskId}
      ),
      ranked AS (
        SELECT id,
               ROW_NUMBER() OVER (ORDER BY id ASC) AS rn
        FROM tasks
        WHERE campaign_id IS NOT NULL
          AND campaign_id = (SELECT campaign_id FROM target)
      )
      SELECT rn::text AS pos FROM ranked WHERE id = ${taskId} LIMIT 1
    `);
    const pos = r.rows[0]?.pos;
    if (!pos) return null;
    const n = parseInt(pos);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    logger.warn({ err, taskId }, "getTaskCampaignPosition failed");
    return null;
  }
}

export type SubmissionEvent =
  | "submitted"
  | "accepted"
  | "rejected"
  | "flagged"
  | "paid"
  | "removed"
  | "deleted_from_db"
  | "pending_hold";

// ---------------------------------------------------------------------------
// Config cache — "is ANY destination configured ANYWHERE?" in O(1).
// ---------------------------------------------------------------------------
interface SheetsConfig {
  hasAnyDestination: boolean;
  envUrl: string | null;
  /** Whether the GOOGLE_SERVICE_ACCOUNT_JSON env var is present + parseable. */
  serviceAccountReady: boolean;
  /** Any campaign with EITHER a spreadsheet_id OR a webhook_url set. */
  campaignsWithDestination: number;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
let cachedConfig: SheetsConfig | null = null;
let inflightFetch: Promise<SheetsConfig> | null = null;

async function loadConfig(): Promise<SheetsConfig> {
  const envUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL?.trim() || null;
  // serviceAccountReady is true if EITHER OAuth (operator-connected) OR the
  // SA env var is configured — both paths can write to a campaign's sheet.
  const serviceAccountReady = await isAnyGoogleAuthAvailable();
  let campaignsWithDestination = 0;
  try {
    const r = await db.execute<{ n: string }>(
      sql`SELECT COUNT(*)::text AS n FROM campaigns
          WHERE (sheets_webhook_url IS NOT NULL AND sheets_webhook_url <> '')
             OR (sheets_spreadsheet_id IS NOT NULL AND sheets_spreadsheet_id <> '')`
    );
    campaignsWithDestination = parseInt(r.rows[0]?.n ?? "0");
  } catch (err) {
    logger.warn({ err }, "sheetsLogger: campaign destination count failed; assuming 0");
  }
  return {
    hasAnyDestination: !!envUrl || campaignsWithDestination > 0,
    envUrl,
    serviceAccountReady,
    campaignsWithDestination,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
}

export async function getSheetsConfig(force = false): Promise<SheetsConfig> {
  if (!force && cachedConfig && cachedConfig.expiresAt > Date.now()) return cachedConfig;
  if (inflightFetch) return inflightFetch;
  inflightFetch = loadConfig()
    .then((cfg) => { cachedConfig = cfg; inflightFetch = null; return cfg; })
    .catch((err) => {
      inflightFetch = null;
      logger.warn({ err }, "sheetsLogger: getSheetsConfig failed");
      const fallback: SheetsConfig = {
        hasAnyDestination: false, envUrl: null, serviceAccountReady: false,
        campaignsWithDestination: 0, expiresAt: Date.now() + 5_000,
      };
      cachedConfig = fallback;
      return fallback;
    });
  return inflightFetch;
}

export function invalidateSheetsConfigCache(): void { cachedConfig = null; }

// ---------------------------------------------------------------------------
// Backfill — write ALL existing submissions of a campaign into its sheet.
// ---------------------------------------------------------------------------
/**
 * Pull every submission belonging to `campaignId` and bulk-append them to
 * `spreadsheetId`. Used by:
 *   1) the create-sheet route, so a sheet created AFTER a campaign already
 *      has submissions still gets fully populated (instead of staying empty
 *      because logSubmissionEvent only fires on NEW events).
 *   2) a manual "Backfill past submissions" button so operators can re-run
 *      this on demand.
 *
 * Picks an event label per row based on terminal status so the "Event"
 * column is the most useful single value: paid > rejected > flagged >
 * accepted > submitted.
 */
export async function backfillCampaignSheet(
  campaignId: number,
  spreadsheetId: string
): Promise<{ ok: boolean; written: number; error?: string }> {
  let rows: JoinedSubmissionRow[];
  try {
    const r = await db.execute<JoinedSubmissionRow>(
      sql`SELECT s.id, s.task_id, s.discord_id, s.proof_link, s.reward,
                 s.review_status, s.live_status,
                 s.submitted_at, s.reviewed_at, s.paid_at,
                 t.title AS task_title, t.type AS task_type, t.reddit_link AS task_link,
                 t.campaign_id, c.title AS campaign_title,
                 c.sheets_webhook_url, c.sheets_spreadsheet_id,
                 u.discord_username, u.reddit_username
          FROM submissions s
          LEFT JOIN tasks t      ON t.id = s.task_id
          LEFT JOIN campaigns c  ON c.id = t.campaign_id
          LEFT JOIN users u      ON u.discord_id = s.discord_id
          WHERE t.campaign_id = ${campaignId}
          ORDER BY s.submitted_at ASC NULLS LAST, s.id ASC`
    );
    rows = r.rows;
  } catch (err) {
    logger.error({ err, campaignId }, "backfillCampaignSheet: DB query failed");
    return { ok: false, written: 0, error: (err as Error).message };
  }

  if (rows.length === 0) {
    // Still wipe the data area so a backfill-on-empty leaves a clean sheet.
    return writeSubmissionRowsBatch(spreadsheetId, [], { clearBeforeWrite: true });
  }

  // Compute each task's position within the campaign (id ASC = creation order).
  // Build entries as { rowNum: pos+1, row: ... } so task #N → sheet row N+1.
  let positions: Map<string, number>;
  try {
    const posRows = await db.execute<{ id: string; pos: string }>(sql`
      SELECT id::text AS id,
             ROW_NUMBER() OVER (ORDER BY id ASC)::text AS pos
      FROM tasks
      WHERE campaign_id = ${campaignId}
    `);
    positions = new Map(posRows.rows.map((r: { id: string; pos: string }) => [String(r.id), parseInt(r.pos)]));
  } catch (err) {
    logger.error({ err, campaignId }, "backfillCampaignSheet: position lookup failed");
    return { ok: false, written: 0, error: (err as Error).message };
  }

  // Pick the most informative event per submission, then bucket by row.
  // If multiple submissions exist for the same task (allow_multi_claim), keep
  // the LATEST one (rows are pre-ordered by submitted_at ASC, so iterate and
  // overwrite — final value wins). Stable & deterministic.
  const byRow = new Map<number, unknown[]>();
  for (const row of rows) {
    let event: SubmissionEvent = "submitted";
    const rs = (row.review_status ?? "").toLowerCase();
    if (row.paid_at) event = "paid";
    else if (rs === "rejected") event = "rejected";
    else if (rs === "flagged") event = "flagged";
    else if (rs === "accepted" || rs === "approved") event = "accepted";

    const pos = positions.get(String(row.task_id));
    if (!pos) continue; // task somehow not found in campaign — skip safely
    byRow.set(pos + 1, buildSheetRow(row, event));
  }

  const entries = Array.from(byRow.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([rowNum, row]) => ({ rowNum, row }));

  return writeSubmissionRowsBatch(spreadsheetId, entries, { clearBeforeWrite: true });
}

// ---------------------------------------------------------------------------
// Joined-row shape returned by both logSubmissionEvent's SELECT and the
// retention SELECT. Shared so payload/row builders work for both call sites.
// ---------------------------------------------------------------------------
export interface JoinedSubmissionRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  discord_id: string;
  proof_link: string;
  reward: string;
  review_status: string;
  live_status: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  paid_at: string | null;
  task_title: string | null;
  task_type: string | null;
  task_link: string | null;
  campaign_id: string | null;
  campaign_title: string | null;
  sheets_webhook_url: string | null;
  sheets_spreadsheet_id: string | null;
  discord_username: string | null;
  reddit_username: string | null;
}

/** Build the webhook payload (object form) for Apps Script destinations. */
export function buildSheetPayload(row: JoinedSubmissionRow, event: SubmissionEvent): Record<string, unknown> {
  return {
    event,
    timestamp: new Date().toISOString(),
    submission_id: parseInt(row.id),
    discord_user: row.discord_username ?? row.discord_id,
    reddit_user: row.reddit_username ?? "",
    task_title: row.task_title ?? "",
    task_type: row.task_type ?? "",
    task_link: row.task_link ?? "",
    submitted_link: row.proof_link,
    reward: row.reward,
    status: row.review_status,
    live_status: row.live_status,
    campaign: row.campaign_title ?? "",
    submitted_at: row.submitted_at ?? "",
    reviewed_at: row.reviewed_at ?? "",
    paid_at: row.paid_at ?? "",
  };
}

/** Map raw status/event/type strings to a richer "icon + label" display
 *  string for the Sheets visual layer. These strings are write-only —
 *  nothing in the bot reads them back from Sheets, so changing the
 *  display does NOT affect any logic. Falls back to raw value on
 *  unknown inputs so future event types still render. */
function decorateEvent(v: string | null | undefined): string {
  switch ((v ?? "").toLowerCase()) {
    case "submitted": return "📝 Submitted";
    case "accepted":  return "✅ Accepted";
    case "approved":  return "✅ Approved";
    case "rejected":  return "❌ Rejected";
    case "flagged":   return "⚠️ Flagged";
    case "paid":      return "💰 Paid";
    default:          return v ?? "";
  }
}
function decorateStatus(v: string | null | undefined): string {
  switch ((v ?? "").toLowerCase()) {
    case "accepted":  return "✅ Accepted";
    case "approved":  return "✅ Approved";
    case "rejected":  return "❌ Rejected";
    case "flagged":   return "⚠️ Flagged";
    case "pending":   return "⏳ Pending";
    case "submitted": return "📝 Submitted";
    case "paid":      return "💰 Paid";
    default:          return v ?? "";
  }
}
function decorateLiveStatus(v: string | null | undefined): string {
  const s = (v ?? "").toLowerCase();
  if (!s) return "";
  if (s.includes("live"))    return "🟢 Live";
  if (s.includes("removed")) return "🔴 Removed";
  if (s.includes("deleted")) return "🔴 Deleted";
  if (s.includes("shadow"))  return "👻 Shadow";
  return v ?? "";
}
function decorateType(v: string | null | undefined): string {
  switch ((v ?? "").toLowerCase()) {
    case "post":    return "📝 Post";
    case "comment": return "💬 Comment";
    default:        return v ?? "";
  }
}

/** Build the row (array form) for Sheets-API destinations. Order MUST
 *  match SHEET_HEADERS in googleSheets.ts. Event/Status/Type/Live Status
 *  are decorated with leading emoji icons to mimic the reference sheet
 *  style the operator requested — purely visual, no logic reads these. */
export function buildSheetRow(row: JoinedSubmissionRow, event: SubmissionEvent): unknown[] {
  return [
    new Date().toISOString(),               // Timestamp
    decorateEvent(event),                   // Event
    parseInt(row.id),                       // Submission ID
    row.discord_username ?? row.discord_id, // Discord User
    row.reddit_username ?? "",              // Reddit User
    row.task_title ?? "",                   // Task Title
    decorateType(row.task_type),            // Task Type
    row.task_link ?? "",                    // Task Link
    row.proof_link,                         // Submitted Link
    row.reward,                             // Reward
    decorateStatus(row.review_status),      // Status
    decorateLiveStatus(row.live_status),    // Live Status
    row.campaign_title ?? "",               // Campaign
    row.submitted_at ?? "",                 // Submitted At
    row.reviewed_at ?? "",                  // Reviewed At
    row.paid_at ?? "",                      // Paid At
  ];
}

// ---------------------------------------------------------------------------
// Low-level dispatchers.
// ---------------------------------------------------------------------------
function fireWebhook(url: string, payload: Record<string, unknown>, submissionId: number): void {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .then((r) => { if (!r.ok) logger.warn({ status: r.status, submissionId }, "Sheets webhook non-OK"); })
    .catch((err) => logger.warn({ err: err?.message ?? String(err), submissionId }, "Sheets webhook failed"))
    .finally(() => clearTimeout(timeout));
}

export async function postSheetSync(url: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!r.ok) { logger.warn({ status: r.status }, "postSheetSync non-OK"); return false; }
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message ?? String(err) }, "postSheetSync failed");
    return false;
  } finally { clearTimeout(timeout); }
}

/**
 * Resolve the destination for a row and dispatch SYNCHRONOUSLY (awaited).
 * Used by retention to confirm archive landed before deleting. Returns true
 * iff the dispatch was acknowledged.
 */
export async function dispatchSheetSync(
  row: JoinedSubmissionRow,
  event: SubmissionEvent,
  envUrl: string | null
): Promise<boolean> {
  const spreadsheetId = row.sheets_spreadsheet_id?.trim();
  if (spreadsheetId) {
    // Positional write: task #N in campaign → row N+1. Falls back to append
    // when the task has no campaign (one-off tasks) or position lookup fails.
    const pos = await getTaskCampaignPosition(row.task_id);
    if (pos != null) {
      return writeSubmissionRowAt(spreadsheetId, pos + 1, buildSheetRow(row, event));
    }
    return appendSubmissionRow(spreadsheetId, buildSheetRow(row, event));
  }
  const webhookUrl = row.sheets_webhook_url?.trim() || envUrl;
  if (!webhookUrl) return false;
  return postSheetSync(webhookUrl, buildSheetPayload(row, event));
}

// ---------------------------------------------------------------------------
// Public hot-path API.
// ---------------------------------------------------------------------------

/** Legacy entry — kept for backward compatibility. Still works. */
export function logSubmissionToSheet(row: {
  submissionId: number;
  event?: SubmissionEvent;
  discordUser: string;
  redditUser: string | null;
  taskTitle: string;
  taskType: string;
  taskLink: string;
  submittedLink: string;
  reward: number | string;
  status: string;
  liveStatus?: string | null;
  campaign?: string | null;
  submittedAt?: string | null;
  reviewedAt?: string | null;
  paidAt?: string | null;
  webhookUrlOverride?: string | null;
}): void {
  try {
    const url = row.webhookUrlOverride ?? process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    if (!url) return;
    const event: SubmissionEvent = row.event ?? "submitted";
    fireWebhook(url, {
      event, timestamp: new Date().toISOString(),
      submission_id: row.submissionId, discord_user: row.discordUser,
      reddit_user: row.redditUser ?? "", task_title: row.taskTitle,
      task_type: row.taskType, task_link: row.taskLink,
      submitted_link: row.submittedLink, reward: row.reward, status: row.status,
      live_status: row.liveStatus ?? "", campaign: row.campaign ?? "",
      submitted_at: row.submittedAt ?? "", reviewed_at: row.reviewedAt ?? "",
      paid_at: row.paidAt ?? "",
    }, row.submissionId);
  } catch (err) {
    logger.warn({ err, submissionId: row.submissionId }, "logSubmissionToSheet swallowed");
  }
}

/**
 * Hot-path event logger. Fire-and-forget. Returns immediately.
 *
 *   void logSubmissionEvent(subId, "accepted");
 *
 * Fast-paths to a complete no-op when no destination is configured anywhere.
 */
export function logSubmissionEvent(submissionId: number, event: SubmissionEvent): void {
  (async () => {
    try {
      const cfg = await getSheetsConfig();
      if (!cfg.hasAnyDestination) return; // FAST PATH

      const r = await db.execute<JoinedSubmissionRow>(
        sql`SELECT s.id, s.task_id, s.discord_id, s.proof_link, s.reward,
                   s.review_status, s.live_status,
                   s.submitted_at, s.reviewed_at, s.paid_at,
                   t.title AS task_title, t.type AS task_type, t.reddit_link AS task_link,
                   t.campaign_id, c.title AS campaign_title,
                   c.sheets_webhook_url, c.sheets_spreadsheet_id,
                   u.discord_username, u.reddit_username
            FROM submissions s
            LEFT JOIN tasks t      ON t.id = s.task_id
            LEFT JOIN campaigns c  ON c.id = t.campaign_id
            LEFT JOIN users u      ON u.discord_id = s.discord_id
            WHERE s.id = ${submissionId}
            LIMIT 1`
      );
      const row = r.rows[0];
      if (!row) return;

      // Dispatch — Sheets API wins if spreadsheet_id set, else webhook flow.
      const spreadsheetId = row.sheets_spreadsheet_id?.trim();
      if (spreadsheetId) {
        // Positional write: task #N in campaign → row N+1. Falls back to
        // append when task has no campaign or position lookup fails so the
        // hot path NEVER breaks. Fire-and-forget, never blocks the bot.
        const pos = await getTaskCampaignPosition(row.task_id);
        if (pos != null) {
          void writeSubmissionRowAt(spreadsheetId, pos + 1, buildSheetRow(row, event)).catch(() => {});
        } else {
          void appendSubmissionRow(spreadsheetId, buildSheetRow(row, event)).catch(() => {});
        }
        return;
      }
      const webhookUrl = row.sheets_webhook_url?.trim() || cfg.envUrl;
      if (!webhookUrl) return;
      fireWebhook(webhookUrl, buildSheetPayload(row, event), submissionId);
    } catch (err) {
      logger.warn({ err, submissionId, event }, "logSubmissionEvent failed (swallowed)");
    }
  })();
}
