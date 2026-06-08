import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { post } from "@/lib/api";
import { AlertCircle, CheckCircle2, Clock, Search, ShieldAlert, ShieldBan, User, Hash, MessageSquare, AlertTriangle, ExternalLink } from "lucide-react";

interface InspectorResponse {
  target: {
    status: "live" | "removed" | "deleted" | "not_found" | "error" | "spam";
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

export default function RedditInspector() {
  const [url, setUrl] = useState("");

  const mutation = useMutation({
    mutationFn: () => post<InspectorResponse>("/admin/reddit-inspector", { url: url.trim() }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (url.trim()) mutation.mutate();
  };

  const { data, isPending, isError, error } = mutation;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Reddit Inspector</h1>
        <p className="text-muted-foreground mt-1">
          Deep scan a Reddit post or comment to check its status and full author profile.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex gap-3">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://reddit.com/r/.../comments/..."
          className="flex-1 rounded-xl border border-border bg-card px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-muted-foreground/50"
          required
        />
        <button
          type="submit"
          disabled={isPending || !url.trim()}
          className="flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {isPending ? (
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-r-transparent" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Inspect
        </button>
      </form>

      {isError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5" />
          <span>{(error as any)?.message || "Failed to inspect URL"}</span>
        </div>
      )}

      {data && (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Target Card */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="border-b border-border bg-muted/20 px-5 py-4">
              <h2 className="font-semibold text-foreground flex items-center gap-2">
                {data.target?.title !== undefined ? <Hash className="h-4 w-4 text-muted-foreground" /> : <MessageSquare className="h-4 w-4 text-muted-foreground" />}
                {data.target?.title !== undefined ? "Post Details" : "Comment Details"}
              </h2>
            </div>
            <div className="p-5 space-y-4">
              {data.target?.error && data.target.status === "error" ? (
                <div className="text-red-400 text-sm">Error: {data.target.error}</div>
              ) : (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Status</div>
                    <div className="flex items-center gap-1.5 font-medium">
                      {data.target?.status === "live" || data.target?.status === "active" ? (
                        <span className="text-emerald-500 flex items-center gap-1 capitalize"><CheckCircle2 className="h-4 w-4" /> {data.target?.status}</span>
                      ) : data.target?.status === "removed" ? (
                        <span className="text-red-400 flex items-center gap-1"><ShieldAlert className="h-4 w-4" /> Removed</span>
                      ) : data.target?.status === "deleted" ? (
                        <span className="text-zinc-400 flex items-center gap-1"><ShieldBan className="h-4 w-4" /> Deleted</span>
                      ) : data.target?.status === "not_found" ? (
                        <span className="text-amber-400 flex items-center gap-1"><ShieldBan className="h-4 w-4" /> Not Found / Deleted</span>
                      ) : (
                        <span className="text-amber-400 flex items-center gap-1 capitalize"><AlertCircle className="h-4 w-4" /> {data.target?.status || "Unknown"}</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Subreddit</div>
                    <div className="font-medium truncate" title={data.target?.subreddit || ""}>r/{data.target?.subreddit || "—"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Score</div>
                    <div className="font-medium">{formatNumber(data.target?.score)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Posted At</div>
                    <div className="font-medium">{formatDate(data.target?.createdAt)}</div>
                  </div>
                  
                  {data.target?.title !== undefined && (
                    <div className="col-span-2 mt-2">
                      <div className="text-muted-foreground text-xs mb-1">Title</div>
                      <div className="text-foreground bg-muted/30 p-3 rounded-lg border border-border/50 text-sm">{data.target?.title || "—"}</div>
                    </div>
                  )}

                  {data.target?.body_preview !== undefined && (
                    <div className="col-span-2 mt-2">
                      <div className="text-muted-foreground text-xs mb-1">Preview</div>
                      <div className="text-foreground bg-muted/30 p-3 rounded-lg border border-border/50 text-sm whitespace-pre-wrap">
                        {data.target?.body_preview || "—"}
                      </div>
                    </div>
                  )}

                  {data.target?.removed_by_category && (
                     <div className="col-span-2 mt-1">
                      <div className="text-muted-foreground text-xs mb-1">Removed By</div>
                      <div className="text-red-400 font-medium">{data.target.removed_by_category}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Author Card */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="border-b border-border bg-muted/20 px-5 py-4 flex items-center justify-between">
              <h2 className="font-semibold text-foreground flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                Author Details
              </h2>
              {data.author?.username && (
                <a href={`https://reddit.com/user/${data.author.username}`} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1">
                  View Profile <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <div className="p-5 space-y-4">
              {!data.author ? (
                <div className="text-muted-foreground text-sm flex items-center gap-2">
                  <User className="h-4 w-4" /> No author data available (comment may be deleted)
                </div>
              ) : data.author.error && data.author.status === "error" ? (
                <div className="text-red-400 text-sm">Error: {data.author.error}</div>
              ) : (
                <div className="flex flex-col gap-5">
                  <div className="flex items-center gap-4">
                    {data.author.avatar_url ? (
                      <img src={data.author.avatar_url.split("?")[0]} alt="Avatar" className="h-16 w-16 rounded-full border border-border bg-muted" />
                    ) : (
                      <div className="h-16 w-16 rounded-full border border-border bg-muted flex items-center justify-center">
                        <User className="h-8 w-8 text-muted-foreground" />
                      </div>
                    )}
                    <div>
                      <div className="font-bold text-lg text-foreground">u/{data.author.username}</div>
                      <div className="flex items-center gap-2 mt-1">
                        {data.author.status === "active" ? (
                          <span className="inline-flex items-center rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400 border border-emerald-500/20">Active</span>
                        ) : data.author.status === "shadowbanned" ? (
                          <span className="inline-flex items-center rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-400 border border-amber-500/20">Shadowbanned</span>
                        ) : (
                          <span className="inline-flex items-center rounded bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-400 border border-red-500/20 capitalize">{data.author.status}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm bg-muted/20 p-4 rounded-xl border border-border/50">
                    <div>
                      <div className="text-muted-foreground text-xs mb-1">Total Karma</div>
                      <div className="font-medium text-foreground">{formatNumber(data.author.total_karma)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs mb-1">Account Age</div>
                      <div className="font-medium text-foreground" title={formatDate(data.author.created_utc)}>
                        {formatAgeDays(data.author.created_utc)}
                      </div>
                    </div>
                    <div className="col-span-2">
                      <div className="text-muted-foreground text-xs mb-1">Last Active</div>
                      <div className="font-medium text-foreground flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                        {data.author.last_active_utc ? (
                          <span title={formatDate(data.author.last_active_utc)}>
                            {formatAgeDays(data.author.last_active_utc)} ago
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
    </div>
  );
}
