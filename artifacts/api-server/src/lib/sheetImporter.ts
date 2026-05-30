// ===========================================================================
// Google Sheets → CSV importer with auto-fix.
// ---------------------------------------------------------------------------
// Pure helper. No DB. No side effects. No throwing on user error (returns
// {ok: false} instead). Used by /admin/tasks/import-sheet.
//
// What it does:
//   1. Extracts the sheet ID from any reasonable Google Sheets URL.
//   2. Fetches the published CSV (sheet must be "Anyone with link can view").
//   3. Auto-fixes common CSV mistakes:
//        - trims trailing spaces from header names
//        - if "title" column contains long text (>100 chars) AND there is no
//          "prewritten_comment" column, MOVES the title text into a new
//          prewritten_comment column and clears title.
//        - fills empty "instructions" cells with a sensible default.
//   4. Returns the cleaned CSV as a string for the existing
//      createBulkTasksFromCsv() pipeline to consume.
// ===========================================================================

const DEFAULT_INSTRUCTIONS =
  "Copy the comment below exactly and post it as a reply on the linked thread. Then submit the link to your reply as proof.";

export interface ImportResult {
  ok: boolean;
  csv?: string;
  error?: string;
  notes?: string[];
}

export function extractSheetId(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  // Common shapes:
  //   https://docs.google.com/spreadsheets/d/<ID>/edit?usp=sharing
  //   https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0
  //   https://docs.google.com/spreadsheets/d/<ID>
  //   <ID> alone
  const m = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

// Minimal robust CSV parser supporting quoted fields with embedded commas /
// newlines / escaped quotes ("").
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

// IMPORTANT: the downstream parseTaskCsv() in bot/task-creation.ts uses a naive
// line-split (raw.split(/\r?\n/)) that does NOT respect quoted multi-line
// fields. So if a cell contains line breaks (very common in long pre-written
// Reddit comments pasted into the sheet), it would shred the row apart.
// We sanitize here by collapsing all embedded newlines/CRs to a single space
// before writing the CSV. This produces a single-line-per-row CSV that the
// downstream parser handles correctly. Visual whitespace in the comment text
// is preserved well enough for posting (Reddit ignores extra spaces anyway,
// and paragraph breaks in comments aren't structural for our use case).
function sanitizeCellForSingleLine(v: string): { value: string; hadNewlines: boolean } {
  const hadNewlines = /\r|\n/.test(v);
  const value = v.replace(/\r\n|\r|\n/g, " ").replace(/[ \t]{2,}/g, " ");
  return { value, hadNewlines };
}

function csvField(s: string, counter?: { collapsed: number }): string {
  const { value, hadNewlines } = sanitizeCellForSingleLine(String(s ?? ""));
  if (hadNewlines && counter) counter.collapsed++;
  if (value.includes(",") || value.includes('"')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function autoFixCsv(rawCsv: string): { csv: string; notes: string[] } {
  const notes: string[] = [];
  const rows = parseCsv(rawCsv);
  if (rows.length === 0) return { csv: rawCsv, notes: ["empty CSV"] };

  // Step 1: trim trailing/leading spaces from header names.
  const rawHeaders = rows[0];
  const headers = rawHeaders.map(h => h.trim());
  const trimmedCount = rawHeaders.filter((h, i) => h !== headers[i]).length;
  if (trimmedCount > 0) notes.push(`Trimmed whitespace from ${trimmedCount} header name(s)`);

  // Build column index lookup (case-insensitive).
  const idx: Record<string, number> = {};
  headers.forEach((h, i) => { idx[h.toLowerCase()] = i; });

  const titleIdx = idx["title"];
  const instructionsIdx = idx["instructions"];
  const prewrittenIdx = idx["prewritten_comment"] ?? idx["comment"];

  // Step 2: detect "long titles" pattern → move to prewritten_comment.
  let addedPrewritten = false;
  let movedCount = 0;
  if (titleIdx != null && prewrittenIdx == null) {
    let longTitleRows = 0;
    for (let r = 1; r < rows.length; r++) {
      const t = (rows[r][titleIdx] ?? "").trim();
      if (t.length > 100) longTitleRows++;
    }
    if (longTitleRows > 0) {
      headers.push("prewritten_comment");
      addedPrewritten = true;
      const newPrewrittenIdx = headers.length - 1;
      for (let r = 1; r < rows.length; r++) {
        // Make sure each row has the same number of columns.
        while (rows[r].length < headers.length) rows[r].push("");
        const t = (rows[r][titleIdx] ?? "").trim();
        if (t.length > 100) {
          rows[r][newPrewrittenIdx] = t;
          rows[r][titleIdx] = "";
          movedCount++;
        }
      }
      notes.push(
        `Moved ${movedCount} long title cell(s) into a new "prewritten_comment" column ` +
        `(title was >100 chars, looked like comment text, not a title)`
      );
    }
  }

  // Step 3: fill empty instructions with default.
  let filledInstructions = 0;
  if (instructionsIdx != null) {
    for (let r = 1; r < rows.length; r++) {
      while (rows[r].length < headers.length) rows[r].push("");
      const v = (rows[r][instructionsIdx] ?? "").trim();
      if (!v) {
        rows[r][instructionsIdx] = DEFAULT_INSTRUCTIONS;
        filledInstructions++;
      }
    }
    if (filledInstructions > 0) {
      notes.push(`Filled ${filledInstructions} empty "instructions" cell(s) with a default`);
    }
  }

  // Step 4: rebuild CSV with cleaned headers and fixed rows.
  // Also tally any cells that had embedded newlines collapsed to spaces
  // (required because the downstream parser doesn't handle multi-line cells).
  const counter = { collapsed: 0 };
  const out: string[] = [];
  out.push(headers.map(h => csvField(h)).join(","));
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    while (row.length < headers.length) row.push("");
    out.push(row.slice(0, headers.length).map(c => csvField(c, counter)).join(","));
  }
  if (counter.collapsed > 0) {
    notes.push(
      `Flattened line breaks in ${counter.collapsed} cell(s) to spaces ` +
      `(needed for parser compatibility — Reddit comments still post fine)`
    );
  }
  if (!addedPrewritten && movedCount === 0 && filledInstructions === 0 && trimmedCount === 0 && counter.collapsed === 0) {
    notes.push("No fixes needed — CSV was already clean");
  }
  return { csv: out.join("\n"), notes };
}

export async function fetchAndFixSheet(sheetUrl: string): Promise<ImportResult> {
  const id = extractSheetId(sheetUrl);
  if (!id) {
    return { ok: false, error: "Couldn't recognize that as a Google Sheets URL. Paste the full URL like https://docs.google.com/spreadsheets/d/<ID>/edit." };
  }
  const csvUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(csvUrl, { redirect: "follow", signal: controller.signal });
  } catch (err: any) {
    clearTimeout(t);
    return { ok: false, error: `Couldn't reach Google Sheets: ${err?.message ?? String(err)}` };
  }
  clearTimeout(t);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return {
        ok: false,
        error: `Sheet isn't accessible (HTTP ${res.status}). In Google Sheets, click Share → set "General access" to "Anyone with the link" → Viewer.`,
      };
    }
    return { ok: false, error: `Google Sheets returned HTTP ${res.status}.` };
  }
  // Sanity check: make sure we got CSV, not an HTML "sign in" redirect page.
  const ctype = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ctype.includes("text/html") || text.startsWith("<!DOCTYPE")) {
    return {
      ok: false,
      error: 'Got a sign-in page instead of CSV. The sheet must be shared as "Anyone with the link can view".',
    };
  }
  if (!text.trim()) {
    return { ok: false, error: "Sheet appears to be empty." };
  }
  const fixed = autoFixCsv(text);
  return { ok: true, csv: fixed.csv, notes: fixed.notes };
}
