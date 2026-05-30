import { useState } from "react";
import { post } from "@/lib/api";
import { cn } from "@/lib/utils";

const SAMPLE_CSV = `type,title,task_link,instructions,prewritten_comment,post_body,reward,slots,image_url
comment,,https://reddit.com/r/AskReddit/comments/abc123/,"Reply to the OP with the exact text in prewritten_comment.","Honestly this is one of the best takes I've seen on this lately — saving for later.",,0.20,10,
post,My favorite weekend recipe,https://reddit.com/r/cooking,"Create a new post in r/cooking using the title + body below.",,"I tried this last Sunday and it came out amazing. Recipe in comments if anyone wants it!",0.50,5,
twitter_like,,https://x.com/example/status/123,"Just like the tweet at the link.",,,0.05,50,https://i.imgur.com/example.png
quora_upvote,,https://www.quora.com/Some-Question/answer/...,"Click upvote on the linked answer.",,,0.10,20,`;

interface BulkResult {
  campaignId: number;
  rowsFound: number;
  created: number;
  scheduled: number;
  intervalMinutes: number;
  errors: string[];
}

interface SheetResult extends BulkResult {
  autoFixNotes?: string[];
}
interface SheetPreview {
  dryRun: true;
  rowsFound: number;
  autoFixNotes: string[];
  cleanedCsvPreview: string;
}

