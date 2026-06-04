// ===========================================================================
// Google Sheets API client — Service Account flow ("Create Sheet" button).
// ---------------------------------------------------------------------------
// Replaces the per-sheet Apps Script setup. The operator does a ONE-TIME
// Google Cloud setup:
//   1. Create a Google Cloud project.
//   2. Enable Google Sheets API + Google Drive API.
//   3. Create a Service Account, generate a JSON key.
//   4. Paste the full JSON into the GOOGLE_SERVICE_ACCOUNT_JSON env var
//      on Render (production) and/or Replit (dev).
//
// After that, every campaign just clicks "Create Sheet" — the bot creates
// a brand new Google Sheet, writes headers, makes it shareable, and pipes
// every submission event to it via Sheets API directly. No Apps Script.
//
// SAFETY:
//   * If GOOGLE_SERVICE_ACCOUNT_JSON is missing or malformed, every helper
//     either returns false (append) or throws a clear error (create) — the
//     bot continues running normally; only the Sheets-API path is disabled.
//   * Auth client is built once and cached.
//   * Uses the `drive.file` scope (NOT full drive) so the bot can only see
//     and modify files it created — minimum-privilege.
// ===========================================================================

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { logger } from "./logger.js";
import { getGoogleOAuthClient, loadStoredOAuth } from "./googleOAuth.js";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  // drive.file → bot can ONLY touch files it created. Cannot read or modify
  // any other sheet in your Drive. Minimum-privilege scope.
  "https://www.googleapis.com/auth/drive.file",
];

/** Header row written into every newly-created campaign sheet. Order MUST
 *  match the order produced by buildSheetRow() in sheetsLogger.ts. */
export const SHEET_HEADERS = [
  "📅 Timestamp",
  "🎯 Event",
  "🆔 Submission ID",
  "👤 Discord User",
  "🤖 Reddit User",
  "📝 Task Title",
  "🏷️ Task Type",
  "🔗 Task Link",
  "📎 Submitted Link",
  "💰 Reward",
  "📊 Status",
  "📡 Live Status",
  "🎪 Campaign",
  "⏱️ Submitted At",
  "✅ Reviewed At",
  "💵 Paid At",
];

let cachedAuth: InstanceType<typeof google.auth.GoogleAuth> | null = null;
let cachedEmail: string | null = null;
let cachedProjectId: string | null = null;
let lastParseError: string | null = null;

function loadAuth(): InstanceType<typeof google.auth.GoogleAuth> | null {
  if (cachedAuth) return cachedAuth;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) {
    lastParseError = "GOOGLE_SERVICE_ACCOUNT_JSON env var not set";
    return null;
  }
  try {
    const credentials = JSON.parse(raw);
    if (!credentials.client_email || !credentials.private_key) {
      lastParseError = "Service account JSON missing client_email or private_key";
      return null;
    }
    cachedEmail = credentials.client_email;
    cachedProjectId = credentials.project_id ?? null;
    cachedAuth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
    lastParseError = null;
    return cachedAuth;
  } catch (err) {
    lastParseError = "Service account JSON failed to parse: " + (err as Error).message;
    logger.error({ err }, "googleSheets: failed to parse GOOGLE_SERVICE_ACCOUNT_JSON");
    return null;
  }
}

/** True iff the service account env var is set and parseable. */
export function isGoogleSheetsConfigured(): boolean {
  return loadAuth() !== null;
}

/** True iff EITHER path is usable: OAuth user connected, OR service account
 *  env var set. Used by sheetsLogger's "do we have any Google destination?"
 *  cache so the new OAuth-only setup doesn't get short-circuited. */
export async function isAnyGoogleAuthAvailable(): Promise<boolean> {
  if (isGoogleSheetsConfigured()) return true;
  const stored = await loadStoredOAuth();
  return !!stored;
}

type ResolvedAuth = {
  client: OAuth2Client | InstanceType<typeof google.auth.GoogleAuth>;
  kind: "oauth" | "service_account";
};

/** Resolve the active auth client. OAuth (operator-connected) wins; falls
 *  back to the service account if no operator has connected yet. Returns
 *  null if NEITHER path is configured. The `kind` field is derived from
 *  what we actually built, so callers don't have to guess from DB state. */
async function resolveAuth(): Promise<ResolvedAuth | null> {
  const oauth = await getGoogleOAuthClient();
  if (oauth) return { client: oauth, kind: "oauth" };
  const sa = loadAuth();
  if (sa) return { client: sa, kind: "service_account" };
  return null;
}

/** True iff an operator has connected their own Google account via OAuth.
 *  When true, createCampaignSheet uses the operator's Drive (15 GB free)
 *  instead of the service account's 0 GB, sidestepping the storage-quota
 *  trap completely. */
export async function isOAuthConnected(): Promise<boolean> {
  return (await loadStoredOAuth()) !== null;
}

