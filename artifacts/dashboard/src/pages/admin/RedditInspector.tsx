import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { post } from "@/lib/api";
import { AlertCircle, CheckCircle2, Clock, Search, ShieldAlert, ShieldBan, User, Hash, MessageSquare, AlertTriangle, ExternalLink, Download, FileSpreadsheet } from "lucide-react";

interface InspectorRow {
  url: string;
  type: "post" | "comment" | "unknown";
  target: {
    status: "live" | "removed" | "deleted" | "not_found" | "error" | "spam" | "active";
    author: string | null;
    subreddit: string | null;
    title?: string | null;
    body_preview?: string | null;
    score: number | null;
    upvotes: number | null;
    num_comments?: number | null;
    depth?: number | null;
    created_utc: number | null;
    createdAt: number | null;
    post_status?: string | null;
    removed_by_category?: string | null;
    error: string | null;
  } | null;
  author: {
    status: "active" | "suspended" | "shadowbanned" | "deleted" | "error";
    username: string;
    total_karma: number | null;
    created_utc: number | null;
    avatar_url: string | null;
    last_active_utc: number | null;
    error: string | null;
  } | null;
  error: string | null;
}

interface InspectorResponse {
  results: InspectorRow[];
}

function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return "—";
  return new Intl.NumberFormat("en-US").format(num);
}

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp * 1000).toLocaleString();
}

function formatAgeDays(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  const days = Math.floor((Date.now() - timestamp * 1000) / (1000 * 60 * 60 * 24));
  return `${days} days`;
}

