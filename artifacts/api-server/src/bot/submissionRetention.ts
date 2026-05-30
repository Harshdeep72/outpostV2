// ===========================================================================
// Submission Retention Cleaner
// ---------------------------------------------------------------------------
// Daily cron: deletes submissions older than RETENTION_DAYS. Each row is
// FIRST mirrored to its Google Sheet (Sheets API or webhook) as a final
// "deleted_from_db" event — the sheet IS the archive after deletion.
//
// SAFETY:
//   1. KILL-SWITCH: if NO destination exists anywhere (no sheet/webhook/env),
//      cron does NOTHING. Set GOOGLE_SHEETS_WEBHOOK_URL=disabled to force-
//      delete without archiving (intentional escape hatch only).
//   2. PER-ROW ARCHIVE CONFIRMATION: synchronously dispatch each row; DELETE
//      only the IDs whose dispatch returned ack. Failures retry tomorrow.
//   3. 22-day cutoff (21 requested + 1d grace).
//   4. 200/day cap; backlog catches up over days, never one-shot wipe.
// ===========================================================================

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  dispatchSheetSync, getSheetsConfig, type JoinedSubmissionRow,
} from "../lib/sheetsLogger.js";

const RETENTION_DAYS = 22;
const BATCH_LIMIT = 200;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FORCE_DELETE_FLAG = "disabled";

let started = false;

async function runOnce(): Promise<void> {
  const envRaw = (process.env.GOOGLE_SHEETS_WEBHOOK_URL ?? "").trim();
  const forceDeleteWithoutArchive = envRaw === FORCE_DELETE_FLAG;

  let cfg;
  try { cfg = await getSheetsConfig(); }
  catch (err) {
    logger.error({ err }, "Retention: getSheetsConfig failed; skipping run for safety");
    return;
  }

  if (!cfg.hasAnyDestination && !forceDeleteWithoutArchive) {
    logger.info(
      { retentionDays: RETENTION_DAYS },
      "Retention: no sheet/webhook configured anywhere; skipping (refuse to delete without archive). " +
      "Link a sheet to at least one campaign, set GOOGLE_SHEETS_WEBHOOK_URL, " +
      "or set GOOGLE_SHEETS_WEBHOOK_URL=disabled to force-delete without archiving."
    );
    return;
  }

  let candidates: JoinedSubmissionRow[] = [];
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
          WHERE s.submitted_at < NOW() - (${RETENTION_DAYS} || ' days')::interval
          ORDER BY s.submitted_at ASC
          LIMIT ${BATCH_LIMIT}`
    );
    candidates = r.rows;
  } catch (err) {
    logger.error({ err }, "Retention: candidate query failed; skipping run");
    return;
  }

  if (candidates.length === 0) {
    logger.debug("Retention: nothing to delete");
    return;
  }

  const confirmedDeleteIds: number[] = [];
  let skippedNoDestination = 0;
  let failedSend = 0;

  for (const row of candidates) {
    const hasSpreadsheet = !!row.sheets_spreadsheet_id?.trim();
    const hasWebhook = !!row.sheets_webhook_url?.trim();
    const hasEnvFallback = !!cfg.envUrl;

    if (!hasSpreadsheet && !hasWebhook && !hasEnvFallback) {
      if (forceDeleteWithoutArchive) {
        confirmedDeleteIds.push(parseInt(row.id));
      } else {
        skippedNoDestination++;
      }
      continue;
    }

    const ok = await dispatchSheetSync(row, "deleted_from_db", cfg.envUrl);
    if (ok) confirmedDeleteIds.push(parseInt(row.id));
    else failedSend++;
  }

  if (confirmedDeleteIds.length === 0) {
    logger.info(
      { candidateCount: candidates.length, skippedNoDestination, failedSend },
      "Retention: 0 rows confirmed for deletion (failures retry tomorrow)"
    );
    return;
  }

  try {
    await db.execute(
      sql`DELETE FROM submissions WHERE id = ANY(${confirmedDeleteIds}::int[])`
    );
    logger.info(
      {
        deletedCount: confirmedDeleteIds.length,
        candidateCount: candidates.length,
        skippedNoDestination, failedSend, retentionDays: RETENTION_DAYS,
      },
      "Retention: archived + deleted"
    );
  } catch (err) {
    logger.error(
      { err, attemptedCount: confirmedDeleteIds.length },
      "Retention: DELETE failed (rows still in DB; will retry tomorrow)"
    );
  }
}

export function startSubmissionRetention(): void {
  if (started) return;
  started = true;
  setTimeout(() => {
    void runOnce();
    setInterval(() => void runOnce(), RUN_INTERVAL_MS);
  }, 5 * 60 * 1000);
  logger.info(
    { retentionDays: RETENTION_DAYS, batchLimit: BATCH_LIMIT },
    "Submission retention cleaner started (daily, kill-switched on no-destination)"
  );
}
