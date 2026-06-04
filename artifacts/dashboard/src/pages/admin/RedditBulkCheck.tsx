import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { post } from "@/lib/api";
import { toast } from "@/hooks/use-toast";

import * as XLSX from "xlsx";

// ── Shared Utilities ────────────────────────────────────────────────────────
function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return "";
  return num.toLocaleString();
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  return new Date(dateStr).toISOString().split('T')[0]!;
}

function formatStatus(status: string | null | undefined): string {
  if (!status) return "";
  const map: Record<string, string> = {
    live: "Live", removed: "Removed", deleted: "Deleted", 
    not_found: "Not Found", error: "Error", no_comment: "No comment URL", 
    spam: "Spam", active: "Active", suspended: "Suspended", shadowbanned: "Shadowbanned"
  };
  return map[status] || status;
}

function exportToExcel(filename: string, sheetName: string, data: Record<string, any>[]) {
  if (!data || data.length === 0) return;
  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  XLSX.writeFile(workbook, filename);
}

async function exportToGoogleSheet(title: string, data: Record<string, any>[]) {
  if (!data || data.length === 0) return;
  const headers = Object.keys(data[0]!);
  const rows = data.map(r => headers.map(h => r[h]));

  try {
    toast({ title: "Creating Google Sheet..." });
    console.log("[GoogleSheets Frontend] Requesting /admin/bulk-check-to-sheet...");
    const res = await post("/admin/bulk-check-to-sheet", { title, headers, rows }) as any;
    console.log("[GoogleSheets Frontend] Response:", res);
    if (res.error) throw new Error(res.error);
    if (!res.url) throw new Error("Server returned 200 but no URL was found.");
    
    toast({
      title: "Sheet Created Successfully",
      description: `URL: ${res.url}`
    });
    
    // Automatically open the sheet in a new tab
    window.open(res.url, "_blank");
  } catch (err: any) {
    toast({ title: "Failed to create sheet", description: err.message, variant: "destructive" });
  }
}

function getCommentCheckData(results: BulkCheckRow[]) {
  return results.map(r => ({
    "Status": formatStatus(r.liveStatus),
    "URL": r.url || "",
    "Author": r.author || "",
    "Account Status": formatStatus(r.authorStatus),
    "Total Karma": formatNumber(r.authorKarma),
    "Account Age (Days)": formatNumber(r.authorAgeDays),
    "Comment Score": formatNumber(r.score),
    "Depth": formatNumber(r.depth),
    "Time Posted": formatDate(r.createdAt),
    "Removed By": r.removalBy || "",
    "Body Preview": r.bodyPreview || "",
    "Notes": [r.removalReason, r.error].filter(Boolean).join(" | ") || ""
  }));
}

function getPostCheckData(results: PostCheckRow[]) {
  return results.map(r => ({
    "Status": formatStatus(r.liveStatus),
    "Post URL": r.url || "",
    "Author": r.author || "",
    "Account Status": formatStatus(r.authorStatus),
    "Total Karma": formatNumber(r.authorKarma),
    "Account Age (Days)": formatNumber(r.authorAgeDays),
    "Score": formatNumber(r.score),
    "Upvote Ratio": formatNumber(r.upvoteRatio !== null ? r.upvoteRatio * 100 : null) + (r.upvoteRatio !== null ? "%" : ""),
    "Comments Count": formatNumber(r.numComments),
    "Removed By": r.removalBy || "",
    "Subreddit": r.subreddit || "",
    "Notes": [r.removalReason, r.error, r.isLocked ? "Locked" : "", r.isArchived ? "Archived" : ""].filter(Boolean).join(" | ") || ""
  }));
}

function getAuthorCheckData(results: AuthorRow[]) {
  return results.map(r => ({
    "Username": r.username || "",
    "Account Status": formatStatus(r.status),
    "Total Karma": formatNumber(r.karma),
    "Comment Karma": "",
    "Link Karma": "",
    "Account Age (Days)": formatNumber(r.ageDays),
    "Created Date": formatDate(r.createdAt),
    "Avatar URL": ""
  }));
}

