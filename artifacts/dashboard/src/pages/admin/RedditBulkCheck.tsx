import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { post } from "@/lib/api";

interface BulkCheckRow {
  url: string;
  ok: boolean;
  liveStatus: "live" | "removed" | "deleted" | "not_found" | "error" | "no_comment";
  author: string | null;
  subreddit: string | null;
  title: string | null;
  createdAt: string | null;
  removalReason: string | null;
  removalBy: string | null;
  error: string | null;
}

interface BulkCheckResponse {
  results: BulkCheckRow[];
  summary: { total: number; live: number; removed: number; noComment: number; errored: number };
}

const STATUS_PILL: Record<BulkCheckRow["liveStatus"], { label: string; cls: string }> = {
  live:       { label: "Live",           cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  removed:    { label: "Removed",        cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  deleted:    { label: "Deleted",        cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  not_found:  { label: "Not found",      cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30" },
  error:      { label: "Error",          cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  no_comment: { label: "No comment URL", cls: "bg-purple-500/15 text-purple-400 border-purple-500/30" },
};

const REMOVAL_BY_PILL: Record<string, string> = {
  "Removed by mod":      "bg-red-500/15 text-red-400 border-red-500/30",
  "Removed by Reddit":   "bg-red-500/15 text-red-400 border-red-500/30",
  "Filtered by AutoMod": "bg-orange-500/15 text-orange-400 border-orange-500/30",
  "Deleted by author":   "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  "Comment deleted":     "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  "Not found (404)":     "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

export default function RedditBulkCheck() {
  const [text, setText] = useState("");

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
    <div className="p-6 space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-bold text-foreground">Reddit Bulk URL Checker</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Paste a list of Reddit URLs (one per line, or comma/space-separated) — the bot checks
          each one and reports whether it&apos;s still live, who removed it, and why.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Reddit URLs
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={"https://reddit.com/r/sub/comments/abc/...\nhttps://reddit.com/r/sub/comments/def/...\n…"}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Up to 100 URLs per check. Larger batches will be truncated.
            </p>
          </div>

          <button
            type="submit"
            disabled={mutation.isPending || !text.trim()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mutation.isPending ? "Checking…" : "Check URLs"}
          </button>
        </div>
      </form>

      {mutation.isError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to run bulk check: {(mutation.error as Error)?.message ?? "unknown error"}
        </div>
      )}

      {data && (
        <div className="space-y-4">
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

          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium w-24">Status</th>
                    <th className="text-left px-3 py-2 font-medium">URL</th>
                    <th className="text-left px-3 py-2 font-medium w-36">Removed By</th>
                    <th className="text-left px-3 py-2 font-medium">Reason / Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {data.results.map((r, i) => {
                    const pill = STATUS_PILL[r.liveStatus] ?? STATUS_PILL.error;
                    const removalByClass = r.removalBy
                      ? (REMOVAL_BY_PILL[r.removalBy] ?? "bg-zinc-500/15 text-zinc-400 border-zinc-500/30")
                      : null;
                    const notes = r.removalReason ?? r.error ?? null;
                    return (
                      <tr key={i} className="border-t border-border/60 hover:bg-muted/20">
                        <td className="px-3 py-2">
                          <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${pill.cls}`}>
                            {pill.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 max-w-[34ch] truncate">
                          <a
                            href={r.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline font-mono text-xs"
                            title={r.url}
                          >
                            {r.url}
                          </a>
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
