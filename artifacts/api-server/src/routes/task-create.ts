import { Router } from "express";
import { pool } from "@workspace/db";
import { getPrimaryGuild } from "../bot/discord-client.js";
import { normalizeTaskInput, createTaskAndPost, parseTaskCsv, createBulkTasksFromCsv } from "../bot/task-creation.js";
import { requireAuth as requireActiveAuth } from "./admin.js";
import { fetchAndFixSheet } from "../lib/sheetImporter.js";

const router: Router = Router();

const FALLBACK_DISCORD_ID = "0";

async function creatorDiscordIdFor(sessionUser: any): Promise<string> {
  // Prefer the linked Discord ID if the dashboard admin has connected their
  // Discord account via OAuth. Falls back to "dashboard:<username>" so older
  // unlinked admins still get attributable rows.
  if (sessionUser?.id) {
    try {
      const r = await pool.query<{ discord_id: string | null }>(
        `SELECT discord_id FROM admin_users WHERE id = $1`,
        [sessionUser.id]
      );
      const did = r.rows[0]?.discord_id;
      if (did) return did;
    } catch { /* fall through to placeholder */ }
  }
  return `dashboard:${sessionUser?.username ?? FALLBACK_DISCORD_ID}`;
}

router.post("/tasks/create", requireActiveAuth, async (req, res) => {
  const sessionUser = (req as any).session?.adminUser;
  const guild = getPrimaryGuild();
  if (!guild) {
    res.status(503).json({ error: "Discord bot is not ready yet. Try again in a few seconds." });
    return;
  }

  const body = req.body as Record<string, unknown>;

  // Optional uploaded media — dashboard sends raw bytes as base64 in the JSON body.
  // Two accepted shapes (both still supported for backward compat):
  //   1. NEW  — body.mediaItems: [{ base64, filename, contentType }, ...]   (up to 10 files, mix of images + videos)
  //   2. LEGACY — body.imageBase64 + body.imageFilename                     (single image, kept so older clients keep working)
  // Each file is hard-capped at 25MB (Discord's bot attachment limit on
  // non-boosted guilds). We decode here and pass the buffers to
  // createTaskAndPost, which uploads them as Discord attachments. The first
  // image among them becomes tasks.image_url (so the embed thumbnail keeps
  // working exactly like before for the single-image case).
  const PER_FILE_BYTES = 25 * 1024 * 1024;          // Discord bot default
  const MAX_FILES = 10;                              // Discord per-message attachment cap
  const TOTAL_DECODED_BYTES = 90 * 1024 * 1024;      // safety ceiling per request
  const mediaItems: { buffer: Buffer; filename: string; contentType: string | null }[] = [];

  /** Conservative pre-decode size estimate from base64 string length.
   *  Decoded length = ceil(b64Len / 4) * 3 minus padding. We use the upper
   *  bound (no padding subtract) so we never decode a payload that would
   *  exceed the per-file cap — rejects oversized blobs *before* allocating
   *  a Buffer for them. */
  const estimateDecodedBytes = (b64: string): number => Math.ceil(b64.length / 4) * 3;

  let runningTotal = 0;
  const pushDecoded = (b64: string, filename: string, contentType: string | null, label: string): { error: string } | null => {
    const est = estimateDecodedBytes(b64);
    if (est > PER_FILE_BYTES) return { error: `${label} is too large (max 25 MB per file).` };
    if (runningTotal + est > TOTAL_DECODED_BYTES) return { error: `Total upload size exceeds the 90 MB per-request limit. Try fewer or smaller files.` };
    let buffer: Buffer;
    try { buffer = Buffer.from(b64, "base64"); }
    catch { return { error: `${label} is not valid base64.` }; }
    if (buffer.length === 0) return { error: `${label} is empty.` };
    // Exact post-decode cap (catches the estimator's small overshoot edge).
    if (buffer.length > PER_FILE_BYTES) return { error: `${label} is too large (max 25 MB per file).` };
    runningTotal += buffer.length;
    mediaItems.push({ buffer, filename, contentType });
    return null;
  };

  const rawList = Array.isArray((body as any).mediaItems) ? (body as any).mediaItems as unknown[] : null;
  if (rawList && rawList.length > 0) {
    if (rawList.length > MAX_FILES) {
      res.status(400).json({ error: `Too many files (max ${MAX_FILES}).` });
      return;
    }
    for (let i = 0; i < rawList.length; i++) {
      const item = rawList[i] as Record<string, unknown> | null;
      if (!item || typeof item !== "object") {
        res.status(400).json({ error: `Invalid file at position ${i + 1}.` });
        return;
      }
      const b64 = typeof item.base64 === "string" ? item.base64 : null;
      const fn = typeof item.filename === "string" ? item.filename : null;
      const ct = typeof item.contentType === "string" ? item.contentType : null;
      if (!b64) {
        res.status(400).json({ error: `File ${i + 1} is missing data.` });
        return;
      }
      const err = pushDecoded(b64, fn || `file-${i + 1}`, ct, `File ${i + 1}`);
      if (err) { res.status(400).json(err); return; }
    }
  } else {
    // Legacy single-image path — preserved for backward compat. Stamp the
    // contentType as image/* so the downstream "promote first image to embed"
    // detector treats it as an image even if the filename has no extension
    // (it was always an image before — preserve that invariant exactly).
    const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : null;
    const imageFilename = typeof body.imageFilename === "string" ? body.imageFilename : null;
    if (imageBase64) {
      const err = pushDecoded(imageBase64, imageFilename || "image.png", "image/*", "Image");
      if (err) { res.status(400).json(err); return; }
    }
  }

  const norm = normalizeTaskInput({
    type: String(body.type ?? ""),
    title: typeof body.title === "string" ? body.title : "",
    link: String(body.link ?? ""),
    instructions: String(body.instructions ?? ""),
    prewrittenComment: typeof body.prewrittenComment === "string" ? body.prewrittenComment : null,
    postBody: typeof body.postBody === "string" ? body.postBody : null,
    flair: typeof body.flair === "string" ? body.flair : null,
    reward: Number(body.reward),
    slots: Number(body.slots),
    timeLimitMinutes: body.timeLimitMinutes != null ? Number(body.timeLimitMinutes) : undefined,
    holdHours: body.holdHours != null ? Number(body.holdHours) : undefined,
    minTrustScore: body.minTrustScore != null ? Number(body.minTrustScore) : undefined,
    imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : null,
    // Phase 2: dashboard form sends `cooldownEnabled`. Default true so any
    // older client that omits it keeps the cooldown gate ON (safe default).
    cooldownEnabled: body.cooldownEnabled !== false,
    creatorDiscordId: await creatorDiscordIdFor(sessionUser),
  });

  if (!norm.ok) {
    res.status(400).json({ error: norm.error });
    return;
  }

  try {
    const task = await createTaskAndPost(norm.task, guild, { mediaItems });
    req.log.info({ taskId: task.id, by: sessionUser?.username }, "Task created via dashboard");
    res.json({
      id: task.id,
      title: task.title,
      type: task.type,
      reward: task.reward,
      maxSlots: task.maxSlots,
      slotsFilled: task.slotsFilled,
      status: task.status,
      createdAt: task.createdAt,
    });
  } catch (err) {
    req.log.error({ err }, "Create task via dashboard failed");
    res.status(500).json({ error: (err as any)?.message ?? "Failed to create task" });
  }
});

