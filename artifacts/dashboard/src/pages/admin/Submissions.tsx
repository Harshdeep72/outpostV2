import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { get, patch, post } from "@/lib/api";
import { cn, formatCurrency, timeAgo, statusColor } from "@/lib/utils";

type LiveStatus = "live" | "removed" | "deleted" | "unknown";

interface AdminSubmission {
  id: number;
  claimId: number;
  taskId: number;
  userId: number;
  discordId: string;
  discordUsername: string | null;
  proofLink: string;
  reward: string;
  reviewStatus: string;
  reviewReason: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  liveStatus: LiveStatus;
  lastCheckedAt: string | null;
  removalReason: string | null;
  liveStatusChangedAt: string | null;
  reviewerDiscordId: string | null;
  reviewerName: string | null;
  taskTitle?: string | null;
  taskCreatorDiscordId?: string | null;
  taskCreatorName?: string | null;
  reviewerAvatar: string | null;
}

const LIVE_BADGE: Record<LiveStatus, { label: string; cls: string; dot: string }> = {
  live:    { label: "Live",    cls: "border-green-400/30 bg-green-400/10 text-green-300",        dot: "bg-green-400" },
  removed: { label: "Removed", cls: "border-orange-400/30 bg-orange-400/10 text-orange-300",     dot: "bg-orange-400" },
  deleted: { label: "Deleted", cls: "border-red-400/30 bg-red-400/10 text-red-300",              dot: "bg-red-400" },
  unknown: { label: "Pending", cls: "border-border bg-secondary/40 text-muted-foreground",       dot: "bg-muted-foreground/50" },
};

const NA_BADGE = { label: "N/A", cls: "border-border bg-secondary/40 text-muted-foreground/70", dot: "bg-muted-foreground/30" };

function isRedditProofLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it";
  } catch {
    return false;
  }
}

interface SubmissionListResponse {
  submissions: AdminSubmission[];
  total: number;
  page: number;
  limit: number;
}

// Map API status values (bot uses "accepted"; dashboard shows "accepted" or "approved" depending on source)
function normalizeStatus(s: string): string {
  if (s === "accepted") return "accepted";
  if (s === "approved") return "accepted";
  return s;
}

function statusLabel(s: string): string {
  const n = normalizeStatus(s);
  if (n === "accepted") return "Accepted";
  if (n === "rejected") return "Rejected";
  if (n === "pending") return "Pending";
  if (n === "flagged") return "Flagged";
  return s;
}

// Tab labels and their API query values
const STATUS_TABS: { label: string; value: string }[] = [
  { label: "All", value: "all" },
  { label: "Pending", value: "pending" },
  { label: "Accepted", value: "accepted" },
  { label: "Rejected", value: "rejected" },
];

