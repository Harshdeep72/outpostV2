import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { cn, formatCurrency, timeAgo } from "@/lib/utils";

interface RedditAccount {
  redditUsername: string;
  lastUsedAt: string | null;
  verifiedAt: string | null;
  postKarma?: number | null;
  commentKarma?: number | null;
}

// API returns { accounts: [...] } with snake_case keys (reddit_username,
// last_used_at, verified_at) from the raw UNION query in admin.ts.
// Older code here typed the response as `RedditAccount[]` directly, which
// meant the component received the whole envelope object, .length was
// undefined, and EVERY expanded user (even ones with linked accounts in
// the DB) rendered "No additional accounts linked." Fix: unwrap .accounts
// and map snake_case → camelCase so the existing render logic works.
interface RedditAccountsResponse {
  accounts: Array<{
    reddit_username: string;
    last_used_at: string | null;
    verified_at: string | null;
  }>;
}

interface BotUser {
  id: number;
  discordId: string;
  discordUsername: string;
  redditUsername: string | null;
  redditAccountAgeDays: number | null;
  redditPostKarma: number | null;
  redditCommentKarma: number | null;
  verified: boolean;
  trustScore: number;
  balanceAvailable: string;
  balancePending: string;
  totalEarned: string;
  flagged: boolean;
  createdAt: string;
  linkedAccounts?: RedditAccount[];
}

interface UserListResponse {
  users: BotUser[];
  total: number;
  page: number;
  limit: number;
}