router.post("/tasks/bulk", requireActiveAuth, async (req, res) => {
  const sessionUser = (req as any).session?.adminUser;
  const guild = getPrimaryGuild();
  if (!guild) {
    res.status(503).json({ error: "Discord bot is not ready yet. Try again in a few seconds." });
    return;
  }

  const { csv, campaignTitle, intervalMinutes, intervalSeconds, allowMultipleClaims, maxClaimsPerUser, cooldownEnabled, mergeIntoSingleTask, holdHoursDefault, notifyUnclaimed } = req.body as {
    csv?: string; campaignTitle?: string; intervalMinutes?: number | string; intervalSeconds?: number | string; allowMultipleClaims?: boolean; maxClaimsPerUser?: number | string; cooldownEnabled?: boolean; mergeIntoSingleTask?: boolean; holdHoursDefault?: number | string; notifyUnclaimed?: boolean;
  };
  if (!csv || !csv.trim()) { res.status(400).json({ error: "CSV is required" }); return; }
  if (!campaignTitle || !campaignTitle.trim()) { res.status(400).json({ error: "Campaign name is required" }); return; }

  // Accept intervalSeconds (new) or intervalMinutes (legacy) — seconds takes priority.
  let interval: number;
  if (intervalSeconds !== undefined && intervalSeconds !== null) {
    interval = Number(intervalSeconds) / 60;
  } else {
    interval = Number(intervalMinutes ?? 0);
  }
  if (!Number.isFinite(interval) || interval < 0) interval = 0;
  if (interval > 1440) interval = 1440;
  // No Math.floor — allow fractional minutes for sub-minute drip intervals.

  // Pre-validate to give a clean error before campaign insert.
  try {
    parseTaskCsv(csv);
  } catch (err: any) {
    res.status(400).json({ error: `CSV parse error: ${err?.message ?? "invalid CSV"}` });
    return;
  }

  try {
    const result = await createBulkTasksFromCsv({
      csv,
      campaignTitle: campaignTitle.trim(),
      sourceType: "csv",
      sourceUrl: null,
      creatorDiscordId: await creatorDiscordIdFor(sessionUser),
      guild,
      intervalMinutes: interval,
      allowMultipleClaims: !!allowMultipleClaims,
      maxClaimsPerUser: normalizeMaxClaims(maxClaimsPerUser, !!allowMultipleClaims),
      cooldownEnabled: cooldownEnabled !== false,
      mergeIntoSingleTask: !!mergeIntoSingleTask,
      holdHoursDefault: holdHoursDefault != null && holdHoursDefault !== "" ? Number(holdHoursDefault) : undefined,
      notifyUnclaimed: notifyUnclaimed !== false,
    });
    req.log.info(
      { campaignId: result.campaignId, created: result.created, scheduled: result.scheduled, intervalMinutes: result.intervalMinutes, maxClaimsPerUser, by: sessionUser?.username },
      "Bulk tasks created via dashboard",
    );
    res.json(result);
  } catch (err: any) {
    req.log.error({ err }, "Bulk task create via dashboard failed");
    res.status(500).json({ error: err?.message ?? "Failed to create bulk tasks" });
  }
});