export default function Submissions() {
  const [page, setPage] = useState(1);
  const [statusTab, setStatusTab] = useState("all");
  const [selected, setSelected] = useState<AdminSubmission | null>(null);
  const [reason, setReason] = useState("");
  const [scanStatus, setScanStatus] = useState<{ running: boolean; total?: number; toast?: string } | null>(null);
  const qc = useQueryClient();
  const limit = 20;

  // Poll scan status while a bulk scan is in progress
  useEffect(() => {
    if (!scanStatus?.running) return;
    const id = setInterval(async () => {
      try {
        const s = await get<{ running: boolean }>("/admin/liveness/bulk-scan-status");
        if (!s.running) {
          setScanStatus(prev => ({ running: false, total: prev?.total, toast: "Scan complete — table updating…" }));
          qc.invalidateQueries({ queryKey: ["admin-submissions"] });
          setTimeout(() => setScanStatus(null), 4000);
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(id);
  }, [scanStatus?.running, qc]);

  const bulkScan = useMutation({
    mutationFn: () => post<{ ok: boolean; total: number }>("/admin/liveness/bulk-scan-all", {}),
    onSuccess: (data) => {
      setScanStatus({ running: true, total: data.total });
    },
    onError: () => {
      setScanStatus({ running: false, toast: "Could not start scan — try again." });
      setTimeout(() => setScanStatus(null), 4000);
    },
  });

  const { data, isLoading, isFetching, dataUpdatedAt } = useQuery<SubmissionListResponse>({
    queryKey: ["admin-submissions", page, statusTab],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (statusTab !== "all") {
        if (statusTab === "approved") params.set("status", "accepted");
        else if (statusTab === "pending") params.set("status", "pending,pending_hold");
        else params.set("status", statusTab);
      }
      return get<SubmissionListResponse>(`/admin/submissions?${params}`);
    },
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const mutation = useMutation({
    mutationFn: (vars: { id: number; reviewStatus: string; reviewReason?: string }) =>
      patch<AdminSubmission>(`/admin/submissions/${vars.id}`, {
        reviewStatus: vars.reviewStatus === "approved" ? "accepted" : vars.reviewStatus,
        reviewReason: vars.reviewReason,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-submissions"] });
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
      setSelected(null);
      setReason("");
    },
  });

  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Submissions</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{data?.total ?? "..."} total</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Bulk liveness scan */}
          <button
            onClick={() => bulkScan.mutate()}
            disabled={bulkScan.isPending || scanStatus?.running}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors",
              scanStatus?.running
                ? "border-yellow-500/30 bg-yellow-500/10 text-yellow-300 cursor-not-allowed"
                : "border-border bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary"
            )}
            title="Check every accepted 'Live' submission on Reddit — regardless of age"
          >
            {scanStatus?.running ? (
              <>
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                Scanning{scanStatus.total ? ` ${scanStatus.total}` : ""}…
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                Scan All Live
              </>
            )}
          </button>

          <div className="flex items-center gap-2 text-xs text-muted-foreground" title="Auto-refreshes every 15s. Live status comes from the Reddit checker.">
            <span className={cn("inline-block w-1.5 h-1.5 rounded-full", isFetching ? "bg-green-400 animate-pulse" : "bg-green-400/40")} />
            Live · refreshed {dataUpdatedAt ? timeAgo(new Date(dataUpdatedAt).toISOString()) : "—"}
          </div>
        </div>
      </div>

      {/* Scan toast */}
      {scanStatus?.toast && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-green-500/30 bg-green-500/10 text-green-300 text-xs font-medium w-fit">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          {scanStatus.toast}
        </div>
      )}

      <div className="flex gap-1 p-1 bg-secondary/50 rounded-lg w-fit">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => { setStatusTab(tab.value); setPage(1); }}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              statusTab === tab.value
                ? "bg-card text-foreground shadow-sm border border-border"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {["User", "Task ID", "Created by", "Reward", "Proof", "Live", "Status", "Reviewer", "Submitted", ""].map((h, i) => (
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
                    {Array.from({ length: 10 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-secondary rounded w-20" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data?.submissions.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No submissions found
                  </td>
                </tr>
              ) : (
                data?.submissions.map(s => {
                  const ns = normalizeStatus(s.reviewStatus);
                  return (
                    <tr
                      key={s.id}
                      className="border-b border-border/50 hover:bg-secondary/30 transition-colors cursor-pointer"
                      onClick={() => { setSelected(s); setReason(s.reviewReason ?? ""); }}
                    >
                      <td className="px-4 py-3 font-medium text-foreground">
                        {s.discordUsername ?? s.discordId}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">#{s.taskId}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-[140px]" title={s.taskCreatorName ?? s.taskCreatorDiscordId ?? ""}>
                        {s.taskCreatorName ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-foreground">{formatCurrency(s.reward)}</td>
                      <td className="px-4 py-3">
                        <a
                          href={s.proofLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-primary hover:underline text-xs"
                        >
                          View proof
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        {(() => {
                          const isReddit = isRedditProofLink(s.proofLink);
                          const badge = isReddit ? LIVE_BADGE[s.liveStatus] : NA_BADGE;
                          const title = !isReddit
                            ? "Live status checks only run for Reddit submissions."
                            : s.liveStatus === "removed" || s.liveStatus === "deleted"
                              ? `${badge.label}${s.removalReason ? ` — ${s.removalReason}` : ""}${s.liveStatusChangedAt ? ` (${timeAgo(s.liveStatusChangedAt)})` : ""}`
                              : s.lastCheckedAt ? `Last checked ${timeAgo(s.lastCheckedAt)}` : "Not checked yet";
                          return (
                            <span
                              className={cn("inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border", badge.cls)}
                              title={title}
                            >
                              <span className={cn("inline-block w-1.5 h-1.5 rounded-full", badge.dot)} />
                              {badge.label}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium border capitalize", statusColor(ns))}>
                          {statusLabel(s.reviewStatus)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {s.reviewerName ? (
                          <div className="flex items-center gap-2 min-w-0">
                            {s.reviewerAvatar ? (
                              <img src={s.reviewerAvatar} alt="" className="w-5 h-5 rounded-full object-cover shrink-0" />
                            ) : (
                              <div className="w-5 h-5 rounded-full bg-secondary border border-border shrink-0" />
                            )}
                            <span className="text-xs text-foreground truncate" title={s.reviewerName}>{s.reviewerName}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{timeAgo(s.submittedAt)}</td>
                      <td className="px-4 py-3">
                        {ns === "pending" && (
                          <button
                            onClick={e => { e.stopPropagation(); setSelected(s); setReason(""); }}
                            className="text-xs text-primary hover:underline"
                          >
                            Review
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 text-foreground transition-colors">Prev</button>
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 text-foreground transition-colors">Next</button>
          </div>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="w-full max-w-md rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="font-semibold text-foreground">Review Submission #{selected.id}</h2>
              <button onClick={() => { setSelected(null); setReason(""); }} className="text-muted-foreground hover:text-foreground">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                {[
                  ["User", selected.discordUsername ?? selected.discordId],
                  ["Task ID", `#${selected.taskId}`],
                  ["Reward", formatCurrency(selected.reward)],
                  ["Status", statusLabel(selected.reviewStatus)],
                  ["Submitted", timeAgo(selected.submittedAt)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-secondary/50 p-3">
                    <p className="text-xs text-muted-foreground mb-0.5">{label}</p>
                    <p className="font-medium text-foreground text-xs">{value}</p>
                  </div>
                ))}
                <div className="rounded-lg bg-secondary/50 p-3">
                  <p className="text-xs text-muted-foreground mb-0.5">Proof Link</p>
                  <a href={selected.proofLink} target="_blank" rel="noopener noreferrer" className="font-medium text-primary text-xs hover:underline">
                    Open link
                  </a>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">Review Reason (optional)</label>
                <input
                  type="text"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. wrong subreddit, duplicate post..."
                  className="w-full px-3 py-2 rounded-lg bg-background border border-input text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div className="flex gap-3">
                <button
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ id: selected.id, reviewStatus: "accepted", reviewReason: reason || undefined })}
                  className="flex-1 py-2 rounded-lg bg-green-600/20 border border-green-600/30 text-green-400 text-sm font-medium hover:bg-green-600/30 transition-colors disabled:opacity-60"
                >
                  Accept
                </button>
                <button
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ id: selected.id, reviewStatus: "rejected", reviewReason: reason || "Rejected by admin" })}
                  className="flex-1 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm font-medium hover:bg-destructive/20 transition-colors disabled:opacity-60"
                >
                  Reject
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