/** Returns the service account's client_email (or null if not configured).
 *  Useful for the dashboard to display "share your sheet with this email"
 *  in the Option-A fallback flow. */
export function getServiceAccountEmail(): string | null {
  loadAuth();
  return cachedEmail;
}

/** Returns the project_id parsed from the service account JSON. Useful for
 *  diagnostics — confirms which Cloud project the bot is actually talking to. */
export function getServiceAccountProjectId(): string | null {
  loadAuth();
  return cachedProjectId;
}

/** Returns a human-readable reason why Sheets is not configured. */
export function getServiceAccountError(): string {
  loadAuth();
  return lastParseError ?? "Unknown error";
}

/**
 * Create a brand new Google Sheet owned by the service account, with headers
 * written, header row frozen + bolded, and "anyone with the link can view"
 * sharing applied so the operator can open it from the dashboard.
 *
 * Returns the spreadsheet ID and the human URL.
 */
export async function createCampaignSheet(title: string): Promise<{ spreadsheetId: string; url: string }> {
  const resolved = await resolveAuth();
  if (!resolved) throw new Error(lastParseError ?? "Google Sheets not configured (neither OAuth nor service account is set up)");
  // CRITICAL: derive from the actual resolved client, not the stored DB row.
  // If the OAuth env vars were unset but a stale DB row exists,
  // getGoogleOAuthClient() returns null and we end up on the SA path — we
  // MUST honour SHEETS_PARENT_FOLDER_ID in that case to avoid the 0 GB trap.
  const usingOAuth = resolved.kind === "oauth";

  const sheets = google.sheets({ version: "v4", auth: resolved.client as any });
  const drive = google.drive({ version: "v3", auth: resolved.client as any });

  // 1. Create the spreadsheet.
  //
  // CRITICAL: Service accounts attached to personal-Gmail Google Cloud
  // projects have 0 GB of Drive storage. If we use sheets.spreadsheets.create
  // (which puts the file in the SA's own Drive), Google returns a misleading
  // "The caller does not have permission" 403 instead of a proper quota error.
  //
  // The fix: if SHEETS_PARENT_FOLDER_ID is set, we use drive.files.create
  // with parents=[folder] — the file is then stored against the FOLDER OWNER's
  // quota (i.e. the operator's personal 15 GB), not the service account's 0 GB.
  // The operator just has to share the folder with the SA email as "Editor"
  // once. This is the recommended pattern for non-Workspace setups.
  //
  // If SHEETS_PARENT_FOLDER_ID is NOT set, we fall back to the old path,
  // which works for Google Workspace customers but will 403 on personal accounts.
  // OAuth path doesn't need SHEETS_PARENT_FOLDER_ID — the file is created
  // directly in the operator's own Drive against their personal 15 GB quota.
  // The "0 GB service account" trap simply doesn't apply, so we use the
  // simpler sheets.spreadsheets.create flow.
  const parentFolderId = usingOAuth ? null : (process.env.SHEETS_PARENT_FOLDER_ID?.trim() || null);
  let id: string;
  let tabId: number = 0;

  if (parentFolderId) {
    // Drive-API path: create the spreadsheet as a Drive file inside the
    // operator-owned folder. Storage counts against the folder's owner.
    const file = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [parentFolderId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    if (!file.data.id) throw new Error("Drive file creation returned no id");
    id = file.data.id;

    // Now reshape the sheet: rename the default "Sheet1" tab to "Submissions"
    // and freeze row 1. We must look up the existing tab's sheetId first.
    const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
    const firstSheet = meta.data.sheets?.[0]?.properties;
    tabId = firstSheet?.sheetId ?? 0;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: {
              sheetId: tabId,
              title: "Submissions",
              gridProperties: { frozenRowCount: 1 },
            },
            fields: "title,gridProperties.frozenRowCount",
          },
        }],
      },
    });
  } else {
    // Legacy path — only works on Google Workspace projects. Personal-Gmail
    // operators will get a 403 here; the error handler in admin.ts surfaces
    // a hint pointing them at SHEETS_PARENT_FOLDER_ID.
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{
          properties: {
            title: "Submissions",
            gridProperties: { frozenRowCount: 1 },
          },
        }],
      },
    });
    if (!created.data.spreadsheetId) throw new Error("Sheet creation returned no spreadsheetId");
    id = created.data.spreadsheetId;
    tabId = created.data.sheets?.[0]?.properties?.sheetId ?? 0;
  }

  // 2. Write the headers into row 1.
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: "Submissions!A1",
    valueInputOption: "RAW",
    requestBody: { values: [SHEET_HEADERS] },
  });

  // 3. Polish the sheet — header styling, column widths, conditional
  // formatting on the Status column, filter view, alternating row colors.
  // ALL non-fatal: the sheet still works perfectly if Google rejects any
  // single request; we just lose visual polish.
  //
  // Column index reference (must match SHEET_HEADERS order):
  //   0 Timestamp | 1 Event | 2 Submission ID | 3 Discord User | 4 Reddit User
  //   5 Task Title | 6 Task Type | 7 Task Link | 8 Submitted Link
  //   9 Reward | 10 Status | 11 Live Status | 12 Campaign
  //   13 Submitted At | 14 Reviewed At | 15 Paid At
  const numCols = SHEET_HEADERS.length;
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        requests: [
          // Header: light grey bg (#D9D9D9-ish), bold black text, centred.
          // Matches the operator's reference sheet which uses a clean
          // grey header strip with emoji icons inline in the label.
          {
            repeatCell: {
              range: { sheetId: tabId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.85, green: 0.85, blue: 0.86 },
                  textFormat: {
                    foregroundColor: { red: 0.10, green: 0.10, blue: 0.12 },
                    bold: true,
                    fontSize: 11,
                  },
                  horizontalAlignment: "CENTER",
                  verticalAlignment: "MIDDLE",
                  wrapStrategy: "WRAP",
                  padding: { top: 6, bottom: 6, left: 6, right: 6 },
                  borders: {
                    bottom: { style: "SOLID_MEDIUM", color: { red: 0.55, green: 0.55, blue: 0.58 } },
                  },
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy,padding,borders)",
            },
          },
          // Header row height — generous so the emoji + label wraps nicely.
          {
            updateDimensionProperties: {
              range: { sheetId: tabId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
              properties: { pixelSize: 42 },
              fields: "pixelSize",
            },
          },
          // Column widths — eyeball'd for the kind of content each holds.
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 0,  endIndex: 1  }, properties: { pixelSize: 170 }, fields: "pixelSize" } }, // Timestamp
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 1,  endIndex: 2  }, properties: { pixelSize: 100 }, fields: "pixelSize" } }, // Event
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 2,  endIndex: 3  }, properties: { pixelSize: 110 }, fields: "pixelSize" } }, // Submission ID
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 3,  endIndex: 5  }, properties: { pixelSize: 140 }, fields: "pixelSize" } }, // Discord/Reddit user
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 5,  endIndex: 6  }, properties: { pixelSize: 220 }, fields: "pixelSize" } }, // Task Title
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 6,  endIndex: 7  }, properties: { pixelSize: 90  }, fields: "pixelSize" } }, // Task Type
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 7,  endIndex: 9  }, properties: { pixelSize: 280 }, fields: "pixelSize" } }, // links
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 9,  endIndex: 10 }, properties: { pixelSize: 80  }, fields: "pixelSize" } }, // Reward
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 10, endIndex: 12 }, properties: { pixelSize: 110 }, fields: "pixelSize" } }, // Status / Live
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 12, endIndex: 13 }, properties: { pixelSize: 180 }, fields: "pixelSize" } }, // Campaign
          { updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: 13, endIndex: 16 }, properties: { pixelSize: 160 }, fields: "pixelSize" } }, // *_at timestamps

          // Freeze first column too (Timestamp), in addition to header row,
          // so horizontal scrolling still shows WHEN the row happened.
          {
            updateSheetProperties: {
              properties: { sheetId: tabId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } },
              fields: "gridProperties(frozenRowCount,frozenColumnCount)",
            },
          },

          // Body cells: EXPLICIT near-black text + white default bg + wrap
          // + middle-align. We were relying on the spreadsheet's default
          // text color before, which on some themes / re-created sheets
          // inherited light/white text from the header style and made
          // rows unreadable. Forcing the color here is bulletproof.
          {
            repeatCell: {
              range: { sheetId: tabId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 1, green: 1, blue: 1 },
                  textFormat: {
                    foregroundColor: { red: 0.13, green: 0.13, blue: 0.15 },
                    fontSize: 10,
                    bold: false,
                  },
                  wrapStrategy: "WRAP",
                  verticalAlignment: "MIDDLE",
                  horizontalAlignment: "LEFT",
                  padding: { top: 6, bottom: 6, left: 8, right: 8 },
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat,wrapStrategy,verticalAlignment,horizontalAlignment,padding)",
            },
          },

          // Alternating row banding for readability. footerColor omitted
          // so the look stays clean. Text color is set above explicitly so
          // it stays readable on either band color.
          {
            addBanding: {
              bandedRange: {
                range: { sheetId: tabId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: numCols },
                rowProperties: {
                  headerColor: { red: 0.85, green: 0.85, blue: 0.86 },
                  firstBandColor: { red: 1, green: 1, blue: 1 },
                  secondBandColor: { red: 0.965, green: 0.965, blue: 0.97 },
                },
              },
            },
          },

          // Center-align short columns (Event, Status, Live Status, Reward,
          // Task Type) so the colored "pills" look like pills, not text.
          {
            repeatCell: {
              range: { sheetId: tabId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
              cell: { userEnteredFormat: { horizontalAlignment: "CENTER", textFormat: { bold: true, fontSize: 10 } } },
              fields: "userEnteredFormat(horizontalAlignment,textFormat)",
            },
          },
          {
            repeatCell: {
              range: { sheetId: tabId, startRowIndex: 1, startColumnIndex: 6, endColumnIndex: 7 },
              cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } },
              fields: "userEnteredFormat(horizontalAlignment)",
            },
          },
          {
            repeatCell: {
              range: { sheetId: tabId, startRowIndex: 1, startColumnIndex: 9, endColumnIndex: 12 },
              cell: { userEnteredFormat: { horizontalAlignment: "CENTER", textFormat: { bold: true, fontSize: 10 } } },
              fields: "userEnteredFormat(horizontalAlignment,textFormat)",
            },
          },

          // Reward column (index 9) — number format with $ sign + 2 decimals
          {
            repeatCell: {
              range: { sheetId: tabId, startRowIndex: 1, startColumnIndex: 9, endColumnIndex: 10 },
              cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0.00" } } },
              fields: "userEnteredFormat.numberFormat",
            },
          },

          // ──────────────────────────────────────────────────────────────
          // STATUS column (index 10) — pill-style conditional formatting.
          // Vibrant background + dark contrasting text + bold.
          // ──────────────────────────────────────────────────────────────
          // accepted → green
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "accepted" }] },
                format: { backgroundColor: { red: 0.78, green: 0.93, blue: 0.78 }, textFormat: { foregroundColor: { red: 0.06, green: 0.36, blue: 0.13 }, bold: true } },
              },
          }, index: 0 } },
          // approved → green (same as accepted)
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "approved" }] },
                format: { backgroundColor: { red: 0.78, green: 0.93, blue: 0.78 }, textFormat: { foregroundColor: { red: 0.06, green: 0.36, blue: 0.13 }, bold: true } },
              },
          }, index: 1 } },
          // paid → blue (status can also be 'paid')
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "paid" }] },
                format: { backgroundColor: { red: 0.75, green: 0.87, blue: 0.99 }, textFormat: { foregroundColor: { red: 0.05, green: 0.25, blue: 0.55 }, bold: true } },
              },
          }, index: 2 } },
          // rejected → red
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "rejected" }] },
                format: { backgroundColor: { red: 0.98, green: 0.78, blue: 0.78 }, textFormat: { foregroundColor: { red: 0.62, green: 0.07, blue: 0.07 }, bold: true } },
              },
          }, index: 3 } },
          // flagged → amber
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "flagged" }] },
                format: { backgroundColor: { red: 1.0, green: 0.88, blue: 0.65 }, textFormat: { foregroundColor: { red: 0.55, green: 0.34, blue: 0.02 }, bold: true } },
              },
          }, index: 4 } },
          // pending / submitted → light grey
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "pending" }] },
                format: { backgroundColor: { red: 0.88, green: 0.88, blue: 0.90 }, textFormat: { foregroundColor: { red: 0.25, green: 0.25, blue: 0.30 }, bold: true } },
              },
          }, index: 5 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "submitted" }] },
                format: { backgroundColor: { red: 0.88, green: 0.88, blue: 0.90 }, textFormat: { foregroundColor: { red: 0.25, green: 0.25, blue: 0.30 }, bold: true } },
              },
          }, index: 6 } },

          // ──────────────────────────────────────────────────────────────
          // EVENT column (index 1) — color every event type.
          //   submitted=grey  accepted=green  rejected=red
          //   flagged=amber   paid=blue
          // ──────────────────────────────────────────────────────────────
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }],
              booleanRule: {
                condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "paid" }] },
                format: { backgroundColor: { red: 0.75, green: 0.87, blue: 0.99 }, textFormat: { foregroundColor: { red: 0.05, green: 0.25, blue: 0.55 }, bold: true } },
              },
          }, index: 7 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }],
              booleanRule: {
                condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "accepted" }] },
                format: { backgroundColor: { red: 0.78, green: 0.93, blue: 0.78 }, textFormat: { foregroundColor: { red: 0.06, green: 0.36, blue: 0.13 }, bold: true } },
              },
          }, index: 8 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }],
              booleanRule: {
                condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "rejected" }] },
                format: { backgroundColor: { red: 0.98, green: 0.78, blue: 0.78 }, textFormat: { foregroundColor: { red: 0.62, green: 0.07, blue: 0.07 }, bold: true } },
              },
          }, index: 9 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }],
              booleanRule: {
                condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "flagged" }] },
                format: { backgroundColor: { red: 1.0, green: 0.88, blue: 0.65 }, textFormat: { foregroundColor: { red: 0.55, green: 0.34, blue: 0.02 }, bold: true } },
              },
          }, index: 10 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 }],
              booleanRule: {
                condition: { type: "TEXT_EQ", values: [{ userEnteredValue: "submitted" }] },
                format: { backgroundColor: { red: 0.88, green: 0.88, blue: 0.90 }, textFormat: { foregroundColor: { red: 0.25, green: 0.25, blue: 0.30 }, bold: true } },
              },
          }, index: 11 } },

          // LIVE STATUS column (index 11) — green if "live", red if "removed"
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 11, endColumnIndex: 12 }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "live" }] },
                format: { backgroundColor: { red: 0.84, green: 0.95, blue: 0.84 }, textFormat: { foregroundColor: { red: 0.08, green: 0.40, blue: 0.16 }, bold: true } },
              },
          }, index: 12 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 11, endColumnIndex: 12 }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "removed" }] },
                format: { backgroundColor: { red: 0.98, green: 0.80, blue: 0.80 }, textFormat: { foregroundColor: { red: 0.62, green: 0.07, blue: 0.07 }, bold: true } },
              },
          }, index: 13 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 11, endColumnIndex: 12 }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "deleted" }] },
                format: { backgroundColor: { red: 0.98, green: 0.80, blue: 0.80 }, textFormat: { foregroundColor: { red: 0.62, green: 0.07, blue: 0.07 }, bold: true } },
              },
          }, index: 14 } },

          // Auto-filter on the full data range so the operator can sort /
          // filter from the dropdown arrows in row 1.
          {
            setBasicFilter: {
              filter: {
                range: { sheetId: tabId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: numCols },
              },
            },
          },
        ],
      },
    });
  } catch (err) {
    logger.warn({ err, id }, "createCampaignSheet: polish/formatting failed (sheet still usable)");
  }

  // 4. SHARE — sharing model is chosen by the operator via env vars:
  //    PREFERRED (private): set SHEETS_OWNER_EMAIL to your own Gmail. The
  //      sheet is shared ONLY with that address as a writer; nobody else can
  //      open the link. You can then re-share from Google Sheets manually
  //      with whoever you want.
  //    FALLBACK (public-link): if SHEETS_OWNER_EMAIL is NOT set AND
  //      SHEETS_PUBLIC_BY_DEFAULT="true", anyone with the link can view
  //      (only enable this if you're okay with link-only exposure).
  //    DEFAULT (no sharing): no one but the service account can open the
  //      sheet. The bot CAN still write to it, but the link won't open for
  //      you until you manually share it. This is the safest default but
  //      requires one extra step from you.
  //    Non-fatal if any of these fail — the sheet itself is valid; only the
  //    "operator can click to open" part is affected.
  // Sharing policy (fixes the "Request access" trap when admins click the
  // sheet link from a browser logged into a different Google account than
  // the one used for OAuth):
  //   1. ALWAYS make the sheet viewable by anyone with the link (role:reader,
  //      type:anyone). This guarantees the link opens for every admin no
  //      matter which Google account their browser is signed into.
  //   2. If SHEETS_OWNER_EMAIL is set, also grant that specific user writer
  //      access so they can edit (needed for service-account creation path
  //      where the SA owns the file).
  //   3. Setting SHEETS_PUBLIC_BY_DEFAULT="false" explicitly disables step 1
  //      for operators who don't want public-link exposure.
  //   4. SHEETS_PUBLIC_ROLE="writer" upgrades anyone-with-link to editor
  //      (default reader = view-only, safer).
  //   Non-fatal on failure: the sheet itself is valid; the bot keeps writing
  //   to it, only the human "click to open" UX is affected.
  const ownerEmail = process.env.SHEETS_OWNER_EMAIL?.trim();
  const publicEnabled = (process.env.SHEETS_PUBLIC_BY_DEFAULT ?? "true").toLowerCase() !== "false";
  const publicRole = (process.env.SHEETS_PUBLIC_ROLE ?? "reader").toLowerCase() === "writer" ? "writer" : "reader";
  // IMPORTANT: each grant runs in its OWN try/catch so that if one fails
  // (e.g. Workspace domain admins forbid type:anyone link sharing) the
  // OTHER grant still applies. Owner grant runs FIRST so admin access is
  // preserved even on locked-down domains.
  if (ownerEmail) {
    try {
      await drive.permissions.create({
        fileId: id,
        sendNotificationEmail: false,
        requestBody: { role: "writer", type: "user", emailAddress: ownerEmail },
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message, id, authKind: resolved.kind },
        "createCampaignSheet: owner-email writer grant failed (sheet still valid; SHEETS_OWNER_EMAIL won't be able to edit unless shared manually)"
      );
    }
  }
  if (publicEnabled) {
    try {
      await drive.permissions.create({
        fileId: id,
        requestBody: { role: publicRole, type: "anyone" },
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message, id, authKind: resolved.kind, publicRole },
        "createCampaignSheet: anyone-with-link grant failed (likely a Workspace domain that forbids external sharing; sheet still valid but link openers may see 'Request access')"
      );
    }
  }

  return {
    spreadsheetId: id,
    url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  };
}