function getFraudPatternsData(results: (BulkCheckRow & { fraudFlags: string[] })[]) {
  const authorGroups = new Map<string, typeof results>();
  for (const r of results) {
    if (r.author) {
      if (!authorGroups.has(r.author)) authorGroups.set(r.author, []);
      authorGroups.get(r.author)!.push(r);
    }
  }

  return Array.from(authorGroups.values()).map(group => {
    const first = group[0]!;
    const allFlags = Array.from(new Set(group.flatMap(r => r.fraudFlags)));
    
    let riskLevel = "Low";
    if (allFlags.length >= 3 || first.authorStatus === "suspended" || first.authorStatus === "shadowbanned") riskLevel = "High";
    else if (allFlags.length >= 2 || group.length >= 3) riskLevel = "Medium";

    return {
      "Author": first.author || "",
      "Risk Level": riskLevel,
      "Account Status": formatStatus(first.authorStatus),
      "Total Karma": formatNumber(first.authorKarma),
      "Account Age (Days)": formatNumber(first.authorAgeDays),
      "Duplicate Count": formatNumber(group.length),
      "Flags": allFlags.join(", "),
      "URLs involved": group.map(r => r.url).join(", ")
    };
  });
}

// ── Comment checker types ────────────────────────────────────────────────────
interface BulkCheckRow {
  url: string;
  ok: boolean;
  liveStatus: "live" | "removed" | "deleted" | "not_found" | "error" | "no_comment";
  author: string | null;
  authorStatus: "active" | "suspended" | "deleted" | "shadowbanned" | "unknown" | null;
  authorKarma: number | null;
  authorAgeDays: number | null;
  subreddit: string | null;
  title: string | null;
  createdAt: string | null;
  removalReason: string | null;
  removalBy: string | null;
  error: string | null;
  score: number | null;
  depth: number | null;
  bodyPreview: string | null;
}

interface BulkCheckResponse {
  results: BulkCheckRow[];
  summary: { total: number; live: number; removed: number; noComment: number; errored: number };
}

// ── Post existence checker types ─────────────────────────────────────────────
interface PostCheckRow {
  url: string;
  ok: boolean;
  liveStatus: "live" | "removed" | "deleted" | "not_found" | "error" | "spam";
  author: string | null;
  authorStatus: "active" | "suspended" | "deleted" | "shadowbanned" | "unknown" | null;
  authorKarma: number | null;
  authorAgeDays: number | null;
  subreddit: string | null;
  postId: string | null;
  createdAt: string | null;
  removalReason: string | null;
  removalBy: string | null;
  error: string | null;
  score: number | null;
  upvoteRatio: number | null;
  numComments: number | null;
  isLocked: boolean | null;
  isArchived: boolean | null;
}

interface PostCheckResponse {
  results: PostCheckRow[];
  summary: { total: number; live: number; removed: number; notFound: number; errored: number };
}

// ── Author Bulk Checker Types ────────────────────────────────────────────────
interface AuthorRow {
  username: string;
  ok: boolean;
  status: "active" | "suspended" | "deleted" | "shadowbanned" | "unknown" | "error";
  karma: number | null;
  createdAt: string | null;
  ageDays: number | null;
  hasActivity: boolean | null;
  error: string | null;
}

interface AuthorCheckResponse {
  results: AuthorRow[];
  summary: { total: number; active: number; suspended: number; shadowbanned: number; deleted: number; errored: number };
}

