import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { get, post, patch, downloadFile } from "@/lib/api";
import { cn, timeAgo, statusColor } from "@/lib/utils";

interface AdminCampaign {
  id: number;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  totalTasks: number;
  tasksCreated: number;
  status: string;
  createdAt: string;
  creatorName: string | null;
  creatorAvatar: string | null;
  /** Legacy Apps Script webhook URL. */
  sheetsWebhookUrl: string | null;
  /** New "Create Sheet" flow — Google Sheets API spreadsheet ID. */
  sheetsSpreadsheetId: string | null;
  /** Human-clickable URL when sheetsSpreadsheetId is set. */
  sheetsUrl: string | null;
}

interface CampaignsResponse {
  campaigns: AdminCampaign[];
  /** True iff GOOGLE_SERVICE_ACCOUNT_JSON is set + parseable on the server. */
  sheetsServiceConfigured: boolean;
  /** The bot's service-account email — needed for the "share an existing sheet
   *  with this email" power-user flow. */
  sheetsServiceEmail: string | null;
}

export default function Campaigns() {
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [confirmTitle, setConfirmTitle] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelMsg, setCancelMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Per-campaign Google Sheet config modal state.
  const [sheetCampaign, setSheetCampaign] = useState<AdminCampaign | null>(null);
  const [sheetUrlInput, setSheetUrlInput] = useState("");
  const [sheetMsg, setSheetMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const qc = useQueryClient();

  const { data, isLoading } = useQuery<CampaignsResponse>({
    queryKey: ["admin-campaigns"],
    queryFn: () => get<CampaignsResponse>("/admin/campaigns"),
    refetchInterval: 30000,
  });

  const cancelMutation = useMutation({
    mutationFn: (vars: { id: number; reason: string }) =>
      post<{ ok: boolean; tasksClosed: number; releasedClaims: number }>(`/admin/campaigns/${vars.id}/cancel`, { reason: vars.reason }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["admin-campaigns"] });
      setCancelMsg({ kind: "ok", text: `Campaign cancelled. ${result.tasksClosed} task(s) closed, ${result.releasedClaims} claim(s) released.` });
      setConfirmId(null);
      setCancelReason("");
    },
    onError: (err: any) => {
      setCancelMsg({ kind: "err", text: err?.message ?? "Failed to cancel campaign" });
    },
  });

  function openCancel(c: AdminCampaign) {
    setCancelMsg(null);
    setCancelReason("");
    setConfirmId(c.id);
    setConfirmTitle(c.title);
  }

  function openSheet(c: AdminCampaign) {
    setSheetMsg(null);
    setSheetUrlInput(c.sheetsWebhookUrl ?? "");
    setShowAdvanced(false);
    setSheetCampaign(c);
  }

  // ONE-CLICK: bot creates a brand new Google Sheet and links it.
  // Accepts { id, force? } — force:true is sent only after the operator
  // confirms a "Sheet already exists, replace it?" prompt (handled below
  // in the onError 409 branch). This prevents an accidental second click
  // from orphaning the existing sheet and silently switching the link.
  const createSheetMutation = useMutation({
    mutationFn: (vars: { id: number; force?: boolean }) =>
      post<{ ok: boolean; spreadsheetId: string; url: string; backfilled?: number; backfillError?: string }>(
        `/admin/campaigns/${vars.id}/create-sheet`,
        vars.force ? { force: true } : {}
      ),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["admin-campaigns"] });
      // Refresh modal's local campaign reference so it shows the new link.
      const fresh = (qc.getQueryData<CampaignsResponse>(["admin-campaigns"])?.campaigns ?? [])
        .find(c => c.id === sheetCampaign?.id);
      if (fresh) setSheetCampaign(fresh);
      const backfillNote = result.backfilled && result.backfilled > 0
        ? ` Auto-backfilled ${result.backfilled} past submission${result.backfilled === 1 ? "" : "s"}.`
        : result.backfillError
          ? ` (Auto-backfill failed: ${result.backfillError} — try "Backfill past submissions" button.)`
          : "";
      setSheetMsg({
        kind: "ok",
        text: `Sheet created!${backfillNote} Click "Open Sheet" above to view it. Future submissions will fill in automatically.`,
      });
    },
    onError: (err: any, vars) => {
      // 409 = sheet already exists. Offer to replace (window.confirm so it
      // works on mobile without extra UI). On confirm we retry with force:true.
      const status = err?.status ?? err?.body?.status;
      const isConflict = status === 409 || /already exists/i.test(err?.body?.error ?? "");
      if (isConflict && !vars.force) {
        const existingUrl = err?.body?.existsUrl;
        const ok = window.confirm(
          "This campaign already has a Google Sheet linked.\n\n" +
          (existingUrl ? `Current sheet:\n${existingUrl}\n\n` : "") +
          "Click OK to create a NEW sheet and switch the campaign's link to it. " +
          "The old sheet stays in your Drive but new submissions will go to the new sheet.\n\n" +
          "Click Cancel to keep the existing sheet."
        );
        if (ok) {
          createSheetMutation.mutate({ id: vars.id, force: true });
          return;
        }
        setSheetMsg({ kind: "ok", text: "Kept the existing sheet. No changes made." });
        return;
      }
      const main = err?.body?.error ?? err?.message ?? "Failed to create sheet";
      const hint = err?.body?.hint;
      setSheetMsg({ kind: "err", text: hint ? `${main}\n\nFix: ${hint}` : main });
    },
  });

  // LEGACY: paste an Apps Script /exec URL.
  const sheetMutation = useMutation({
    mutationFn: (vars: { id: number; url: string }) =>
      patch<{ ok: boolean; sheetsWebhookUrl: string | null }>(
        `/admin/campaigns/${vars.id}/sheets-webhook`,
        { sheetsWebhookUrl: vars.url }
      ),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["admin-campaigns"] });
      // Refresh modal-local campaign reference so it shows the updated state
      // immediately instead of waiting for the 30s background poll.
      const fresh = (qc.getQueryData<CampaignsResponse>(["admin-campaigns"])?.campaigns ?? [])
        .find(c => c.id === sheetCampaign?.id);
      if (fresh) setSheetCampaign(fresh);
      setSheetMsg({
        kind: "ok",
        text: result.sheetsWebhookUrl
          ? "Webhook saved — new submissions in this campaign will mirror there."
          : "Webhook cleared."
      });
    },
    onError: (err: any) => {
      setSheetMsg({ kind: "err", text: err?.message ?? "Failed to save sheet URL" });
    },
  });

  // Backfill: dump all existing submissions for the campaign into its sheet.
  // Use case: operator linked the sheet AFTER the campaign already had
  // submissions, so the sheet started empty. NOTE: not idempotent — calling
  // twice duplicates rows. The button confirms before firing.
  const backfillMutation = useMutation({
    mutationFn: (id: number) =>
      post<{ ok: boolean; written: number; error?: string }>(`/admin/campaigns/${id}/backfill-sheet`, {}),
    onSuccess: (result) => {
      setSheetMsg({
        kind: "ok",
        text: result.written === 0
          ? "No past submissions found for this campaign — sheet is up to date."
          : `Backfilled ${result.written} past submission${result.written === 1 ? "" : "s"} into the sheet. Refresh the sheet to see them.`,
      });
    },
    onError: (err: any) => {
      setSheetMsg({ kind: "err", text: err?.body?.error ?? err?.message ?? "Backfill failed" });
    },
  });

  // Unlink: clears BOTH spreadsheet ID and legacy webhook URL.
  const unlinkMutation = useMutation({
    mutationFn: (id: number) => post<{ ok: boolean }>(`/admin/campaigns/${id}/unlink-sheet`, {}),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["admin-campaigns"] });
      const fresh = (qc.getQueryData<CampaignsResponse>(["admin-campaigns"])?.campaigns ?? [])
        .find(c => c.id === sheetCampaign?.id);
      if (fresh) setSheetCampaign(fresh);
      setSheetMsg({ kind: "ok", text: "Sheet unlinked from this campaign. Google Sheet itself was NOT deleted — you still own it." });
    },
    onError: (err: any) => {
      setSheetMsg({ kind: "err", text: err?.message ?? "Failed to unlink sheet" });
    },
  });

  // A campaign is "linked" iff it has a Sheets-API spreadsheet OR a legacy webhook.
  const isLinked = (c: AdminCampaign) => !!c.sheetsSpreadsheetId || !!c.sheetsWebhookUrl;

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-xl font-bold text-foreground">Campaigns</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{data?.campaigns.length ?? "..."} total campaigns</p>
      </div>

      {cancelMsg && (
        <div className={cn(
          "rounded-lg border px-4 py-3 text-sm",
          cancelMsg.kind === "ok"
            ? "bg-green-500/10 border-green-500/20 text-green-400"
            : "bg-destructive/10 border-destructive/20 text-destructive"
        )}>
          {cancelMsg.text}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {["Title", "Creator", "Source", "Tasks", "Progress", "Status", "Created", ""].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/50 animate-pulse">
                    {Array.from({ length: 8 }).map((_, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-3 bg-secondary rounded w-20" /></td>
                    ))}
                  </tr>
                ))
              ) : data?.campaigns.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No campaigns yet. Use <code className="bg-secondary px-1 rounded text-xs">/bulktask</code> in Discord to create one.
                  </td>
                </tr>
              ) : (
                data?.campaigns.map(c => {
                  const pct = c.totalTasks > 0 ? Math.round((c.tasksCreated / c.totalTasks) * 100) : 0;
                  const linked = isLinked(c);
                  return (
                    <tr key={c.id} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                      <td className="px-4 py-3 font-medium text-foreground max-w-[200px]">
                        <p className="truncate">{c.title}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          {c.creatorAvatar ? (
                            <img src={c.creatorAvatar} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-secondary border border-border shrink-0" />
                          )}
                          <span className="text-xs text-foreground truncate" title={c.creatorName ?? "—"}>
                            {c.creatorName ?? <span className="text-muted-foreground">—</span>}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-secondary border border-border text-muted-foreground uppercase">
                          {c.sourceType}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        <span className="text-foreground font-medium">{c.tasksCreated}</span>/{c.totalTasks}
                      </td>
                      <td className="px-4 py-3 w-32">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground w-8 text-right">{pct}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium border capitalize", statusColor(c.status))}>
                          {c.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{timeAgo(c.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => downloadFile(`/admin/campaigns/${c.id}/export.csv`, `campaign-${c.id}.csv`).catch((err) => alert(`Download failed: ${err.message}`))}
                            className="px-2 py-1 rounded text-xs font-medium bg-secondary text-foreground border border-border hover:bg-secondary/80 transition-colors"
                            title="Download a CSV report of every task in this campaign"
                          >
                            Report
                          </button>
                          <button
                            onClick={() => openSheet(c)}
                            className={cn(
                              "px-2 py-1 rounded text-xs font-medium border transition-colors",
                              linked
                                ? "bg-green-500/10 text-green-400 border-green-500/20 hover:bg-green-500/20"
                                : "bg-secondary text-muted-foreground border-border hover:bg-secondary/80"
                            )}
                            title={linked
                              ? "Google Sheet linked — every submission mirrors here automatically"
                              : "Click to create or link a Google Sheet for this campaign"}
                          >
                            {linked ? "Sheet ✓" : "Sheet"}
                          </button>
                          {(c.status === "active" || c.status === "open") && (
                            <button
                              onClick={() => openCancel(c)}
                              className="px-2 py-1 rounded text-xs font-medium bg-destructive/10 text-destructive border border-destructive/20 hover:bg-destructive/20 transition-colors"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {!isLoading && data?.campaigns && data.campaigns.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: "Total Campaigns", value: data.campaigns.length },
            { label: "Active", value: data.campaigns.filter(c => c.status === "active").length },
            { label: "Total Task Slots", value: data.campaigns.reduce((s, c) => s + c.totalTasks, 0) },
            { label: "Tasks Created", value: data.campaigns.reduce((s, c) => s + c.tasksCreated, 0) },
          ].map(stat => (
            <div key={stat.label} className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{stat.label}</p>
              <p className="text-xl font-bold text-foreground">{stat.value}</p>
            </div>
          ))}
        </div>
      )}

      {sheetCampaign && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="w-full max-w-lg rounded-xl border border-border bg-card shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border sticky top-0 bg-card">
              <h2 className="font-semibold text-foreground">Sheet for "{sheetCampaign.title}"</h2>
              <button onClick={() => { setSheetCampaign(null); setSheetMsg(null); }} className="text-muted-foreground hover:text-foreground">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-5 space-y-4">

              {/* CURRENT STATUS / OPEN LINK */}
              {sheetCampaign.sheetsUrl && (
                <div className="rounded-lg border border-green-500/20 bg-green-500/10 p-4 space-y-2">
                  <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Sheet linked — submissions auto-fill here
                  </div>
                  <a
                    href={sheetCampaign.sheetsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-green-400 hover:text-green-300 underline break-all"
                  >
                    {sheetCampaign.sheetsUrl}
                  </a>
                  <p className="text-xs text-muted-foreground">
                    Tip: open in Google Sheets and share with your accountant / client.
                  </p>
                </div>
              )}
              {!sheetCampaign.sheetsUrl && sheetCampaign.sheetsWebhookUrl && (
                <div className="rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-xs text-blue-300">
                  Using legacy Apps Script webhook. You can also click "Create New Sheet" below to switch to the simpler auto-flow.
                </div>
              )}

              {/* ONE-CLICK CREATE — main action */}
              {!sheetCampaign.sheetsUrl && (
                <>
                  {data?.sheetsServiceConfigured ? (
                    <button
                      onClick={() => createSheetMutation.mutate({ id: sheetCampaign.id })}
                      disabled={createSheetMutation.isPending}
                      className="w-full px-4 py-3 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 disabled:opacity-40 transition-colors flex items-center justify-center gap-2"
                    >
                      {createSheetMutation.isPending ? (
                        <>
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="10" strokeWidth="3" stroke="currentColor" opacity="0.3" />
                            <path d="M12 2 A10 10 0 0 1 22 12" strokeWidth="3" stroke="currentColor" fill="none" />
                          </svg>
                          Creating sheet...
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                          Create New Google Sheet
                        </>
                      )}
                    </button>
                  ) : (
                    <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/10 p-4 text-xs text-yellow-300 space-y-2">
                      <p className="font-medium">"Create Sheet" not available yet</p>
                      <p className="text-yellow-300/80">
                        Set the <code className="px-1 rounded bg-yellow-500/20">GOOGLE_SERVICE_ACCOUNT_JSON</code> env var on Render
                        with your service account's JSON key, then redeploy. (One-time 5-min Google Cloud setup.)
                      </p>
                    </div>
                  )}
                  <p className="text-xs text-center text-muted-foreground">
                    Bot creates a fresh sheet with headers and starts auto-filling submissions.
                    Sharing is controlled by Render env vars: set <code className="px-1 rounded bg-secondary">SHEETS_OWNER_EMAIL</code> to your Gmail (sheet is shared privately with you), or <code className="px-1 rounded bg-secondary">SHEETS_PUBLIC_BY_DEFAULT=true</code> for view-only-by-link. Default: bot keeps it private — you'll need to share manually from Sheets UI.
                  </p>
                </>
              )}

              {sheetMsg && (
                <p className={cn("text-xs", sheetMsg.kind === "ok" ? "text-green-400" : "text-destructive")}>
                  {sheetMsg.text}
                </p>
              )}

              {/* ADVANCED — legacy paste-URL fallback */}
              <details className="border border-border rounded-lg" open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
                <summary className="px-4 py-2 text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                  Advanced: paste an Apps Script webhook URL instead
                </summary>
                <div className="p-4 space-y-2 border-t border-border">
                  <p className="text-xs text-muted-foreground">
                    Old flow: build a Google Sheet yourself, add an Apps Script webhook, paste the /exec URL here.
                  </p>
                  <input
                    type="text"
                    placeholder="https://script.google.com/macros/s/.../exec"
                    value={sheetUrlInput}
                    onChange={e => setSheetUrlInput(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                  />
                  <button
                    onClick={() => sheetMutation.mutate({ id: sheetCampaign.id, url: sheetUrlInput.trim() })}
                    disabled={sheetMutation.isPending || !sheetUrlInput.trim()}
                    className="w-full px-3 py-2 rounded-lg bg-secondary text-foreground border border-border text-xs hover:bg-secondary/80 disabled:opacity-40 transition-colors"
                  >
                    {sheetMutation.isPending ? "Saving..." : "Save webhook URL"}
                  </button>
                </div>
              </details>

              {/* FOOTER actions */}
              <div className="flex gap-2 pt-2 border-t border-border">
                <button
                  onClick={() => { setSheetCampaign(null); setSheetMsg(null); }}
                  className="flex-1 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-secondary transition-colors"
                >
                  Close
                </button>
                {sheetCampaign.sheetsSpreadsheetId && (
                  <button
                    onClick={() => {
                      if (confirm(
                        "Backfill ALL past submissions for this campaign into the sheet?\n\n" +
                        "Use this if the sheet looks empty even though the campaign already had submissions.\n\n" +
                        "WARNING: Running this twice will create duplicate rows. Only click once."
                      )) {
                        backfillMutation.mutate(sheetCampaign.id);
                      }
                    }}
                    disabled={backfillMutation.isPending}
                    className="px-3 py-2 rounded-lg bg-primary/10 text-primary border border-primary/20 text-sm hover:bg-primary/20 disabled:opacity-40 transition-colors"
                    title="Dump every existing submission for this campaign into the sheet. Use once if the sheet is empty."
                  >
                    {backfillMutation.isPending ? "Backfilling..." : "Backfill past"}
                  </button>
                )}
                {isLinked(sheetCampaign) && (
                  <button
                    onClick={() => unlinkMutation.mutate(sheetCampaign.id)}
                    disabled={unlinkMutation.isPending}
                    className="px-3 py-2 rounded-lg bg-destructive/10 text-destructive border border-destructive/20 text-sm hover:bg-destructive/20 disabled:opacity-40 transition-colors"
                    title="Unlink the sheet from this campaign. The Google Sheet itself is NOT deleted."
                  >
                    {unlinkMutation.isPending ? "Unlinking..." : "Unlink"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="font-semibold text-foreground">Cancel Campaign #{confirmId}</h2>
              <button onClick={() => { setConfirmId(null); setCancelMsg(null); }} className="text-muted-foreground hover:text-foreground">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-muted-foreground">
                Cancel <span className="text-foreground font-medium">"{confirmTitle}"</span>? All open tasks will be closed and active claims released. Claimers will be notified via DM.
              </p>
              <input
                type="text"
                placeholder="Reason (optional)"
                value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {cancelMsg && (
                <p className={cn("text-xs", cancelMsg.kind === "ok" ? "text-green-400" : "text-destructive")}>
                  {cancelMsg.text}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => { setConfirmId(null); setCancelMsg(null); }}
                  className="flex-1 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-secondary transition-colors"
                >
                  Keep Campaign
                </button>
                <button
                  onClick={() => cancelMutation.mutate({ id: confirmId, reason: cancelReason.trim() || "Cancelled via dashboard" })}
                  disabled={cancelMutation.isPending}
                  className="flex-1 px-3 py-2 rounded-lg bg-destructive/10 text-destructive border border-destructive/20 text-sm font-medium hover:bg-destructive/20 disabled:opacity-40 transition-colors"
                >
                  {cancelMutation.isPending ? "Cancelling..." : "Cancel Campaign"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