/**
 * Creates a generic sheet for Bulk Checks with conditional coloring based on standard status text.
 */
export async function createBulkCheckSheet(title: string, headers: string[], rows: (string|number|boolean|null)[][]): Promise<{ url: string }> {
  const resolved = await resolveAuth();
  if (!resolved) throw new Error(lastParseError ?? "Google Sheets not configured");

  const usingOAuth = resolved.kind === "oauth";
  const sheets = google.sheets({ version: "v4", auth: resolved.client as any });
  const drive = google.drive({ version: "v3", auth: resolved.client as any });

  const parentFolderId = usingOAuth ? null : (process.env.SHEETS_PARENT_FOLDER_ID?.trim() || null);
  let id: string;
  let tabId: number = 0;

  if (parentFolderId) {
    const file = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [parentFolderId],
      },
      fields: "id",
      supportsAllDrives: true,
    });
    if (!file.data.id) throw new Error("Drive file creation returned no id");
    id = file.data.id;

    const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
    const firstSheet = meta.data.sheets?.[0]?.properties;
    tabId = firstSheet?.sheetId ?? 0;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        requests: [{
          updateSheetProperties: {
            properties: {
              sheetId: tabId,
              title: "Export",
              gridProperties: { frozenRowCount: 1 },
            },
            fields: "title,gridProperties.frozenRowCount",
          },
        }],
      },
    });
  } else {
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{
          properties: {
            title: "Export",
            gridProperties: { frozenRowCount: 1 },
          },
        }],
      },
    });
    if (!created.data.spreadsheetId) throw new Error("Sheet creation returned no spreadsheetId");
    id = created.data.spreadsheetId;
    tabId = created.data.sheets?.[0]?.properties?.sheetId ?? 0;
  }

  // Write headers + data
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: "Export!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [headers, ...rows] },
  });

  const numCols = headers.length;
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        requests: [
          // Bold header row
          {
            repeatCell: {
              range: { sheetId: tabId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.85, green: 0.85, blue: 0.86 },
                  textFormat: { bold: true, fontSize: 11 },
                  verticalAlignment: "MIDDLE",
                  horizontalAlignment: "CENTER",
                  wrapStrategy: "WRAP",
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,horizontalAlignment,wrapStrategy)",
            },
          },
          // Auto-resize all columns
          {
            autoResizeDimensions: {
              dimensions: { sheetId: tabId, dimension: "COLUMNS", startIndex: 0, endIndex: numCols }
            }
          },
          // Conditional Formatting for Status
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "Live" }] },
                format: { backgroundColor: { red: 0.84, green: 0.95, blue: 0.84 } }
              }
          }, index: 0 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "Active" }] },
                format: { backgroundColor: { red: 0.84, green: 0.95, blue: 0.84 } }
              }
          }, index: 1 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "Removed" }] },
                format: { backgroundColor: { red: 0.98, green: 0.80, blue: 0.80 } }
              }
          }, index: 2 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "Deleted" }] },
                format: { backgroundColor: { red: 0.98, green: 0.80, blue: 0.80 } }
              }
          }, index: 3 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "Not Found" }] },
                format: { backgroundColor: { red: 1.0, green: 0.88, blue: 0.65 } }
              }
          }, index: 4 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "Suspended" }] },
                format: { backgroundColor: { red: 1.0, green: 0.88, blue: 0.65 } }
              }
          }, index: 5 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "Shadowbanned" }] },
                format: { backgroundColor: { red: 1.0, green: 0.88, blue: 0.65 } }
              }
          }, index: 6 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "Medium" }] },
                format: { backgroundColor: { red: 1.0, green: 0.88, blue: 0.65 } }
              }
          }, index: 7 } },
          { addConditionalFormatRule: { rule: {
              ranges: [{ sheetId: tabId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols }],
              booleanRule: {
                condition: { type: "TEXT_CONTAINS", values: [{ userEnteredValue: "High" }] },
                format: { backgroundColor: { red: 0.98, green: 0.80, blue: 0.80 } }
              }
          }, index: 8 } }
        ]
      }
    });
  } catch (err) {
    logger.warn({ err }, "createBulkCheckSheet: formatting failed");
  }

  const ownerEmail = process.env.SHEETS_OWNER_EMAIL?.trim();
  const publicEnabled = (process.env.SHEETS_PUBLIC_BY_DEFAULT ?? "true").toLowerCase() !== "false";
  const publicRole = (process.env.SHEETS_PUBLIC_ROLE ?? "reader").toLowerCase() === "writer" ? "writer" : "reader";

  if (ownerEmail) {
    try {
      await drive.permissions.create({
        fileId: id,
        sendNotificationEmail: false,
        requestBody: { role: "writer", type: "user", emailAddress: ownerEmail },
      });
    } catch (err) {}
  }
  if (publicEnabled) {
    try {
      await drive.permissions.create({
        fileId: id,
        requestBody: { role: publicRole, type: "anyone" },
      });
    } catch (err) {}
  }

  return { url: `https://docs.google.com/spreadsheets/d/${id}/edit` };
}

