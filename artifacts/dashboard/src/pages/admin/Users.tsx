import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { del, get, patch, post } from "@/lib/api";
import { cn, formatCurrency, timeAgo, statusColor } from "@/lib/utils";

interface BotUser {
  id: number;
  discordId: string;
  discordUsername: string;
  redditUsername: string | null;
  verified: boolean;
  trustScore: number;
  balanceAvailable: string;
  balancePending: string;
  totalEarned: string;
  referralEarnings: string;
  referralCode: string | null;
  isMod: boolean;
  isAdmin: boolean;
  flagged: boolean;
  createdAt: string;
}

interface UserListResponse {
  users: BotUser[];
  total: number;
  page: number;
  limit: number;
}

export default function Users() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [selected, setSelectedRaw] = useState<BotUser | null>(null);
  const qc = useQueryClient();

  const limit = 20;
  const { data, isLoading } = useQuery<UserListResponse>({
    queryKey: ["admin-users", page, search, flaggedOnly, verifiedOnly],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search) params.set("search", search);
      if (flaggedOnly) params.set("flagged", "true");
      if (verifiedOnly) params.set("verified", "true");
      return get<UserListResponse>(`/admin/users?${params}`);
    },
  });

  const [balanceAmount, setBalanceAmount] = useState("");
  const [balanceReason, setBalanceReason] = useState("");
  const [balanceMsg, setBalanceMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [verifyReddit, setVerifyReddit] = useState("");
  const [verifyMsg, setVerifyMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Linked-accounts panel state. Lives alongside verification so admins
  // can swap a worker's Reddit account in a single place.
  const [addReddit, setAddReddit] = useState("");
  const [accountsMsg, setAccountsMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  function setSelected(u: BotUser | null) {
    setSelectedRaw((prev) => {
      if (prev?.id !== u?.id) {
        setBalanceAmount("");
        setBalanceReason("");
        setBalanceMsg(null);
        setVerifyReddit("");
        setVerifyMsg(null);
        setAddReddit("");
        setAccountsMsg(null);
      }
      return u;
    });
  }

  const mutation = useMutation({
    mutationFn: (vars: { id: number; flagged?: boolean; isMod?: boolean; trustScore?: number }) =>
      patch<BotUser>(`/admin/users/${vars.id}`, {
        flagged: vars.flagged,
        isMod: vars.isMod,
        trustScore: vars.trustScore,
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setSelectedRaw(updated);
    },
  });

  const balanceMutation = useMutation({
    mutationFn: (vars: { id: number; delta: number; reason: string }) =>
      post<BotUser & {
        _adjustment?: {
          requestedDelta: number;
          appliedDelta: number;
          previousBalance: string;
          newBalance: string;
          clamped: boolean;
        };
      }>(`/admin/users/${vars.id}/adjust-balance`, {
        delta: vars.delta,
        reason: vars.reason,
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      const { _adjustment, ...userOnly } = updated;
      setSelectedRaw(userOnly as BotUser);
      setBalanceAmount("");
      setBalanceReason("");
      const adj = _adjustment;
      if (adj) {
        const verb = adj.appliedDelta >= 0 ? "Added" : "Removed";
        const note = adj.clamped
          ? ` (requested ${formatCurrency(Math.abs(adj.requestedDelta))} but only ${formatCurrency(adj.previousBalance)} available; clamped to 0)`
          : "";
        setBalanceMsg({
          kind: "ok",
          text: `${verb} ${formatCurrency(Math.abs(adj.appliedDelta))}. New balance: ${formatCurrency(adj.newBalance)}.${note}`,
        });
      } else {
        setBalanceMsg({ kind: "ok", text: `New balance: ${formatCurrency(updated.balanceAvailable)}.` });
      }
    },
    onError: (err: any) => {
      setBalanceMsg({ kind: "err", text: err?.message ?? "Failed to adjust balance" });
    },
  });

  const verifyMutation = useMutation({
    mutationFn: (vars: { id: number; reddit_username: string }) =>
      post<{ user: BotUser; discordRoleAdded: boolean; warning: string | null }>(
        `/admin/users/${vars.id}/verify`,
        { reddit_username: vars.reddit_username }
      ),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setSelectedRaw(result.user);
      setVerifyReddit("");
      const warn = result.warning ? ` Note: ${result.warning}` : "";
      const role = result.discordRoleAdded ? " Discord role added." : "";
      setVerifyMsg({ kind: "ok", text: `User verified.${role}${warn}` });
    },
    onError: (err: any) => {
      setVerifyMsg({ kind: "err", text: err?.message ?? "Failed to verify user" });
    },
  });

  // ── Linked Reddit accounts ────────────────────────────────────────────
  // Source of truth is GET /admin/users/:id/reddit-accounts, which already
  // returns `{ accounts: [{ reddit_username, last_used_at, verified_at }] }`.
  // We refetch this list (and the user list, since unlinking the last
  // account flips `verified` to false on the server) after every mutation.
  const accountsQuery = useQuery<{ accounts: Array<{ reddit_username: string; last_used_at: string | null; verified_at: string | null }> }>({
    queryKey: ["admin-user-reddit-accounts", selected?.id],
    queryFn: () => get(`/admin/users/${selected!.id}/reddit-accounts`),
    enabled: !!selected,
  });

  const addAccountMutation = useMutation({
    mutationFn: (vars: { id: number; reddit_username: string }) =>
      post<{ ok: true; redditUsername: string }>(
        `/admin/users/${vars.id}/reddit-accounts`,
        { reddit_username: vars.reddit_username }
      ),
    onSuccess: (result) => {
      setAddReddit("");
      setAccountsMsg({ kind: "ok", text: `Linked u/${result.redditUsername}.` });
      qc.invalidateQueries({ queryKey: ["admin-user-reddit-accounts", selected?.id] });
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      // Linking the first account auto-promotes it to primary on the
      // server, so refresh the modal's BotUser copy too (matches the
      // unlink flow) to keep the primary/verified badges in sync.
      if (selected) {
        get<{ users: BotUser[] }>(`/admin/users?search=${encodeURIComponent(selected.discordId)}&limit=1`)
          .then(r => { const u = r.users.find(x => x.id === selected.id); if (u) setSelectedRaw(u); })
          .catch(() => {});
      }
    },
    onError: (err: any) => {
      setAccountsMsg({ kind: "err", text: err?.message ?? "Failed to link account" });
    },
  });

  const unlinkAccountMutation = useMutation({
    mutationFn: (vars: { discordId: string; redditUsername: string }) =>
      del<{ ok: true; remainingAccounts: number }>(
        `/admin/reddit-accounts/${encodeURIComponent(vars.discordId)}/${encodeURIComponent(vars.redditUsername)}`
      ),
    onSuccess: (result, vars) => {
      const tail = result.remainingAccounts === 0
        ? " No accounts remain — user has been unverified."
        : ` ${result.remainingAccounts} account${result.remainingAccounts === 1 ? "" : "s"} remaining.`;
      setAccountsMsg({ kind: "ok", text: `Unlinked u/${vars.redditUsername}.${tail}` });
      qc.invalidateQueries({ queryKey: ["admin-user-reddit-accounts", selected?.id] });
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      // Refresh the modal's BotUser copy so the primary/verified badges update
      // without forcing the admin to close and reopen the panel.
      if (selected) {
        get<{ users: BotUser[] }>(`/admin/users?search=${encodeURIComponent(selected.discordId)}&limit=1`)
          .then(r => { const u = r.users.find(x => x.id === selected.id); if (u) setSelectedRaw(u); })
          .catch(() => {});
      }
    },
    onError: (err: any) => {
      setAccountsMsg({ kind: "err", text: err?.message ?? "Failed to unlink account" });
    },
  });

  const unverifyMutation = useMutation({
    mutationFn: (id: number) =>
      post<{ user: BotUser; discordRoleRemoved: boolean; warning: string | null }>(
        `/admin/users/${id}/unverify`,
        {}
      ),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setSelectedRaw(result.user);
      const warn = result.warning ? ` Note: ${result.warning}` : "";
      setVerifyMsg({ kind: "ok", text: `User unverified.${warn}` });
    },
    onError: (err: any) => {
      setVerifyMsg({ kind: "err", text: err?.message ?? "Failed to unverify user" });
    },
  });

  function adjustBalance(sign: 1 | -1) {
    if (!selected) return;
    const amount = parseFloat(balanceAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setBalanceMsg({ kind: "err", text: "Enter a valid amount greater than 0." });
      return;
    }
    setBalanceMsg(null);
    balanceMutation.mutate({
      id: selected.id,
      delta: sign * amount,
      reason: balanceReason.trim() || "No reason provided",
    });
  }

  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Users</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{data?.total ?? "..."} total users</p>
        </div>
        <div className="sm:ml-auto flex items-center gap-2 flex-wrap">
          <input
            type="search"
            placeholder="Search Discord or Reddit username..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring w-64"
          />
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={e => { setVerifiedOnly(e.target.checked); setPage(1); }}
              className="w-3.5 h-3.5 accent-primary"
            />
            Verified only
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={flaggedOnly}
              onChange={e => { setFlaggedOnly(e.target.checked); setPage(1); }}
              className="w-3.5 h-3.5 accent-primary"
            />
            Flagged only
          </label>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {["Discord", "Reddit", "Trust", "Balance", "Earned", "Status", "Joined", ""].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => (
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
                    No users found
                  </td>
                </tr>
              ) : (
                data?.users.map(u => (
                  <tr
                    key={u.id}
                    className={cn(
                      "border-b border-border/50 hover:bg-secondary/30 transition-colors cursor-pointer",
                      u.flagged && "bg-destructive/5"
                    )}
                    onClick={() => setSelected(u)}
                  >
                    <td className="px-4 py-3 font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        {u.flagged && <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" />}
                        <span className="truncate max-w-[120px]">{u.discordUsername}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{u.redditUsername ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        "text-xs font-medium",
                        u.trustScore >= 80 ? "text-green-400" : u.trustScore >= 50 ? "text-yellow-400" : "text-destructive"
                      )}>
                        {u.trustScore}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-foreground">{formatCurrency(u.balanceAvailable)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatCurrency(u.totalEarned)}</td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        "px-2 py-0.5 rounded-full text-xs font-medium border",
                        u.verified ? "text-green-400 bg-green-400/10 border-green-400/20" : "text-muted-foreground bg-secondary border-border"
                      )}>
                        {u.verified ? "Verified" : "Unverified"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{timeAgo(u.createdAt)}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={e => { e.stopPropagation(); setSelected(u); }}
                        className="text-xs text-primary hover:underline"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
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

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 overflow-y-auto">
          <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl my-auto">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border gap-3">
              <h2 className="font-semibold text-foreground truncate">{selected.discordUsername}</h2>
              <div className="flex items-center gap-3 shrink-0">
                <Link
                  href={`/admin/workers/${selected.id}`}
                  className="text-[12px] text-emerald-400 hover:text-emerald-300 whitespace-nowrap"
                >Open full profile →</Link>
              <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              </div>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                {[
                  ["Discord ID", selected.discordId],
                  ["Reddit", selected.redditUsername ?? "—"],
                  ["Trust Score", String(selected.trustScore)],
                  ["Balance", formatCurrency(selected.balanceAvailable)],
                  ["Pending", formatCurrency(selected.balancePending)],
                  ["Lifetime Earnings", formatCurrency(selected.totalEarned)],
                  ["Referral Earnings", formatCurrency(selected.referralEarnings)],
                  ["Referral Code", selected.referralCode ?? "—"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-secondary/50 p-3">
                    <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
                    <p className="font-medium text-foreground text-xs truncate">{value}</p>
                  </div>
                ))}
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-muted-foreground">Flagged</span>
                  <button
                    onClick={() => mutation.mutate({ id: selected.id, flagged: !selected.flagged })}
                    disabled={mutation.isPending}
                    className={cn(
                      "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
                      selected.flagged
                        ? "bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20"
                        : "bg-secondary text-muted-foreground border-border hover:bg-secondary/80"
                    )}
                  >
                    {selected.flagged ? "Unflag" : "Flag"}
                  </button>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-border/50">
                  <span className="text-muted-foreground">Moderator</span>
                  <button
                    onClick={() => mutation.mutate({ id: selected.id, isMod: !selected.isMod })}
                    disabled={mutation.isPending}
                    className={cn(
                      "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
                      selected.isMod
                        ? "bg-primary/10 text-primary border-primary/20 hover:bg-primary/20"
                        : "bg-secondary text-muted-foreground border-border hover:bg-secondary/80"
                    )}
                  >
                    {selected.isMod ? "Remove Mod" : "Make Mod"}
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-foreground">Linked Reddit Accounts</p>
                  <span className="text-[11px] text-muted-foreground">
                    {accountsQuery.data?.accounts.length ?? 0} linked
                  </span>
                </div>

                {accountsQuery.isLoading ? (
                  <div className="space-y-1.5">
                    {Array.from({ length: 2 }).map((_, i) => (
                      <div key={i} className="h-9 rounded-md bg-secondary animate-pulse" />
                    ))}
                  </div>
                ) : (accountsQuery.data?.accounts ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No Reddit accounts linked yet.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {accountsQuery.data!.accounts.map(acc => {
                      const isPrimary = selected.redditUsername === acc.reddit_username;
                      const busy = unlinkAccountMutation.isPending
                        && unlinkAccountMutation.variables?.redditUsername === acc.reddit_username;
                      return (
                        <li
                          key={acc.reddit_username}
                          className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-card border border-border"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <a
                              href={`https://www.reddit.com/user/${acc.reddit_username}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs font-medium text-foreground truncate hover:text-primary hover:underline"
                              title={`Open u/${acc.reddit_username} on Reddit`}
                            >
                              u/{acc.reddit_username}
                            </a>
                            {isPrimary && (
                              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-primary/10 text-primary border border-primary/20 shrink-0">
                                primary
                              </span>
                            )}
                            {acc.last_used_at && (
                              <span className="text-[10px] text-muted-foreground truncate">· used {timeAgo(acc.last_used_at)}</span>
                            )}
                          </div>
                          <button
                            onClick={() => {
                              if (!window.confirm(`Unlink u/${acc.reddit_username} from ${selected.discordUsername}?`)) return;
                              setAccountsMsg(null);
                              unlinkAccountMutation.mutate({ discordId: selected.discordId, redditUsername: acc.reddit_username });
                            }}
                            disabled={busy}
                            title="Unlink this Reddit account"
                            aria-label={`Unlink u/${acc.reddit_username}`}
                            className="w-6 h-6 flex items-center justify-center rounded-md text-destructive hover:bg-destructive/10 border border-transparent hover:border-destructive/20 disabled:opacity-40 transition-colors shrink-0"
                          >
                            {busy ? (
                              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                                <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                              </svg>
                            ) : (
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="flex gap-1.5">
                  <input
                    type="text"
                    placeholder="u/username — link another"
                    value={addReddit}
                    onChange={e => setAddReddit(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter" && addReddit.trim() && !addAccountMutation.isPending) {
                        setAccountsMsg(null);
                        addAccountMutation.mutate({ id: selected.id, reddit_username: addReddit.trim() });
                      }
                    }}
                    className="flex-1 px-2.5 py-1.5 rounded-md bg-card border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <button
                    onClick={() => {
                      if (!addReddit.trim()) return;
                      setAccountsMsg(null);
                      addAccountMutation.mutate({ id: selected.id, reddit_username: addReddit.trim() });
                    }}
                    disabled={addAccountMutation.isPending || !addReddit.trim()}
                    title="Link this Reddit account"
                    aria-label="Link Reddit account"
                    className="w-8 h-8 flex items-center justify-center rounded-md bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 disabled:opacity-40 transition-colors shrink-0"
                  >
                    {addAccountMutation.isPending ? (
                      <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                        <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 4v16m8-8H4" />
                      </svg>
                    )}
                  </button>
                </div>

                {accountsMsg && (
                  <p className={cn("text-xs", accountsMsg.kind === "ok" ? "text-green-400" : "text-destructive")}>
                    {accountsMsg.text}
                  </p>
                )}

                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Removing the primary auto-promotes the next-oldest linked account. Unlinking the last account marks the user as unverified.
                </p>
              </div>

              <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-foreground">Verification</p>
                  <span className={cn(
                    "px-2 py-0.5 rounded-full text-xs font-medium border",
                    selected.verified
                      ? "text-green-400 bg-green-400/10 border-green-400/20"
                      : "text-muted-foreground bg-secondary border-border"
                  )}>
                    {selected.verified ? "Verified" : "Unverified"}
                  </span>
                </div>

                {!selected.verified ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      placeholder={selected.redditUsername ? `Reddit: ${selected.redditUsername} (or enter new)` : "Reddit username (e.g. myuser)"}
                      value={verifyReddit}
                      onChange={e => setVerifyReddit(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <button
                      onClick={() => {
                        setVerifyMsg(null);
                        verifyMutation.mutate({ id: selected.id, reddit_username: verifyReddit.trim() });
                      }}
                      disabled={verifyMutation.isPending || (!verifyReddit.trim() && !selected.redditUsername)}
                      className="w-full px-3 py-2 rounded-lg bg-green-500/10 text-green-400 border border-green-500/20 text-sm font-medium hover:bg-green-500/20 disabled:opacity-40 transition-colors"
                    >
                      {verifyMutation.isPending ? "Verifying..." : "Verify User"}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setVerifyMsg(null); unverifyMutation.mutate(selected.id); }}
                    disabled={unverifyMutation.isPending}
                    className="w-full px-3 py-2 rounded-lg bg-destructive/10 text-destructive border border-destructive/20 text-sm font-medium hover:bg-destructive/20 disabled:opacity-40 transition-colors"
                  >
                    {unverifyMutation.isPending ? "Removing..." : "Remove Verification"}
                  </button>
                )}

                {verifyMsg && (
                  <p className={cn("text-xs", verifyMsg.kind === "ok" ? "text-green-400" : "text-destructive")}>
                    {verifyMsg.text}
                  </p>
                )}
              </div>

              <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3">
                <div className="flex items-baseline justify-between">
                  <p className="text-sm font-semibold text-foreground">Adjust Balance</p>
                  <p className="text-xs text-muted-foreground">Current: <span className="text-foreground font-medium">{formatCurrency(selected.balanceAvailable)}</span></p>
                </div>
                <div className="flex gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    placeholder="Amount"
                    value={balanceAmount}
                    onChange={e => setBalanceAmount(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <input
                  type="text"
                  placeholder="Reason (optional)"
                  value={balanceReason}
                  onChange={e => setBalanceReason(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => adjustBalance(1)}
                    disabled={balanceMutation.isPending}
                    className="flex-1 px-3 py-2 rounded-lg bg-green-500/10 text-green-400 border border-green-500/20 text-sm font-medium hover:bg-green-500/20 disabled:opacity-40 transition-colors"
                  >
                    + Add
                  </button>
                  <button
                    onClick={() => adjustBalance(-1)}
                    disabled={balanceMutation.isPending}
                    className="flex-1 px-3 py-2 rounded-lg bg-destructive/10 text-destructive border border-destructive/20 text-sm font-medium hover:bg-destructive/20 disabled:opacity-40 transition-colors"
                  >
                    − Remove
                  </button>
                </div>
                {balanceMsg && (
                  <p className={cn(
                    "text-xs",
                    balanceMsg.kind === "ok" ? "text-green-400" : "text-destructive"
                  )}>
                    {balanceMsg.text}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
