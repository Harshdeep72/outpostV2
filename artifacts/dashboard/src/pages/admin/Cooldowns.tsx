import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { cn } from "@/lib/utils";

interface CooldownEntry {
  discord_id: string;
  discord_username: string;
  reddit_username?: string;
  last_used_at?: string;
  last_task_completed_at?: string;
  ready_at: string;
  ms_remaining: number | string;
  cooldown_type: "reddit" | "user";
}

interface CooldownsResponse {
  cooldowns: CooldownEntry[];
  cooldownEnabled: boolean;
  cooldownMinutes: number;
  totalActive: number;
}

function fmtMs(ms: number | string): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "ready";
  const secs = Math.ceil(n / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return `${mins}m ${rem}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function fmtTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function pct(ms: number | string, totalMs: number): number {
  const n = Number(ms);
  if (!Number.isFinite(n) || totalMs <= 0) return 0;
  return Math.max(0, Math.min(100, (n / totalMs) * 100));
}

export default function Cooldowns() {
  const { data, isLoading, error, refetch, isFetching } = useQuery<CooldownsResponse>({
    queryKey: ["admin-cooldowns"],
    queryFn: () => get<CooldownsResponse>("/admin/cooldowns"),
    refetchInterval: 30_000,
  });

  // Tick once per second so per-row countdowns + progress bars update live,
  // without re-hitting the API. Remaining is computed from `ready_at` (ISO)
  // against `now`, so it stays accurate even between server refetches.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const totalMs = (data?.cooldownMinutes ?? 0) * 60 * 1000;

  return (
    <div className="p-6 max-w-5xl space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">Account Cooldowns</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Users and Reddit accounts currently on cooldown. Auto-refreshes every 30 seconds.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-3 py-1.5 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80 transition disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isFetching ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      {isLoading && (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground text-sm">
          Loading cooldowns…
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 text-destructive p-4 text-sm">
          {(error as Error).message}
        </div>
      )}

      {data && !data.cooldownEnabled && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-200 p-4 text-sm">
          Cooldowns are currently <strong>disabled</strong> globally. Enable them in Settings to see active cooldowns.
        </div>
      )}

      {data && data.cooldownEnabled && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <StatCard label="Total active cooldowns" value={String(data.totalActive)} />
            <StatCard label="Reddit account cooldowns" value={String(data.cooldowns.filter(c => c.cooldown_type === "reddit").length)} />
            <StatCard label="User-level cooldowns" value={String(data.cooldowns.filter(c => c.cooldown_type === "user").length)} />
          </div>

          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border text-xs uppercase tracking-wide text-muted-foreground font-medium flex items-center justify-between">
              <span>Active cooldowns — {data.cooldownMinutes >= 60 ? `${(data.cooldownMinutes / 60).toFixed(data.cooldownMinutes % 60 === 0 ? 0 : 1)}h` : `${data.cooldownMinutes}m`} window</span>
              <span>{data.totalActive} total</span>
            </div>

            {data.cooldowns.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground italic">
                No active cooldowns right now.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {data.cooldowns.map((entry, i) => {
                  // Recompute remaining from ready_at vs current tick so the
                  // countdown ticks live every second. Falls back to the
                  // server-provided ms_remaining if ready_at is unparseable.
                  const readyMs = entry.ready_at ? Date.parse(entry.ready_at) : NaN;
                  const liveRemaining = Number.isFinite(readyMs)
                    ? Math.max(0, readyMs - now)
                    : Number(entry.ms_remaining);
                  const barPct = pct(liveRemaining, totalMs);
                  const lastAt = entry.cooldown_type === "reddit" ? entry.last_used_at : entry.last_task_completed_at;
                  return (
                    <li key={i} className="px-4 py-3 space-y-1.5">
                      <div className="flex items-start gap-3 flex-wrap">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">{entry.discord_username}</div>
                          <div className="text-[11px] text-muted-foreground font-mono truncate">{entry.discord_id}</div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={cn(
                            "px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border",
                            entry.cooldown_type === "reddit"
                              ? "bg-blue-500/10 text-blue-300 border-blue-500/30"
                              : "bg-violet-500/10 text-violet-300 border-violet-500/30"
                          )}>
                            {entry.cooldown_type === "reddit" ? "reddit" : "user"}
                          </span>
                          <span className="font-mono text-sm text-amber-300 font-semibold whitespace-nowrap">
                            {fmtMs(liveRemaining)} left
                          </span>
                        </div>
                      </div>

                      {entry.reddit_username && (
                        <p className="text-xs text-muted-foreground">
                          Account: <span className="text-foreground">u/{entry.reddit_username}</span>
                        </p>
                      )}

                      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        <span>Last used: {fmtTime(lastAt)}</span>
                        <span>Ready: {fmtTime(entry.ready_at)}</span>
                      </div>

                      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                        <div
                          className="h-full rounded-full bg-amber-500 transition-all"
                          style={{ width: `${barPct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
    </div>
  );
}