/**
 * Append a single row to a sheet's "Submissions" tab. Returns true on
 * HTTP-OK, false on any failure. Never throws.
 *
 * Used by:
 *   - logSubmissionEvent() (fire-and-forget hot path)
 *   - submissionRetention (with awaited result, to confirm archive landed
 *     before deleting the row)
 */
export async function appendSubmissionRow(spreadsheetId: string, row: unknown[]): Promise<boolean> {
  const resolved = await resolveAuth();
  if (!resolved) return false;

  async function tryWith(auth: any): Promise<{ ok: boolean; status?: number; msg?: string }> {
    try {
      const sheets = google.sheets({ version: "v4", auth });
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Submissions!A1",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [row] },
      });
      return { ok: true };
    } catch (err) {
      const anyErr = err as any;
      return {
        ok: false,
        status: anyErr?.response?.status ?? anyErr?.code,
        msg: anyErr?.response?.data?.error?.message ?? anyErr?.message ?? "unknown",
      };
    }
  }

  const first = await tryWith(resolved.client);
  if (first.ok) return true;

  // Backward-compat fallback: a sheet may have been created under the
  // service-account path *before* the operator connected OAuth. Such sheets
  // aren't shared with the OAuth user, so OAuth gets 403/404. Retry with
  // the SA so legacy sheets keep working without manual re-sharing.
  const isPermErr = first.status === 403 || first.status === 404;
  if (isPermErr && resolved.kind === "oauth") {
    const sa = loadAuth();
    if (sa) {
      const second = await tryWith(sa);
      if (second.ok) {
        logger.info(
          { spreadsheetId: spreadsheetId.slice(0, 12) },
          "appendSubmissionRow: fell back to service account (likely a legacy SA-created sheet)"
        );
        return true;
      }
      logger.warn(
        { firstErr: first.msg, fallbackErr: second.msg, spreadsheetId: spreadsheetId.slice(0, 12) },
        "appendSubmissionRow failed under BOTH OAuth and service account"
      );
      return false;
    }
  }

  logger.warn(
    { err: first.msg, status: first.status, spreadsheetId: spreadsheetId.slice(0, 12) },
    "appendSubmissionRow failed"
  );
  return false;
}