export default function VerifiedUsers() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  const qc = useQueryClient();

  const limit = 20;
  const { data, isLoading } = useQuery<UserListResponse>({
    queryKey: ["admin-verified-users", page, search],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        verified: "true",
      });
      if (search) params.set("search", search);
      return get<UserListResponse>(`/admin/users?${params}`);
    },
  });

  const linkedAccountsQuery = useQuery<RedditAccount[]>({
    queryKey: ["admin-linked-accounts", expandedId],
    queryFn: async () => {
      const resp = await get<RedditAccountsResponse>(
        `/admin/users/${expandedId}/reddit-accounts`,
      );
      // Defensive: server already returns { accounts: [...] } including
      // the primary username (UNION fix in admin.ts), but if the shape
      // ever drifts we coerce to [] instead of crashing.
      const rows = Array.isArray(resp?.accounts) ? resp.accounts : [];
      return rows.map((r) => ({
        redditUsername: r.reddit_username,
        lastUsedAt: r.last_used_at,
        verifiedAt: r.verified_at,
        postKarma: null,
        commentKarma: null,
      }));
    },
    enabled: expandedId !== null,
  });

  const unverify = useMutation({
    mutationFn: (id: number) =>
      post<{ discordRoleRemoved: boolean; warning: string | null }>(
        `/admin/users/${id}/unverify`,
        {}
      ),
    onSuccess: (data, id) => {
      qc.invalidateQueries({ queryKey: ["admin-verified-users"] });
      setConfirmingId(null);
      if (data.warning) {
        setNotice({ kind: "warn", text: `User #${id} unverified. ${data.warning}` });
      } else {
        setNotice({ kind: "ok", text: `User #${id} unverified and Discord role removed.` });
      }
    },
    onError: (err: any) => {
      setConfirmingId(null);
      setNotice({ kind: "err", text: err?.message ?? "Failed to unverify user." });
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            Verified Users
            <span className="text-xs font-medium text-green-400 bg-green-400/10 border border-green-400/20 px-2 py-0.5 rounded-full">
              /verify
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data ? `${data.total} users verified via /verify` : "Loading..."}
          </p>
        </div>
        <div className="sm:ml-auto flex items-center gap-2">
          <input
            type="search"
            placeholder="Search by Reddit or Discord username..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring w-72"
          />
        </div>
      </div>

      {notice && (
        <div
          className={cn(
            "flex items-start justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm",
            notice.kind === "ok" && "border-green-400/30 bg-green-400/5 text-green-200",
            notice.kind === "warn" && "border-yellow-400/30 bg-yellow-400/5 text-yellow-200",
            notice.kind === "err" && "border-destructive/40 bg-destructive/10 text-destructive"
          )}
        >
          <span>{notice.text}</span>
          <button
            onClick={() => setNotice(null)}
            className="text-xs opacity-70 hover:opacity-100"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {["Reddit Accounts", "Discord", "Account Age", "Karma (post / comment)", "Trust", "Earned", "Joined", ""].map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/50 animate-pulse">
                    {Array.from({ length: 8 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-secondary rounded w-20" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data?.users.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {search ? `No verified users matching "${search}"` : "No verified users yet"}
                  </td>
                </tr>
              ) : (
                data?.users.map(u => (
                  <>
                    <tr
                      key={u.id}
                      className={cn(
                        "border-b border-border/50 hover:bg-secondary/30 transition-colors cursor-pointer",
                        u.flagged && "bg-destructive/5",
                        expandedId === u.id && "bg-secondary/20"
                      )}
                      onClick={() => setExpandedId(expandedId === u.id ? null : u.id)}
                    >
                      <td className="px-4 py-3 font-medium">
                        <div className="flex items-center gap-1.5">
                          {u.redditUsername ? (
                            <a
                              href={`https://reddit.com/u/${u.redditUsername}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline flex items-center gap-1"
                              onClick={e => e.stopPropagation()}
                            >
                              <span className="text-muted-foreground">u/</span>
                              {u.redditUsername}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          <span className="text-xs text-muted-foreground ml-1" title="Click to see all linked Reddit accounts">
                            {expandedId === u.id ? "▲" : "▼"}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        <div className="flex items-center gap-2">
                          {u.flagged && <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" title="Flagged" />}
                          <span className="truncate max-w-[140px]">{u.discordUsername}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {u.redditAccountAgeDays != null ? `${u.redditAccountAgeDays}d` : "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {u.redditPostKarma != null && u.redditCommentKarma != null
                          ? `${u.redditPostKarma.toLocaleString()} / ${u.redditCommentKarma.toLocaleString()}`
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          "text-xs font-medium",
                          u.trustScore >= 80 ? "text-green-400" : u.trustScore >= 50 ? "text-yellow-400" : "text-destructive"
                        )}>
                          {u.trustScore}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatCurrency(u.totalEarned)}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{timeAgo(u.createdAt)}</td>
                      <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                        {confirmingId === u.id ? (
                          <div className="inline-flex items-center gap-2">
                            <button
                              onClick={() => unverify.mutate(u.id)}
                              disabled={unverify.isPending}
                              className="px-2.5 py-1 rounded-md bg-destructive text-destructive-foreground text-xs font-medium hover:bg-destructive/90 disabled:opacity-50"
                            >
                              {unverify.isPending ? "Unverifying..." : "Confirm"}
                            </button>
                            <button
                              onClick={() => setConfirmingId(null)}
                              disabled={unverify.isPending}
                              className="px-2.5 py-1 rounded-md bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => { setNotice(null); setConfirmingId(u.id); }}
                            className="px-2.5 py-1 rounded-md bg-secondary text-foreground text-xs font-medium hover:bg-secondary/80"
                            title="Remove verified status and Discord role"
                          >
                            Unverify
                          </button>
                        )}
                      </td>
                    </tr>

                    {expandedId === u.id && (
                      <tr key={`${u.id}-expanded`} className="border-b border-border/50 bg-secondary/10">
                        <td colSpan={8} className="px-6 py-3">
                          <div className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">
                            All linked Reddit accounts
                          </div>
                          {linkedAccountsQuery.isLoading ? (
                            <div className="text-xs text-muted-foreground">Loading…</div>
                          ) : linkedAccountsQuery.data && linkedAccountsQuery.data.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {linkedAccountsQuery.data.map((acct, idx) => (
                                <a
                                  key={acct.redditUsername}
                                  href={`https://reddit.com/u/${acct.redditUsername}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-border bg-card text-xs text-primary hover:underline"
                                >
                                  <span className="text-muted-foreground">u/</span>
                                  {acct.redditUsername}
                                  {idx === 0 && (
                                    <span className="text-muted-foreground text-[10px]">(primary)</span>
                                  )}
                                  {acct.postKarma != null && (
                                    <span className="text-muted-foreground ml-1">
                                      · {((acct.postKarma ?? 0) + (acct.commentKarma ?? 0)).toLocaleString()} karma
                                    </span>
                                  )}
                                </a>
                              ))}
                              {[...Array(Math.max(0, 3 - (linkedAccountsQuery.data?.length ?? 0)))].map((_, i) => (
                                <span
                                  key={`empty-${i}`}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-dashed border-border text-xs text-muted-foreground/40"
                                >
                                  Empty slot {(linkedAccountsQuery.data?.length ?? 0) + i + 1}/3
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground">
                              No additional accounts linked.
                              {[...Array(3)].map((_, i) => (
                                <span key={i} className="inline-flex items-center gap-1 ml-2 px-2.5 py-1 rounded-full border border-dashed border-border text-xs text-muted-foreground/40">
                                  Empty slot {i + 1}/3
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed text-foreground transition-colors"
            >
              Prev
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed text-foreground transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