// ---------------------------------------------------------------------------
// Import bulk tasks straight from a Google Sheets URL (Phase 1 importer).
// Re-uses the same createBulkTasksFromCsv() pipeline as /tasks/bulk so all
// validation, campaign creation, drip scheduling, and Discord posting behave
// identically — we just fetch + auto-fix the CSV first instead of reading it
// from the request body.
// ---------------------------------------------------------------------------
router.post("/tasks/import-sheet", requireActiveAuth, async (req, res) => {
  const sessionUser = (req as any).session?.adminUser;
  const guild = getPrimaryGuild();
  if (!guild) {
    res.status(503).json({ error: "Discord bot is not ready yet. Try again in a few seconds." });
    return;
  }

  const { sheetUrl, campaignTitle, intervalMinutes, intervalSeconds, dryRun, allowMultipleClaims, maxClaimsPerUser, cooldownEnabled, mergeIntoSingleTask, holdHoursDefault, notifyUnclaimed } = req.body as {
    sheetUrl?: string;
    campaignTitle?: string;
    intervalMinutes?: number | string;
    intervalSeconds?: number | string;
    dryRun?: boolean;
    allowMultipleClaims?: boolean;
    maxClaimsPerUser?: number | string;
    cooldownEnabled?: boolean;
    mergeIntoSingleTask?: boolean;
    holdHoursDefault?: number | string;
    notifyUnclaimed?: boolean;
  };
  if (!sheetUrl || !sheetUrl.trim()) { res.status(400).json({ error: "Sheet URL is required" }); return; }
  if (!dryRun && (!campaignTitle || !campaignTitle.trim())) {
    res.status(400).json({ error: "Campaign name is required" });
    return;
  }

  let interval: number;
  if (intervalSeconds !== undefined && intervalSeconds !== null) {
    interval = Number(intervalSeconds) / 60;
  } else {
    interval = Number(intervalMinutes ?? 0);
  }
  if (!Number.isFinite(interval) || interval < 0) interval = 0;
  if (interval > 1440) interval = 1440;

  // 1. Fetch + auto-fix.
  const fetched = await fetchAndFixSheet(sheetUrl.trim());
  if (!fetched.ok || !fetched.csv) {
    res.status(400).json({ error: fetched.error ?? "Failed to fetch sheet" });
    return;
  }

  // 2. Pre-validate the cleaned CSV.
  let parseInfo: { rowCount: number } = { rowCount: 0 };
  try {
    const parsed = parseTaskCsv(fetched.csv);
    parseInfo.rowCount = parsed.length;
  } catch (err: any) {
    res.status(400).json({
      error: `CSV parse error after auto-fix: ${err?.message ?? "invalid CSV"}`,
      autoFixNotes: fetched.notes,
    });
    return;
  }

  // 3. Dry run? Just return the preview without creating anything.
  if (dryRun) {
    res.json({
      dryRun: true,
      rowsFound: parseInfo.rowCount,
      autoFixNotes: fetched.notes,
      cleanedCsvPreview: fetched.csv.split("\n").slice(0, 6).join("\n"),
    });
    return;
  }

  // 4. Real import — same code path as /tasks/bulk.
  try {
    const result = await createBulkTasksFromCsv({
      csv: fetched.csv,
      campaignTitle: campaignTitle!.trim(),
      sourceType: "sheets",
      sourceUrl: sheetUrl.trim(),
      creatorDiscordId: await creatorDiscordIdFor(sessionUser),
      guild,
      intervalMinutes: interval,
      allowMultipleClaims: !!allowMultipleClaims,
      maxClaimsPerUser: normalizeMaxClaims(maxClaimsPerUser, !!allowMultipleClaims),
      cooldownEnabled: cooldownEnabled !== false,
      mergeIntoSingleTask: !!mergeIntoSingleTask,
      holdHoursDefault: holdHoursDefault != null && holdHoursDefault !== "" ? Number(holdHoursDefault) : undefined,
      notifyUnclaimed: notifyUnclaimed !== false,
    });
    req.log.info(
      { campaignId: result.campaignId, created: result.created, scheduled: result.scheduled, intervalMinutes: result.intervalMinutes, maxClaimsPerUser, by: sessionUser?.username, source: "google_sheet" },
      "Bulk tasks imported from Google Sheet via dashboard",
    );
    res.json({ ...result, autoFixNotes: fetched.notes });
  } catch (err: any) {
    req.log.error({ err }, "Sheet import via dashboard failed");
    res.status(500).json({ error: err?.message ?? "Failed to import tasks" });
  }
});

/**
 * Coerce the maxClaimsPerUser body field into a safe integer.
 * - allowMultipleClaims=false → always 1 (per-user cap of one, default).
 * - allowMultipleClaims=true  → 2 by default, but accepts any 1..100, or 0 for unlimited.
 * Out-of-range or non-numeric values are clamped to safe defaults — never throws.
 */
function normalizeMaxClaims(raw: unknown, allowMultiple: boolean): number {
  if (!allowMultiple) return 1;
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""));
  if (!Number.isFinite(n) || n < 0) return 2;
  if (n > 100) return 100;
  return Math.floor(n);
}

export default router;