/**
 * Write a single row at a SPECIFIC row number in the Submissions tab.
 * Used when the operator wants "task #N → row N+1" positional layout
 * (header is row 1, task position 1 → row 2, etc.).
 *
 * Sheets API auto-extends the sheet if rowNum is beyond current size.
 * Honours the same OAuth-first / SA-fallback dispatch as appendSubmissionRow.
 * Returns true on success, false on any failure. Never throws.
 */
export async function writeSubmissionRowAt(
  spreadsheetId: string,
  rowNum: number,
  row: unknown[]
): Promise<boolean> {
  const resolved = await resolveAuth();
  if (!resolved) return false;
  if (rowNum < 2) {
    logger.warn({ rowNum }, "writeSubmissionRowAt: refusing to overwrite header row");
    return false;
  }

  async function tryWith(auth: any): Promise<{ ok: boolean; status?: number; msg?: string }> {
    try {
      const sheets = google.sheets({ version: "v4", auth });
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Submissions!A${rowNum}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });
      return { ok: true };
    } catch (err) {
      const anyErr = err as any;
      return {
        ok: false,
        status: anyErr?.response?.status ?? anyErr?.code,
        msg: anyErr?.response?.data?.error?.message ?? anyErr?.message ?? "unknown",
      };
    }
  }

  const first = await tryWith(resolved.client);
  if (first.ok) return true;

  const isPermErr = first.status === 403 || first.status === 404;
  if (isPermErr && resolved.kind === "oauth") {
    const sa = loadAuth();
    if (sa) {
      const second = await tryWith(sa);
      if (second.ok) {
        logger.info(
          { spreadsheetId: spreadsheetId.slice(0, 12), rowNum },
          "writeSubmissionRowAt: fell back to service account"
        );
        return true;
      }
      logger.warn(
        { firstErr: first.msg, fallbackErr: second.msg, spreadsheetId: spreadsheetId.slice(0, 12), rowNum },
        "writeSubmissionRowAt failed under BOTH OAuth and service account"
      );
      return false;
    }
  }

  logger.warn(
    { err: first.msg, status: first.status, spreadsheetId: spreadsheetId.slice(0, 12), rowNum },
    "writeSubmissionRowAt failed"
  );
  return false;
}