// ── Shared pill configs ───────────────────────────────────────────────────────
const COMMENT_STATUS_PILL: Record<BulkCheckRow["liveStatus"], { label: string; cls: string }> = {
  live:       { label: "Live",           cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  removed:    { label: "Removed",        cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  deleted:    { label: "Deleted",        cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  not_found:  { label: "Not found",      cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  error:      { label: "Error",          cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  no_comment: { label: "No comment URL", cls: "bg-purple-500/15 text-purple-400 border-purple-500/30" },
};

const POST_STATUS_PILL: Record<PostCheckRow["liveStatus"], { label: string; cls: string }> = {
  live:      { label: "Live",      cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  removed:   { label: "Removed",   cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  deleted:   { label: "Deleted",   cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  not_found: { label: "Not found", cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  spam:      { label: "Spam",      cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  error:     { label: "Error",     cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
};

const REMOVAL_BY_PILL: Record<string, string> = {
  "Removed by mod":      "bg-red-500/15 text-red-400 border-red-500/30",
  "Removed by Reddit":   "bg-red-500/15 text-red-400 border-red-500/30",
  "Filtered by AutoMod": "bg-orange-500/15 text-orange-400 border-orange-500/30",
  "Deleted by author":   "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  "Comment deleted":     "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  "Not found (404)":     "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

// ── Comment Checker Panel ─────────────────────────────────────────────────────
function CommentCheckerPanel() {
  const [text, setText] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  const mutation = useMutation({
    mutationFn: () => {
      const urls = text
        .split(/\r?\n|,|\s+/g)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return post<BulkCheckResponse>("/admin/reddit-bulk-check", { urls });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) mutation.mutate();
  };

  const data = mutation.data;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Paste Reddit comment proof URLs — the bot checks each one and reports
        whether the comment is still live, who removed it, and why.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Reddit Comment URLs
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={"https://reddit.com/r/sub/comments/abc/title/COMMENT_ID/\nhttps://reddit.com/r/sub/comments/def/title/COMMENT_ID/\n…"}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Up to 100 URLs per check. URLs without a comment ID will be flagged as "No comment URL".
            </p>
          </div>

          <button
            type="submit"
            disabled={mutation.isPending || !text.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending ? "Checking…" : "Check Comments"}
          </button>
        </div>
      </form>

      {mutation.isError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to run bulk check: {(mutation.error as Error)?.message ?? "unknown error"}
        </div>
      )}

      {mutation.isPending && (
        <div className="space-y-4">
           <div className="h-8 w-full animate-pulse rounded-md bg-muted/40"></div>
           <div className="h-64 w-full animate-pulse rounded-xl bg-muted/40"></div>
        </div>
      )}

      {data && !mutation.isPending && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-md border border-border bg-card px-3 py-1.5">
                Total: <strong>{data.summary.total}</strong>
              </span>
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-emerald-400">
                Live: <strong>{data.summary.live}</strong>
              </span>
              <span className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-red-400">
                Removed/deleted: <strong>{data.summary.removed}</strong>
              </span>
              {data.summary.noComment > 0 && (
                <span className="rounded-md border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-purple-400">
                  No comment URL: <strong>{data.summary.noComment}</strong>
                </span>
              )}
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-amber-400">
                Errors: <strong>{data.summary.errored}</strong>
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const outData = getCommentCheckData(data.results);
                  const dateStr = new Date().toISOString().split('T')[0];
                  exportToExcel(`outpost-comments-${dateStr}.xlsx`, "Comments", outData);
                }}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted/50"
              >
                Export XLSX
              </button>
              <button
                disabled={isExporting}
                onClick={async () => {
                  setIsExporting(true);
                  try {
                    const outData = getCommentCheckData(data.results);
                    const dateStr = new Date().toISOString().split('T')[0];
                    await exportToGoogleSheet(`Bulk Check - Comments - ${dateStr}`, outData);
                  } finally {
                    setIsExporting(false);
                  }
                }}
                className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isExporting ? "Exporting..." : "Export to Google Sheet"}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-left px-3 py-2 font-medium">URL</th>
                    <th className="text-left px-3 py-2 font-medium">Author</th>
                    <th className="text-left px-3 py-2 font-medium">Karma/Age</th>
                    <th className="text-left px-3 py-2 font-medium">Score / Depth</th>
                    <th className="text-left px-3 py-2 font-medium">Time</th>
                    <th className="text-left px-3 py-2 font-medium">Removed By</th>
                    <th className="text-left px-3 py-2 font-medium">Preview / Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r, i) => {
                    const pill = COMMENT_STATUS_PILL[r.liveStatus] ?? COMMENT_STATUS_PILL.error;
                    const removalByClass = r.removalBy
                      ? (REMOVAL_BY_PILL[r.removalBy] ?? "bg-zinc-500/15 text-zinc-400 border-zinc-500/30")
                      : null;
                    const notes = r.removalReason ?? r.error ?? r.bodyPreview ?? null;
                    
                    const isSuspicious = r.authorStatus === "suspended" || r.authorStatus === "shadowbanned";
                    
                    return (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/20">
                        <td className="px-3 py-2">
                          <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${pill.cls}`}>
                            {pill.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 max-w-[20ch] truncate">
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-mono text-xs" title={r.url}>
                            {r.url.split("/").slice(-3).join("/")}
                          </a>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            {r.author ? <span className="font-mono text-xs">{r.author}</span> : <span className="text-muted-foreground text-xs">—</span>}
                            {isSuspicious && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-500 uppercase tracking-wider" title={r.authorStatus!}>
                                ⚠️ {r.authorStatus}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.authorKarma !== null && r.authorAgeDays !== null ? (
                            <div className="flex items-center gap-1">
                              <span className={r.authorKarma < 100 ? "text-yellow-500 font-medium" : "text-muted-foreground"}>
                                {r.authorKarma.toLocaleString()} karma
                              </span>
                              <span className="text-muted-foreground">/</span>
                              <span className={r.authorAgeDays < 30 ? "text-red-500 font-medium" : "text-muted-foreground"}>
                                {r.authorAgeDays.toLocaleString()} days
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.score !== null ? `${r.score} pts / d${r.depth}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-3 py-2">
                          {removalByClass ? (
                            <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${removalByClass}`}>
                              {r.removalBy}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground max-w-[40ch] truncate" title={notes ?? ""}>
                          {notes ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Post Existence Checker Panel ──────────────────────────────────────────────
function PostCheckerPanel() {
  const [text, setText] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  const mutation = useMutation({
    mutationFn: () => {
      const urls = text
        .split(/\r?\n|,|\s+/g)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return post<PostCheckResponse>("/admin/reddit-post-check", { urls });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) mutation.mutate();
  };

  const data = mutation.data;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Paste Reddit post URLs to check whether each post still exists, has been
        removed by moderators, deleted by the author, or is no longer accessible.
        Works with full post URLs, share links, and comment URLs (the parent post
        is checked).
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Reddit Post URLs
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={"https://reddit.com/r/sub/comments/abc123/post_title/\nhttps://reddit.com/r/sub/comments/def456/another_post/\n…"}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Up to 100 URLs per check. Share links (reddit.com/r/sub/s/…) are resolved automatically.
            </p>
          </div>

          <button
            type="submit"
            disabled={mutation.isPending || !text.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending ? "Checking…" : "Check Posts"}
          </button>
        </div>
      </form>

      {mutation.isError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to run post check: {(mutation.error as Error)?.message ?? "unknown error"}
        </div>
      )}

      {mutation.isPending && (
        <div className="space-y-4">
           <div className="h-8 w-full animate-pulse rounded-md bg-muted/40"></div>
           <div className="h-64 w-full animate-pulse rounded-xl bg-muted/40"></div>
        </div>
      )}

      {data && !mutation.isPending && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-md border border-border bg-card px-3 py-1.5">
                Total: <strong>{data.summary.total}</strong>
              </span>
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-emerald-400">
                Live: <strong>{data.summary.live}</strong>
              </span>
              <span className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-red-400">
                Removed/deleted: <strong>{data.summary.removed}</strong>
              </span>
              {data.summary.notFound > 0 && (
                <span className="rounded-md border border-zinc-500/30 bg-zinc-500/10 px-3 py-1.5 text-zinc-400">
                  Not found: <strong>{data.summary.notFound}</strong>
                </span>
              )}
              <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-amber-400">
                Errors: <strong>{data.summary.errored}</strong>
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const outData = getPostCheckData(data.results);
                  const dateStr = new Date().toISOString().split('T')[0];
                  exportToExcel(`outpost-posts-${dateStr}.xlsx`, "Posts", outData);
                }}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted/50"
              >
                Export XLSX
              </button>
              <button
                disabled={isExporting}
                onClick={async () => {
                  setIsExporting(true);
                  try {
                    const outData = getPostCheckData(data.results);
                    const dateStr = new Date().toISOString().split('T')[0];
                    await exportToGoogleSheet(`Bulk Check - Posts - ${dateStr}`, outData);
                  } finally {
                    setIsExporting(false);
                  }
                }}
                className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isExporting ? "Exporting..." : "Export to Google Sheet"}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-left px-3 py-2 font-medium">Post URL</th>
                    <th className="text-left px-3 py-2 font-medium">Author</th>
                    <th className="text-left px-3 py-2 font-medium">Karma/Age</th>
                    <th className="text-left px-3 py-2 font-medium">Score/Ratio</th>
                    <th className="text-left px-3 py-2 font-medium">Cmts</th>
                    <th className="text-left px-3 py-2 font-medium">Removed By</th>
                    <th className="text-left px-3 py-2 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r, i) => {
                    const pill = POST_STATUS_PILL[r.liveStatus] ?? POST_STATUS_PILL.error;
                    const removalByClass = r.removalBy
                      ? (REMOVAL_BY_PILL[r.removalBy] ?? "bg-zinc-500/15 text-zinc-400 border-zinc-500/30")
                      : null;
                    const notes = r.removalReason ?? r.error ?? null;
                    const isSuspicious = r.authorStatus === "suspended" || r.authorStatus === "shadowbanned";

                    return (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/20">
                        <td className="px-3 py-2">
                          <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${pill.cls}`}>
                            {pill.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 max-w-[20ch] truncate">
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-mono text-xs" title={r.url}>
                            {r.url.split("/").slice(-3).join("/")}
                          </a>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            {r.author ? <span className="font-mono text-xs">{r.author}</span> : <span className="text-muted-foreground text-xs">—</span>}
                            {isSuspicious && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-500 uppercase tracking-wider" title={r.authorStatus!}>
                                ⚠️ {r.authorStatus}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.authorKarma !== null && r.authorAgeDays !== null ? (
                            <div className="flex items-center gap-1">
                              <span className={r.authorKarma < 100 ? "text-yellow-500 font-medium" : "text-muted-foreground"}>
                                {r.authorKarma.toLocaleString()} karma
                              </span>
                              <span className="text-muted-foreground">/</span>
                              <span className={r.authorAgeDays < 30 ? "text-red-500 font-medium" : "text-muted-foreground"}>
                                {r.authorAgeDays.toLocaleString()} days
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.score !== null ? `${r.score} (${Math.round((r.upvoteRatio || 0)*100)}%)` : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.numComments !== null ? r.numComments : "—"}
                        </td>
                        <td className="px-3 py-2">
                          {removalByClass ? (
                            <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${removalByClass}`}>
                              {r.removalBy}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground max-w-[36ch] truncate" title={notes ?? ""}>
                          {notes ?? (r.isLocked ? "Locked" : r.isArchived ? "Archived" : "—")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Author Checker Panel ────────────────────────────────────────────────────────
function AuthorCheckerPanel() {
  const [text, setText] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  const mutation = useMutation({
    mutationFn: () => {
      const usernames = text
        .split(/\r?\n|,|\s+/g)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return post<AuthorCheckResponse>("/admin/reddit-author-bulk-check", { usernames });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) mutation.mutate();
  };

  const data = mutation.data;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Paste Reddit usernames to check account statuses (e.g. shadowbans, suspensions), karma, and age.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Reddit Usernames
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={"username1\nu/username2\nusername3\n…"}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Up to 100 usernames per check.
            </p>
          </div>

          <button
            type="submit"
            disabled={mutation.isPending || !text.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending ? "Checking…" : "Check Authors"}
          </button>
        </div>
      </form>

      {mutation.isError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to run author check: {(mutation.error as Error)?.message ?? "unknown error"}
        </div>
      )}

      {mutation.isPending && (
        <div className="space-y-4">
           <div className="h-8 w-full animate-pulse rounded-md bg-muted/40"></div>
           <div className="h-64 w-full animate-pulse rounded-xl bg-muted/40"></div>
        </div>
      )}

      {data && !mutation.isPending && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-md border border-border bg-card px-3 py-1.5">
                Total: <strong>{data.summary.total}</strong>
              </span>
              <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-emerald-400">
                Active: <strong>{data.summary.active}</strong>
              </span>
              <span className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-red-400">
                Suspended/Deleted: <strong>{data.summary.suspended + data.summary.deleted}</strong>
              </span>
              {data.summary.shadowbanned > 0 && (
                <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-amber-400">
                  Shadowbanned: <strong>{data.summary.shadowbanned}</strong>
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const outData = getAuthorCheckData(data.results);
                  const dateStr = new Date().toISOString().split('T')[0];
                  exportToExcel(`outpost-authors-${dateStr}.xlsx`, "Authors", outData);
                }}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted/50"
              >
                Export XLSX
              </button>
              <button
                disabled={isExporting}
                onClick={async () => {
                  setIsExporting(true);
                  try {
                    const outData = getAuthorCheckData(data.results);
                    const dateStr = new Date().toISOString().split('T')[0];
                    await exportToGoogleSheet(`Bulk Check - Authors - ${dateStr}`, outData);
                  } finally {
                    setIsExporting(false);
                  }
                }}
                className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isExporting ? "Exporting..." : "Export to Google Sheet"}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm whitespace-nowrap">
                <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-left px-3 py-2 font-medium">Username</th>
                    <th className="text-left px-3 py-2 font-medium">Karma</th>
                    <th className="text-left px-3 py-2 font-medium">Account Age</th>
                    <th className="text-left px-3 py-2 font-medium">Creation Date</th>
                    <th className="text-left px-3 py-2 font-medium">Any Activity</th>
                    <th className="text-left px-3 py-2 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r, i) => {
                    const isSuspicious = r.status === "suspended" || r.status === "shadowbanned";
                    const isDeleted = r.status === "deleted";
                    
                    let pillCls = "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";
                    if (r.status === "active") pillCls = "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
                    else if (isSuspicious) pillCls = "bg-amber-500/15 text-amber-400 border-amber-500/30";
                    else if (isDeleted || r.status === "error") pillCls = "bg-red-500/15 text-red-400 border-red-500/30";
                    
                    return (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/20">
                        <td className="px-3 py-2">
                          <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium uppercase ${pillCls}`}>
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 max-w-[20ch] truncate">
                          <a href={`https://reddit.com/user/${r.username}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-mono text-xs">
                            u/{r.username}
                          </a>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.karma !== null ? r.karma : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.ageDays !== null ? `${r.ageDays} days` : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.hasActivity !== null ? (r.hasActivity ? "Yes" : "No") : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {r.error ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Fraud Checker Panel ───────────────────────────────────────────────────────
function FraudCheckerPanel() {
  const [text, setText] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  const mutation = useMutation({
    mutationFn: () => {
      const urls = text
        .split(/\r?\n|,|\s+/g)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return post<BulkCheckResponse>("/admin/reddit-bulk-check", { urls });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) mutation.mutate();
  };

  const data = mutation.data;
  
  // Calculate fraud patterns if data is loaded
  let suspiciousRows: (BulkCheckRow & { fraudFlags: string[] })[] = [];
  if (data && !mutation.isPending) {
    const authorCounts = new Map<string, number>();
    data.results.forEach(r => {
      if (r.author) {
        authorCounts.set(r.author, (authorCounts.get(r.author) || 0) + 1);
      }
    });

    suspiciousRows = data.results.map(r => {
      const flags: string[] = [];
      if (r.authorAgeDays !== null && r.authorAgeDays < 30) flags.push("Age < 30 days");
      if (r.authorKarma !== null && r.authorKarma < 100) flags.push("Karma < 100");
      if (r.author && authorCounts.get(r.author)! > 1) flags.push("Duplicate author");
      if (r.authorStatus === "suspended" || r.authorStatus === "shadowbanned") flags.push(`Account ${r.authorStatus}`);
      return { ...r, fraudFlags: flags };
    }).filter(r => r.fraudFlags.length > 0);
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Paste Reddit comment URLs. This tool automatically flags suspicious patterns such as young accounts, low karma, duplicate authors, and shadowbanned accounts.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Reddit Comment URLs
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={"https://reddit.com/r/sub/comments/abc/title/COMMENT_ID/\n…"}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          <button
            type="submit"
            disabled={mutation.isPending || !text.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending ? "Analyzing…" : "Analyze Fraud Patterns"}
          </button>
        </div>
      </form>

      {mutation.isError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Analysis failed: {(mutation.error as Error)?.message ?? "unknown error"}
        </div>
      )}

      {mutation.isPending && (
        <div className="space-y-4">
           <div className="h-8 w-full animate-pulse rounded-md bg-muted/40"></div>
           <div className="h-64 w-full animate-pulse rounded-xl bg-muted/40"></div>
        </div>
      )}

      {data && !mutation.isPending && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-md border border-border bg-card px-3 py-1.5">
                Total Checked: <strong>{data.results.length}</strong>
              </span>
              <span className={`rounded-md border px-3 py-1.5 ${suspiciousRows.length > 0 ? 'border-amber-500/30 bg-amber-500/10 text-amber-400' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'}`}>
                Suspicious: <strong>{suspiciousRows.length}</strong>
              </span>
            </div>
            {suspiciousRows.length > 0 && (
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const outData = getFraudPatternsData(suspiciousRows);
                    const dateStr = new Date().toISOString().split('T')[0];
                    exportToExcel(`outpost-fraud-${dateStr}.xlsx`, "Fraud Patterns", outData);
                  }}
                  className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted/50"
                >
                  Export XLSX
                </button>
                <button
                  disabled={isExporting}
                  onClick={async () => {
                    setIsExporting(true);
                    try {
                      const outData = getFraudPatternsData(suspiciousRows);
                      const dateStr = new Date().toISOString().split('T')[0];
                      await exportToGoogleSheet(`Bulk Check - Fraud - ${dateStr}`, outData);
                    } finally {
                      setIsExporting(false);
                    }
                  }}
                  className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isExporting ? "Exporting..." : "Export to Google Sheet"}
                </button>
              </div>
            )}
          </div>

          {suspiciousRows.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
              No fraud patterns detected!
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm whitespace-nowrap">
                  <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Author</th>
                      <th className="text-left px-3 py-2 font-medium">URL</th>
                      <th className="text-left px-3 py-2 font-medium">Karma/Age</th>
                      <th className="text-left px-3 py-2 font-medium">Fraud Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suspiciousRows.map((r, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/20">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            {r.author ? <span className="font-mono text-xs">{r.author}</span> : <span className="text-muted-foreground text-xs">—</span>}
                            {(r.authorStatus === "suspended" || r.authorStatus === "shadowbanned") && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-500 uppercase tracking-wider" title={r.authorStatus!}>
                                ⚠️ {r.authorStatus}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 max-w-[20ch] truncate">
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-mono text-xs" title={r.url}>
                            {r.url.split("/").slice(-3).join("/")}
                          </a>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {r.authorKarma !== null && r.authorAgeDays !== null ? (
                            <div className="flex items-center gap-1">
                              <span className={r.authorKarma < 100 ? "text-yellow-500 font-medium" : "text-muted-foreground"}>
                                {r.authorKarma.toLocaleString()} karma
                              </span>
                              <span className="text-muted-foreground">/</span>
                              <span className={r.authorAgeDays < 30 ? "text-red-500 font-medium" : "text-muted-foreground"}>
                                {r.authorAgeDays.toLocaleString()} days
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs font-medium text-amber-500 flex gap-2 flex-wrap">
                          {r.fraudFlags.map(f => (
                            <span key={f} className="bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 rounded-md">{f}</span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page with tabs ───────────────────────────────────────────────────────
type Tab = "comments" | "posts" | "authors" | "fraud";

export default function RedditBulkCheck() {
  const [activeTab, setActiveTab] = useState<Tab>("comments");

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-bold text-foreground">Reddit Bulk Check Tools</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Bulk-check comments, posts, and authors, and automatically detect fraud patterns.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 rounded-xl border border-border bg-muted/30 p-1 w-fit">
        <button
          onClick={() => setActiveTab("comments")}
          className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
            activeTab === "comments"
              ? "bg-background text-foreground shadow-sm border border-border"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Comment Proof Check
        </button>
        <button
          onClick={() => setActiveTab("posts")}
          className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
            activeTab === "posts"
              ? "bg-background text-foreground shadow-sm border border-border"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Post Existence Check
        </button>
        <button
          onClick={() => setActiveTab("authors")}
          className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
            activeTab === "authors"
              ? "bg-background text-foreground shadow-sm border border-border"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Author Bulk Check
        </button>
        <button
          onClick={() => setActiveTab("fraud")}
          className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
            activeTab === "fraud"
              ? "bg-background text-foreground shadow-sm border border-border"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Fraud Patterns
        </button>
      </div>

      {activeTab === "comments" && <CommentCheckerPanel />}
      {activeTab === "posts" && <PostCheckerPanel />}
      {activeTab === "authors" && <AuthorCheckerPanel />}
      {activeTab === "fraud" && <FraudCheckerPanel />}
    </div>
  );
}