function fmtInterval(minutes: number): string {
  const seconds = Math.round(minutes * 60);
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function BulkTasks() {
  const [csv, setCsv] = useState("");
  const [campaignTitle, setCampaignTitle] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(0);
  const [allowMultipleClaims, setAllowMultipleClaims] = useState(false);
  const [maxClaimsPerUser, setMaxClaimsPerUser] = useState(2);
  const [cooldownEnabled, setCooldownEnabled] = useState(true);
  const [mergeIntoSingleTask, setMergeIntoSingleTask] = useState(false);
  const [holdHoursDefault, setHoldHoursDefault] = useState<number | "">(168);
  const [notifyUnclaimed, setNotifyUnclaimed] = useState(true);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BulkResult | null>(null);
  const [loading, setLoading] = useState(false);

  // --- Google Sheets importer state ---------------------------
  const [sheetUrl, setSheetUrl] = useState("");
  const [sheetCampaign, setSheetCampaign] = useState("");
  const [sheetIntervalSeconds, setSheetIntervalSeconds] = useState(0);
  const [sheetAllowMulti, setSheetAllowMulti] = useState(false);
  const [sheetMaxClaimsPerUser, setSheetMaxClaimsPerUser] = useState(2);
  const [sheetCooldownEnabled, setSheetCooldownEnabled] = useState(true);
  const [sheetMerge, setSheetMerge] = useState(false);
  const [sheetHoldHoursDefault, setSheetHoldHoursDefault] = useState<number | "">(168);
  const [sheetNotifyUnclaimed, setSheetNotifyUnclaimed] = useState(true);
  const [sheetError, setSheetError] = useState("");
  const [sheetPreview, setSheetPreview] = useState<SheetPreview | null>(null);
  const [sheetResult, setSheetResult] = useState<SheetResult | null>(null);
  const [sheetLoading, setSheetLoading] = useState(false);

  const handleSheetPreview = async () => {
    setSheetError(""); setSheetPreview(null); setSheetResult(null); setSheetLoading(true);
    try {
      const r = await post<SheetPreview>("/admin/tasks/import-sheet", {
        sheetUrl, dryRun: true,
      });
      setSheetPreview(r);
    } catch (err: any) {
      setSheetError(err.message ?? "Preview failed");
    } finally { setSheetLoading(false); }
  };

  const handleSheetImport = async () => {
    setSheetError(""); setSheetResult(null); setSheetLoading(true);
    try {
      const r = await post<SheetResult>("/admin/tasks/import-sheet", {
        sheetUrl,
        campaignTitle: sheetCampaign,
        intervalSeconds: sheetIntervalSeconds,
        allowMultipleClaims: sheetAllowMulti,
        maxClaimsPerUser: sheetAllowMulti ? sheetMaxClaimsPerUser : 1,
        cooldownEnabled: sheetCooldownEnabled,
        mergeIntoSingleTask: sheetMerge,
        holdHoursDefault: sheetHoldHoursDefault === "" ? undefined : sheetHoldHoursDefault,
        notifyUnclaimed: sheetNotifyUnclaimed,
      });
      setSheetResult(r); setSheetPreview(null);
    } catch (err: any) {
      setSheetError(err.message ?? "Import failed");
    } finally { setSheetLoading(false); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setResult(null);
    setLoading(true);
    try {
      const r = await post<BulkResult>("/admin/tasks/bulk", {
        csv,
        campaignTitle,
        intervalSeconds,
        allowMultipleClaims,
        maxClaimsPerUser: allowMultipleClaims ? maxClaimsPerUser : 1,
        cooldownEnabled,
        mergeIntoSingleTask,
        holdHoursDefault: holdHoursDefault === "" ? undefined : holdHoursDefault,
        notifyUnclaimed,
      });
      setResult(r);
    } catch (err: any) {
      setError(err.message ?? "Failed to create bulk tasks");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Bulk Create Tasks</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste CSV with header row OR import directly from a Google Sheet. Each task posts to Discord and is grouped under one campaign.
        </p>
      </header>

      {/* ============ Google Sheets importer ============ */}
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-500 uppercase tracking-wide">New</span>
            Import from Google Sheets
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Paste a Google Sheets URL. We'll read it, auto-fix common mistakes, preview, and launch.
            <br />
            <strong>Sheet must be shared as "Anyone with the link can view".</strong>
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Google Sheets URL</label>
          <input
            type="url"
            value={sheetUrl}
            onChange={e => setSheetUrl(e.target.value)}
            className={fieldClass}
            placeholder="https://docs.google.com/spreadsheets/d/.../edit?usp=sharing"
          />
        </div>

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">📋 Sheet column reference (click to expand)</summary>
          <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-border">
            <p>Row 1 = headers. <strong className="text-foreground">Column order doesn't matter</strong> — the bot reads headers, not positions. Use these header names exactly:</p>
            <p className="font-medium text-foreground mt-2">Required:</p>
            <ul className="list-disc list-inside space-y-0.5 pl-2">
              <li><code>type</code> — <code>comment</code>, <code>post</code>, <code>upvote</code>, <code>twitter_like</code>, <code>twitter_retweet</code>, <code>twitter_comment</code>, <code>quora_upvote</code>, <code>quora_answer</code>, etc.</li>
              <li><code>task_link</code> — Reddit URL / subreddit / Twitter URL / Quora URL</li>
              <li><code>instructions</code> — <strong>what the worker reads</strong> (e.g. "Reply to the OP with the text below"). <strong>This is NOT the comment text.</strong></li>
              <li><code>reward</code> — dollars (e.g. <code>0.20</code>)</li>
              <li><code>slots</code> — how many workers can claim this task</li>
            </ul>
            <p className="font-medium text-foreground mt-2">Optional:</p>
            <ul className="list-disc list-inside space-y-0.5 pl-2">
              <li><code>title</code> — for <code>post</code> tasks this is the <strong>actual Reddit post title</strong> the worker pastes. For all other types it's just a Discord-side label (leave blank to auto-generate).</li>
              <li><code>prewritten_comment</code> (alias <code>comment</code>) — the <strong>exact text the worker pastes as their comment/reply</strong>. Shown with a "📋 Copy" button.</li>
              <li><code>post_body</code> (alias <code>body</code>) — for <code>post</code> tasks, the body content.</li>
              <li><code>image_url</code>, <code>flair</code>, <code>time_limit</code>, <code>hold_hours</code> (overrides campaign default below), <code>min_trust</code>, <code>max_claims_per_user</code>, <code>cooldown_enabled</code></li>
            </ul>
            <p className="mt-2 px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200">
              <strong>⚠️ Common mistake:</strong> putting the comment text in the <code>instructions</code> column.
              <code>instructions</code> = directions for the worker. <code>prewritten_comment</code> = the actual text they post.
            </p>
          </div>
        </details>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Campaign Name</label>
            <input
              type="text"
              value={sheetCampaign}
              onChange={e => setSheetCampaign(e.target.value)}
              className={fieldClass}
              placeholder="e.g. Friend's Reddit Comments"
              maxLength={100}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Drip Interval (seconds)
              {sheetIntervalSeconds > 0 && (
                <span className="ml-2 text-xs text-muted-foreground font-normal">= {fmtInterval(sheetIntervalSeconds / 60)}</span>
              )}
            </label>
            <input
              type="number"
              value={sheetIntervalSeconds}
              onChange={e => setSheetIntervalSeconds(Math.max(0, Math.min(86400, Number(e.target.value) || 0)))}
              className={fieldClass}
              min={0} max={86400} step={1}
              placeholder="0 = all at once, 60 = every 1 min, 30 = every 30s"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Verify Hold (hours)
            <span className="ml-2 text-xs text-muted-foreground font-normal">
              How long before accepted submissions clear from pending → available
            </span>
          </label>
          <input
            type="number"
            value={sheetHoldHoursDefault}
            onChange={e => {
              const v = e.target.value;
              if (v === "") setSheetHoldHoursDefault("");
              else setSheetHoldHoursDefault(Math.max(0, Math.min(720, Number(v) || 0)));
            }}
            className={fieldClass}
            min={0} max={720} step={1}
            placeholder="168"
          />
          <p className="text-xs text-muted-foreground mt-1.5">
            Default <strong>168h (7 days)</strong>. Set lower for faster payouts (e.g. <strong>24</strong> = 1 day, <strong>1</strong> = 1 hour, <strong>0</strong> = instant). Max 720h (30d). Per-row <code>hold_hours</code> column overrides this.
          </p>
        </div>

        <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
          <input
            type="checkbox"
            checked={sheetNotifyUnclaimed}
            onChange={e => setSheetNotifyUnclaimed(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-amber-500"
          />
          <span>
            <span className="font-medium text-foreground">Auto-bump unclaimed tasks (delete + repost + @here ping)</span>
            <span className="block text-muted-foreground mt-0.5">
              On (default) = if a task gets 0 claims, the bot deletes its message and re-posts a fresh one to the bottom of #tasks with an @here ping. Cadence: every 5 min for the first 3 bumps, then 10, 15, then 30 min steady. Stops as soon as any slot is claimed (caps at 24 bumps total).
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
          <input
            type="checkbox"
            checked={sheetMerge}
            onChange={e => setSheetMerge(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-blue-500"
          />
          <span>
            <span className="font-medium text-foreground">Single message mode (merge all rows into one task)</span>
            <span className="block text-muted-foreground mt-0.5">
              Off (default) = each CSV row becomes its own Discord message. On = all rows become <strong>one</strong> Discord message with N slots — users see one card and claim a slot, keeping the channel clean. Uses the first row's type/link/reward; total slots = sum of all rows' slots.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
          <input
            type="checkbox"
            checked={sheetAllowMulti}
            onChange={e => setSheetAllowMulti(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-green-500"
          />
          <span>
            <span className="font-medium text-foreground">Allow same user to claim multiple tasks in this campaign</span>
            <span className="block text-muted-foreground mt-0.5">
              Off (default) = one user can submit each task only once. On = same user can claim &amp; submit many tasks in this campaign.
            </span>
          </span>
        </label>

        {sheetAllowMulti && (
          <div className="ml-6 pl-3 border-l-2 border-green-500/40 space-y-1.5">
            <label className="block text-xs font-medium text-foreground">
              How many tasks can one user claim from this campaign?
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                value={sheetMaxClaimsPerUser}
                onChange={e => setSheetMaxClaimsPerUser(parseInt(e.target.value) || 0)}
                className="w-24 px-2.5 py-1.5 rounded-md bg-background border border-input text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="text-[11px] text-muted-foreground">
                tasks per user · enter <code>0</code> for unlimited
              </span>
            </div>
          </div>
        )}

        <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
          <input
            type="checkbox"
            checked={sheetCooldownEnabled}
            onChange={e => setSheetCooldownEnabled(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-green-500"
          />
          <span>
            <span className="font-medium text-foreground">Apply task cooldown</span>
            <span className="block text-muted-foreground mt-0.5">
              On (default) = global cooldown applies. Off = workers can claim immediately. Per-row <code>cooldown_enabled</code> overrides this.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleSheetPreview}
            disabled={sheetLoading || !sheetUrl.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sheetLoading ? "Working…" : "🔍 Preview (dry run)"}
          </button>
          <button
            type="button"
            onClick={handleSheetImport}
            disabled={sheetLoading || !sheetUrl.trim() || !sheetCampaign.trim()}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sheetLoading ? "Importing…" : "🚀 Import & Launch"}
          </button>
        </div>

        {sheetError && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive">
            {sheetError}
          </div>
        )}

        {sheetPreview && (
          <div className="rounded-lg border border-emerald-500/30 bg-background px-4 py-3 space-y-2 text-sm">
            <p className="font-medium text-emerald-500">
              ✅ Preview: found {sheetPreview.rowsFound} valid task(s). Nothing has been created yet.
            </p>
            {sheetPreview.autoFixNotes.length > 0 && (
              <div className="text-xs text-muted-foreground">
                <p className="font-medium mb-1">Auto-fixes applied:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {sheetPreview.autoFixNotes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Show cleaned CSV preview (first 5 rows)</summary>
              <pre className="mt-2 p-2 bg-secondary/40 rounded text-[10px] overflow-x-auto whitespace-pre">{sheetPreview.cleanedCsvPreview}</pre>
            </details>
            <p className="text-xs text-muted-foreground">
              Looks good? Fill in the campaign name above and click <strong>🚀 Import &amp; Launch</strong>.
            </p>
          </div>
        )}

        {sheetResult && (
          <div className={cn(
            "rounded-lg border px-4 py-3 space-y-2 text-sm",
            sheetResult.created > 0 || sheetResult.scheduled > 0
              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500"
              : "bg-destructive/10 border-destructive/20 text-destructive"
          )}>
            <p className="font-medium">
              {sheetResult.created === 1 && sheetResult.rowsFound > 1
                ? `Campaign #${sheetResult.campaignId} — created 1 task with ${sheetResult.rowsFound} slots (single message mode).`
                : sheetResult.intervalMinutes > 0
                ? `Campaign #${sheetResult.campaignId} — queued ${sheetResult.scheduled} of ${sheetResult.rowsFound} tasks (drip every ${fmtInterval(sheetResult.intervalMinutes)}).`
                : `Campaign #${sheetResult.campaignId} — created ${sheetResult.created} of ${sheetResult.rowsFound} tasks.`}
            </p>
            {sheetResult.autoFixNotes && sheetResult.autoFixNotes.length > 0 && (
              <div className="text-xs">
                <p className="font-medium mb-1">Auto-fixes applied:</p>
                <ul className="list-disc list-inside space-y-0.5 opacity-80">
                  {sheetResult.autoFixNotes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
            {sheetResult.errors.length > 0 && (
              <details className="text-xs">
                <summary className="cursor-pointer">Show {sheetResult.errors.length} row error(s)</summary>
                <ul className="mt-2 space-y-1 list-disc list-inside">
                  {sheetResult.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      {/* ============ CSV-paste flow ============ */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Campaign Name</label>
            <input
              type="text"
              value={campaignTitle}
              onChange={e => setCampaignTitle(e.target.value)}
              className={fieldClass}
              placeholder="e.g. April Twitter Push"
              required
              maxLength={100}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Drip Interval (seconds between tasks)
              {intervalSeconds > 0 && (
                <span className="ml-2 text-xs text-muted-foreground font-normal">= {fmtInterval(intervalSeconds / 60)}</span>
              )}
            </label>
            <input
              type="number"
              value={intervalSeconds}
              onChange={e => setIntervalSeconds(Math.max(0, Math.min(86400, Number(e.target.value) || 0)))}
              className={fieldClass}
              min={0}
              max={86400}
              step={1}
              placeholder="0"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              <strong>0</strong> = post all tasks at once.{" "}
              <strong>60</strong> = one every minute.{" "}
              <strong>30</strong> = one every 30 seconds.
              Schedule survives bot restarts.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Verify Hold (hours)
              <span className="ml-2 text-xs text-muted-foreground font-normal">
                How long before accepted submissions clear from pending → available
              </span>
            </label>
            <input
              type="number"
              value={holdHoursDefault}
              onChange={e => {
                const v = e.target.value;
                if (v === "") setHoldHoursDefault("");
                else setHoldHoursDefault(Math.max(0, Math.min(720, Number(v) || 0)));
              }}
              className={fieldClass}
              min={0} max={720} step={1}
              placeholder="168"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              Default <strong>168h (7 days)</strong>. Set lower for faster payouts (e.g. <strong>24</strong> = 1 day, <strong>1</strong> = 1 hour, <strong>0</strong> = instant). Max 720h (30d). Per-row <code>hold_hours</code> column overrides this.
            </p>
          </div>

          <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={notifyUnclaimed}
              onChange={e => setNotifyUnclaimed(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-amber-500"
            />
            <span>
              <span className="font-medium text-foreground">Auto-bump unclaimed tasks (delete + repost + @here ping)</span>
              <span className="block text-muted-foreground mt-0.5">
                On (default) = if a task gets 0 claims, the bot deletes its message and re-posts a fresh one to the bottom of #tasks with an @here ping. Cadence: every 5 min for the first 3 bumps, then 10, 15, then 30 min steady. Stops as soon as any slot is claimed (caps at 24 bumps total).
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={mergeIntoSingleTask}
              onChange={e => setMergeIntoSingleTask(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-blue-500"
            />
            <span>
              <span className="font-medium text-foreground">Single message mode (merge all rows into one task)</span>
              <span className="block text-muted-foreground mt-0.5">
                Off (default) = each CSV row becomes its own Discord message. On = all rows become <strong>one</strong> Discord message with N slots — users see one card and claim a slot, keeping the channel clean. Uses the first row's type/link/reward; total slots = sum of all rows' slots.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allowMultipleClaims}
              onChange={e => setAllowMultipleClaims(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-green-500"
            />
            <span>
              <span className="font-medium text-foreground">Allow same user to claim multiple tasks in this campaign</span>
              <span className="block text-muted-foreground mt-0.5">
                Off (default) = one user can submit each task only once. On = same user can claim &amp; submit many tasks in this campaign.
              </span>
            </span>
          </label>

          {allowMultipleClaims && (
            <div className="ml-6 pl-3 border-l-2 border-green-500/40 space-y-1.5">
              <label className="block text-xs font-medium text-foreground">
                How many tasks can one user claim from this campaign?
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={maxClaimsPerUser}
                  onChange={e => setMaxClaimsPerUser(parseInt(e.target.value) || 0)}
                  className="w-24 px-2.5 py-1.5 rounded-md bg-background border border-input text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <span className="text-[11px] text-muted-foreground">
                  tasks per user · enter <code>0</code> for unlimited
                </span>
              </div>
            </div>
          )}

          <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={cooldownEnabled}
              onChange={e => setCooldownEnabled(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-green-500"
            />
            <span>
              <span className="font-medium text-foreground">Apply task cooldown</span>
              <span className="block text-muted-foreground mt-0.5">
                On (default) = global cooldown applies to every task. Off = workers can claim immediately. A per-row <code>cooldown_enabled</code> column overrides this per row.
              </span>
            </span>
          </label>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-foreground">CSV Data</label>
              <button
                type="button"
                onClick={() => setCsv(SAMPLE_CSV)}
                className="text-xs text-primary hover:underline"
              >
                Insert sample CSV
              </button>
            </div>
            <textarea
              value={csv}
              onChange={e => setCsv(e.target.value)}
              className={cn(fieldClass, "min-h-[280px] font-mono text-xs leading-relaxed")}
              placeholder={SAMPLE_CSV}
              required
            />
            <details className="mt-2 text-xs text-muted-foreground" open>
              <summary className="cursor-pointer font-medium text-foreground">📋 Column reference (click to collapse)</summary>
              <div className="mt-2 space-y-1.5 pl-2 border-l-2 border-border">
                <p><strong className="text-foreground">Column order doesn't matter</strong> — the bot reads headers, not positions.</p>
                <p className="font-medium text-foreground mt-2">Required:</p>
                <ul className="list-disc list-inside space-y-0.5 pl-2">
                  <li><code>type</code> — <code>comment</code>, <code>post</code>, <code>upvote</code>, <code>twitter_like</code>, <code>twitter_retweet</code>, <code>twitter_comment</code>, <code>quora_upvote</code>, <code>quora_answer</code>, etc.</li>
                  <li><code>task_link</code> — Reddit URL / subreddit / Twitter URL / Quora URL (depends on type)</li>
                  <li><code>instructions</code> — <strong>what the worker reads</strong> (e.g. "Reply to the OP with the text below"). <strong>This is NOT the comment text.</strong></li>
                  <li><code>reward</code> — dollars (e.g. <code>0.20</code>)</li>
                  <li><code>slots</code> — how many workers can claim this task</li>
                </ul>
                <p className="font-medium text-foreground mt-2">Optional:</p>
                <ul className="list-disc list-inside space-y-0.5 pl-2">
                  <li><code>title</code> — for <code>post</code> tasks this is the <strong>actual Reddit post title</strong> the worker pastes. For all other types it's just a Discord-side label (leave blank to auto-generate).</li>
                  <li><code>prewritten_comment</code> (alias <code>comment</code>) — the <strong>exact text the worker pastes as their comment/reply</strong>. Shown with a "📋 Copy" button.</li>
                  <li><code>post_body</code> (alias <code>body</code>) — for <code>post</code> tasks, the body content (alternative to <code>prewritten_comment</code>).</li>
                  <li><code>image_url</code> — public http(s) URL shown on the task card</li>
                  <li><code>flair</code>, <code>time_limit</code> (mins), <code>hold_hours</code> (overrides campaign default above), <code>min_trust</code>, <code>max_claims_per_user</code>, <code>cooldown_enabled</code> (<code>true</code>/<code>false</code>)</li>
                </ul>
                <p className="mt-2 px-2 py-1.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200">
                  <strong>⚠️ Common mistake:</strong> putting the comment text in the <code>instructions</code> column.
                  <code>instructions</code> = directions for the worker. <code>prewritten_comment</code> = the actual text they post.
                </p>
              </div>
            </details>
          </div>

          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2.5 text-sm text-destructive">
              {error}
            </div>
          )}
          {result && (
            <div className={cn(
              "rounded-lg border px-4 py-3 space-y-2 text-sm",
              result.created > 0
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500"
                : "bg-destructive/10 border-destructive/20 text-destructive"
            )}>
              <p className="font-medium">
                {result.created === 1 && result.rowsFound > 1
                  ? `Campaign #${result.campaignId} — created 1 task with ${result.rowsFound} slots (single message mode).`
                  : result.intervalMinutes > 0
                  ? `Campaign #${result.campaignId} — queued ${result.scheduled} of ${result.rowsFound} tasks (drip every ${fmtInterval(result.intervalMinutes)}). First drops within 30s.`
                  : `Campaign #${result.campaignId} — created ${result.created} of ${result.rowsFound} tasks.`}
              </p>
              {result.errors.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer">Show {result.errors.length} error(s)</summary>
                  <ul className="mt-2 space-y-1 list-disc list-inside">
                    {result.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </details>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className={cn(
              "w-full py-2.5 rounded-lg font-semibold text-sm transition-all",
              "bg-primary text-primary-foreground hover:bg-primary/90",
              "disabled:opacity-60 disabled:cursor-not-allowed"
            )}
          >
            {loading ? "Creating campaign…" : "Create Tasks"}
          </button>
        </div>
      </form>
    </div>
  );
}

const fieldClass =
  "w-full px-3 py-2.5 rounded-lg bg-background border border-input text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm";
