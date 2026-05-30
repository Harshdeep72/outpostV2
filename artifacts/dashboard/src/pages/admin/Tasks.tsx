import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { get, post, downloadFile } from "@/lib/api";
import { cn, formatCurrency, timeAgo, statusColor } from "@/lib/utils";

interface AdminTask {
  id: number;
  title: string;
  type: string;
  reward: string;
  maxSlots: number;
  slotsFilled: number;
  status: string;
  createdAt: string;
}

interface TaskListResponse {
  tasks: AdminTask[];
  total: number;
  page: number;
  limit: number;
}

const STATUS_TABS = ["all", "open", "closed"];

export default function Tasks() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelMsg, setCancelMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const limit = 20;
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<TaskListResponse>({
    queryKey: ["admin-tasks", page, status],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (status !== "all") params.set("status", status);
      return get<TaskListResponse>(`/admin/tasks?${params}`);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (vars: { id: number; reason: string }) =>
      post<{ ok: boolean; claimsReleased: number }>(`/admin/tasks/${vars.id}/cancel`, { reason: vars.reason }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["admin-tasks"] });
      setCancelMsg({ kind: "ok", text: `Task cancelled. ${result.claimsReleased} claim(s) released.` });
      setCancellingId(null);
      setConfirmId(null);
      setCancelReason("");
    },
    onError: (err: any) => {
      setCancelMsg({ kind: "err", text: err?.message ?? "Failed to cancel task" });
    },
  });

  function openCancel(id: number) {
    setCancelMsg(null);
    setCancelReason("");
    setConfirmId(id);
  }

  function doCancel() {
    if (!confirmId) return;
    setCancellingId(confirmId);
    cancelMutation.mutate({ id: confirmId, reason: cancelReason.trim() || "Cancelled via dashboard" });
  }

  const totalPages = data ? Math.ceil(data.total / limit) : 1;

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-xl font-bold text-foreground">Tasks</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{data?.total ?? "..."} total tasks</p>
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

      <div className="flex gap-1 p-1 bg-secondary/50 rounded-lg w-fit">
        {STATUS_TABS.map(tab => (
          <button
            key={tab}
            onClick={() => { setStatus(tab); setPage(1); }}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors",
              status === tab
                ? "bg-card text-foreground shadow-sm border border-border"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {["Title", "Type", "Reward", "Slots", "Status", "Created", ""].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/50 animate-pulse">
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j} className="px-4 py-3"><div className="h-3 bg-secondary rounded w-20" /></td>
                    ))}
                  </tr>
                ))
              ) : data?.tasks.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No tasks found
                  </td>
                </tr>
              ) : (
                data?.tasks.map(t => (
                  <tr key={t.id} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground max-w-[200px]">
                      <p className="truncate">{t.title}</p>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground capitalize">{t.type}</td>
                    <td className="px-4 py-3 text-foreground">{formatCurrency(t.reward)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <span className="text-foreground font-medium">{t.slotsFilled}</span>/{t.maxSlots}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("px-2 py-0.5 rounded-full text-xs font-medium border capitalize", statusColor(t.status))}>
                        {t.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">{timeAgo(t.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => downloadFile(`/admin/tasks/${t.id}/export.csv`, `task-${t.id}.csv`).catch((err) => alert(`Download failed: ${err.message}`))}
                          className="px-2 py-1 rounded text-xs font-medium bg-secondary text-foreground border border-border hover:bg-secondary/80 transition-colors"
                          title="Download CSV: task details + every submission"
                        >
                          Report
                        </button>
                        {t.status === "open" && (
                          <button
                            onClick={() => openCancel(t.id)}
                            disabled={cancellingId === t.id}
                            className="px-2 py-1 rounded text-xs font-medium bg-destructive/10 text-destructive border border-destructive/20 hover:bg-destructive/20 disabled:opacity-40 transition-colors"
                          >
                            Cancel
                          </button>
                        )}
                      </div>
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
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 text-foreground transition-colors">Prev</button>
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 text-foreground transition-colors">Next</button>
          </div>
        </div>
      )}

      {confirmId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="w-full max-w-sm rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h2 className="font-semibold text-foreground">Cancel Task #{confirmId}</h2>
              <button onClick={() => { setConfirmId(null); setCancelMsg(null); }} className="text-muted-foreground hover:text-foreground">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-muted-foreground">This will close the task and expire any active claims. Claimers will be notified via DM.</p>
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
                  Keep Task
                </button>
                <button
                  onClick={doCancel}
                  disabled={cancelMutation.isPending}
                  className="flex-1 px-3 py-2 rounded-lg bg-destructive/10 text-destructive border border-destructive/20 text-sm font-medium hover:bg-destructive/20 disabled:opacity-40 transition-colors"
                >
                  {cancelMutation.isPending ? "Cancelling..." : "Cancel Task"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