/**
 * Write many rows at SPECIFIC positions in one Sheets API batchUpdate call.
 * Used by backfill so each task's submission lands at its own row.
 * Optionally clears the Submissions data area (rows 2+) before writing so
 * stale append-mode rows don't leak through.
 *
 * Input shape: array of { rowNum, row }. Empty → trivially ok.
 */
export async function writeSubmissionRowsBatch(
  spreadsheetId: string,
  entries: { rowNum: number; row: unknown[] }[],
  opts: { clearBeforeWrite?: boolean } = {}
): Promise<{ ok: boolean; written: number; error?: string }> {
  // Guard: never let a caller stomp the header row.
  const safeEntries = entries.filter((e) => {
    if (e.rowNum < 2) {
      logger.warn({ rowNum: e.rowNum }, "writeSubmissionRowsBatch: dropping entry that would overwrite header");
      return false;
    }
    return true;
  });
  if (safeEntries.length === 0 && !opts.clearBeforeWrite) return { ok: true, written: 0 };
  const resolved = await resolveAuth();
  if (!resolved) return { ok: false, written: 0, error: "Google not configured" };

  // Compute the max written row so we can clear ONLY stale trailing rows AFTER
  // a successful write — never before. This avoids leaving the sheet wiped if
  // the batch write fails. Worst-case partial failure: sheet still has every
  // row that was successfully written; only stale tail rows linger.
  const maxRow = safeEntries.reduce((m, e) => Math.max(m, e.rowNum), 1);

  async function tryWith(auth: any): Promise<{ ok: boolean; status?: number; msg?: string }> {
    try {
      const sheets = google.sheets({ version: "v4", auth });
      if (safeEntries.length > 0) {
        const data = safeEntries.map((e) => ({
          range: `Submissions!A${e.rowNum}`,
          values: [e.row],
        }));
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: { valueInputOption: "USER_ENTERED", data },
        });
      }
      if (opts.clearBeforeWrite) {
        // Post-write tail cleanup: only wipe rows BEYOND the last positional
        // write so we don't trash any data the write produced. Failure here
        // is non-fatal — the positional rows are already in place.
        try {
          const clearFrom = Math.max(maxRow + 1, 2);
          await sheets.spreadsheets.values.clear({
            spreadsheetId,
            range: `Submissions!A${clearFrom}:Z`,
          });
        } catch (clearErr) {
          logger.warn(
            { err: (clearErr as any)?.message ?? String(clearErr), spreadsheetId: spreadsheetId.slice(0, 12) },
            "writeSubmissionRowsBatch: tail clear failed (non-fatal)"
          );
        }
      }
      return { ok: true };
    } catch (err) {
      const anyErr = err as any;
      return {
        ok: false,
        status: anyErr?.response?.status ?? anyErr?.code,
        msg: anyErr?.response?.data?.error?.message ?? anyErr?.message ?? "unknown",
      };
    }
  }

  const first = await tryWith(resolved.client);
  if (first.ok) return { ok: true, written: entries.length };

  const isPermErr = first.status === 403 || first.status === 404;
  if (isPermErr && resolved.kind === "oauth") {
    const sa = loadAuth();
    if (sa) {
      const second = await tryWith(sa);
      if (second.ok) return { ok: true, written: entries.length };
      return { ok: false, written: 0, error: `OAuth: ${first.msg}; SA fallback: ${second.msg}` };
    }
  }
  return { ok: false, written: 0, error: first.msg };
}