function TargetStatusPill({ status }: { status?: string | null }) {
  if (status === "live" || status === "active") {
    return <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400 border border-emerald-500/20 capitalize"><CheckCircle2 className="h-3 w-3" /> {status}</span>;
  }
  if (status === "removed") {
    return <span className="inline-flex items-center gap-1 rounded bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400 border border-red-500/20"><ShieldAlert className="h-3 w-3" /> Removed</span>;
  }
  if (status === "deleted") {
    return <span className="inline-flex items-center gap-1 rounded bg-zinc-500/10 px-2 py-0.5 text-xs font-medium text-zinc-400 border border-zinc-500/20"><ShieldBan className="h-3 w-3" /> Deleted</span>;
  }
  if (status === "not_found") {
    return <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400 border border-amber-500/20"><ShieldBan className="h-3 w-3" /> Not Found / Deleted</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400 border border-amber-500/20 capitalize"><AlertCircle className="h-3 w-3" /> {status || "Unknown"}</span>;
}

function AuthorStatusPill({ status }: { status?: string | null }) {
  if (!status) return null;
  if (status === "active") return <span className="inline-flex items-center rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400 border border-emerald-500/20">Active</span>;
  if (status === "shadowbanned") return <span className="inline-flex items-center rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400 border border-amber-500/20">Shadowbanned</span>;
  return <span className="inline-flex items-center rounded bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400 border border-red-500/20 capitalize">{status}</span>;
}

export default function RedditInspector() {
  const [text, setText] = useState("");

  const mutation = useMutation({
    mutationFn: () => {
      const urls = text.split(/\r?\n|,|\s+/g).map((s) => s.trim()).filter((s) => s.length > 0);
      return post<InspectorResponse>("/admin/reddit-inspector", { urls });
    },
  });

  const exportSheetMutation = useMutation({
    mutationFn: (results: InspectorRow[]) => post<{ sheetId: string; sheetUrl: string }>("/admin/bulk-check-to-sheet", {
      type: "Inspector",
      results: results.map(r => ({
        URL: r.url,
        Type: r.type,
        "Target Status": r.target?.status || r.error || "error",
        Score: r.target?.score || "",
        Subreddit: r.target?.subreddit || "",
        "Posted Date": r.target?.createdAt ? formatDate(r.target.createdAt) : "",
        Author: r.target?.author || "",
        "Author Status": r.author?.status || "",
        Karma: r.author?.total_karma || "",
        "Account Age": r.author?.created_utc ? formatAgeDays(r.author.created_utc) : "",
        "Last Active": r.author?.last_active_utc ? formatAgeDays(r.author.last_active_utc) : "",
        "Removed By": r.target?.removed_by_category || ""
      }))
    }),
    onSuccess: (data) => {
      window.open(data.sheetUrl, "_blank");
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) mutation.mutate();
  };

  const exportCSV = () => {
    if (!mutation.data?.results) return;
    const rows = mutation.data.results.map(r => ({
      URL: r.url,
      Type: r.type,
      "Target Status": r.target?.status || r.error || "error",
      Score: r.target?.score || "",
      Subreddit: r.target?.subreddit || "",
      "Posted Date": r.target?.createdAt ? formatDate(r.target.createdAt) : "",
      Author: r.target?.author || "",
      "Author Status": r.author?.status || "",
      Karma: r.author?.total_karma || "",
      "Account Age": r.author?.created_utc ? formatAgeDays(r.author.created_utc) : "",
      "Last Active": r.author?.last_active_utc ? formatAgeDays(r.author.last_active_utc) : "",
      "Removed By": r.target?.removed_by_category || ""
    }));
    
    const headers = Object.keys(rows[0]);
    const csvRows = [headers.join(",")];
    for (const row of rows) {
      const values = headers.map(h => {
        const val = (row as any)[h];
        if (val === null || val === undefined) return "";
        const str = String(val).replace(/"/g, '""');
        return `"${str}"`;
      });
      csvRows.push(values.join(","));
    }
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `reddit-inspector-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const { data, isPending, isError, error } = mutation;
  const singleResult = data?.results?.length === 1 ? data.results[0] : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Reddit Inspector</h1>
        <p className="text-muted-foreground mt-1">
          Deep scan a Reddit post or comment to check its status and full author profile. Supports bulk checking.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste one or more Reddit URLs (one per line)..."
          className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-muted-foreground/50 min-h-[100px] resize-y"
          required
        />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isPending || !text.trim()}
            className="flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {isPending ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-r-transparent" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            Inspect URL{text.split(/\r?\n|,|\s+/g).filter(s => s.trim().length > 0).length > 1 ? "s" : ""}
          </button>
        </div>
      </form>

      {isError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5" />
          <span>{(error as any)?.message || "Failed to inspect URLs"}</span>
        </div>
      )}

      {/* SINGLE RESULT RENDER - Existing Card UI */}
      {singleResult && (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="border-b border-border bg-muted/20 px-5 py-4">
              <h2 className="font-semibold text-foreground flex items-center gap-2">
                {singleResult.type === "post" ? <Hash className="h-4 w-4 text-muted-foreground" /> : <MessageSquare className="h-4 w-4 text-muted-foreground" />}
                {singleResult.type === "post" ? "Post Details" : "Comment Details"}
              </h2>
            </div>
            <div className="p-5 space-y-4">
              {singleResult.error ? (
                <div className="text-red-400 text-sm">Error: {singleResult.error}</div>
              ) : (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Status</div>
                    <TargetStatusPill status={singleResult.target?.status} />
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Subreddit</div>
                    <div className="font-medium truncate" title={singleResult.target?.subreddit || ""}>r/{singleResult.target?.subreddit || "—"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Score</div>
                    <div className="font-medium">{formatNumber(singleResult.target?.score)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Posted At</div>
                    <div className="font-medium">{formatDate(singleResult.target?.createdAt)}</div>
                  </div>
                  
                  {singleResult.target?.title && (
                    <div className="col-span-2 mt-2">
                      <div className="text-muted-foreground text-xs mb-1">Title</div>
                      <div className="text-foreground bg-muted/30 p-3 rounded-lg border border-border/50 text-sm">{singleResult.target?.title}</div>
                    </div>
                  )}

                  {singleResult.target?.body_preview && (
                    <div className="col-span-2 mt-2">
                      <div className="text-muted-foreground text-xs mb-1">Preview</div>
                      <div className="text-foreground bg-muted/30 p-3 rounded-lg border border-border/50 text-sm whitespace-pre-wrap">
                        {singleResult.target?.body_preview}
                      </div>
                    </div>
                  )}

                  {singleResult.target?.removed_by_category && (
                     <div className="col-span-2 mt-1">
                      <div className="text-muted-foreground text-xs mb-1">Removed By</div>
                      <div className="text-red-400 font-medium">{singleResult.target.removed_by_category}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="border-b border-border bg-muted/20 px-5 py-4 flex items-center justify-between">
              <h2 className="font-semibold text-foreground flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                Author Details
              </h2>
              {singleResult.author?.username && (
                <a href={`https://reddit.com/user/${singleResult.author.username}`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1">
                  View Profile <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <div className="p-5 space-y-4">
              {!singleResult.author ? (
                <div className="text-muted-foreground text-sm flex items-center gap-2">
                  <User className="h-4 w-4" /> No author data available
                </div>
              ) : singleResult.author.error ? (
                <div className="text-red-400 text-sm">Error: {singleResult.author.error}</div>
              ) : (
                <div className="flex flex-col gap-5">
                  <div className="flex items-center gap-4">
                    {singleResult.author.avatar_url ? (
                      <img src={singleResult.author.avatar_url.split("?")[0]} alt="Avatar" className="h-16 w-16 rounded-full border border-border bg-muted" />
                    ) : (
                      <div className="h-16 w-16 rounded-full border border-border bg-muted flex items-center justify-center">
                        <User className="h-8 w-8 text-muted-foreground" />
                      </div>
                    )}
                    <div>
                      <div className="font-bold text-lg text-foreground">u/{singleResult.author.username}</div>
                      <div className="flex items-center gap-2 mt-1">
                        <AuthorStatusPill status={singleResult.author.status} />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm bg-muted/20 p-4 rounded-xl border border-border/50">
                    <div>
                      <div className="text-muted-foreground text-xs mb-1">Total Karma</div>
                      <div className="font-medium text-foreground">{formatNumber(singleResult.author.total_karma)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs mb-1">Account Age</div>
                      <div className="font-medium text-foreground" title={formatDate(singleResult.author.created_utc)}>
                        {formatAgeDays(singleResult.author.created_utc)}
                      </div>
                    </div>
                    <div className="col-span-2">
                      <div className="text-muted-foreground text-xs mb-1">Last Active</div>
                      <div className="font-medium text-foreground flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                        {singleResult.author.last_active_utc ? (
                          <span title={formatDate(singleResult.author.last_active_utc)}>
                            {formatAgeDays(singleResult.author.last_active_utc)} ago
                          </span>
                        ) : (
                          <span className="text-muted-foreground italic">No recent activity found</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MULTIPLE RESULTS RENDER - Table UI */}
      {data?.results && data.results.length > 1 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Results ({data.results.length})</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={exportCSV}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
              >
                <Download className="h-4 w-4" /> Export CSV
              </button>
              <button
                onClick={() => exportSheetMutation.mutate(data.results)}
                disabled={exportSheetMutation.isPending}
                className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 transition-colors disabled:opacity-50"
              >
                {exportSheetMutation.isPending ? (
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                ) : (
                  <FileSpreadsheet className="h-4 w-4" />
                )}
                Export to Google Sheet
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm text-foreground">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium whitespace-nowrap">Status</th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap">Type</th>
                    <th className="px-4 py-3 font-medium min-w-[200px]">URL</th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap">Score</th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap">Author</th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap">Auth Status</th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap">Karma</th>
                    <th className="px-4 py-3 font-medium whitespace-nowrap">Last Active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.results.map((row, i) => (
                    <tr key={i} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap">
                        {row.error ? (
                          <span className="text-red-400 text-xs">Error</span>
                        ) : (
                          <TargetStatusPill status={row.target?.status} />
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap capitalize text-muted-foreground">{row.type}</td>
                      <td className="px-4 py-3">
                        <a href={row.url} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate block max-w-[250px]">
                          {row.url}
                        </a>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{formatNumber(row.target?.score)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {row.author?.username ? (
                          <a href={`https://reddit.com/user/${row.author.username}`} target="_blank" rel="noreferrer" className="text-foreground hover:underline">
                            u/{row.author.username}
                          </a>
                        ) : row.target?.author ? (
                           <span className="text-foreground">u/{row.target.author}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <AuthorStatusPill status={row.author?.status} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">{formatNumber(row.author?.total_karma)}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {row.author?.last_active_utc ? formatAgeDays(row.author.last_active_utc) + " ago" : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