/**
 * Bulk-append many rows in a single Sheets API call. Used by the backfill
 * route to dump every existing submission of a campaign into a freshly
 * created sheet without spamming Google with N append requests (which would
 * hit rate limits for big campaigns).
 *
 * Honours the same OAuth-first / SA-fallback dispatch as the single-row path.
 * Returns true iff the append succeeded. Empty input → trivially true.
 */
export async function appendSubmissionRowsBulk(
  spreadsheetId: string,
  rows: unknown[][]
): Promise<{ ok: boolean; written: number; error?: string }> {
  if (rows.length === 0) return { ok: true, written: 0 };
  const resolved = await resolveAuth();
  if (!resolved) return { ok: false, written: 0, error: "Google not configured" };

  async function tryWith(auth: any): Promise<{ ok: boolean; status?: number; msg?: string }> {
    try {
      const sheets = google.sheets({ version: "v4", auth });
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Submissions!A1",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: rows },
      });
      return { ok: true };
    } catch (err) {
      const anyErr = err as any;
      return {
        ok: false,
        status: anyErr?.response?.status ?? anyErr?.code,
        msg: anyErr?.response?.data?.error?.message ?? anyErr?.message ?? "unknown",
      };
    }
  }

  const first = await tryWith(resolved.client);
  if (first.ok) return { ok: true, written: rows.length };

  const isPermErr = first.status === 403 || first.status === 404;
  if (isPermErr && resolved.kind === "oauth") {
    const sa = loadAuth();
    if (sa) {
      const second = await tryWith(sa);
      if (second.ok) return { ok: true, written: rows.length };
      return { ok: false, written: 0, error: `OAuth: ${first.msg}; SA fallback: ${second.msg}` };
    }
  }
  return { ok: false, written: 0, error: first.msg };
}
