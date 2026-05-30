import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, post } from "@/lib/api";
import { cn } from "@/lib/utils";

interface LogEntry {
  level: string;
  message: string;
  time: string;
}

interface ConsoleLogsResponse {
  logs: LogEntry[];
}

function levelColor(level: string) {
  switch (level.toLowerCase()) {
    case "error": return "text-red-400";
    case "warn":  return "text-yellow-400";
    case "info":  return "text-blue-400";
    case "debug": return "text-muted-foreground";
    default:      return "text-foreground";
  }
}

function ActionButton({ label, endpoint, description, color = "indigo" }: {
  label: string;
  endpoint: string;
  description: string;
  color?: "indigo" | "amber";
}) {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "err">("idle");

  async function run() {
    setState("loading");
    try {
      await post(endpoint, {});
      setState("ok");
      setTimeout(() => setState("idle"), 4000);
    } catch {
      setState("err");
      setTimeout(() => setState("idle"), 4000);
    }
  }

  const base = color === "amber"
    ? "border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
    : "border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10";

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-secondary/20">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <button
        onClick={run}
        disabled={state === "loading"}
        className={cn(
          "shrink-0 px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors disabled:opacity-50",
          base,
          state === "ok"  && "border-green-500/40 text-green-400 bg-green-500/10",
          state === "err" && "border-red-500/40 text-red-400 bg-red-500/10",
        )}
      >
        {state === "loading" ? "Running…" : state === "ok" ? "✓ Done" : state === "err" ? "✗ Failed" : "Run Now"}
      </button>
    </div>
  );
}

/** Slow Sweep button — shows decided/skipped counts from each 5-submission batch. */
function SlowSweepButton() {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [lastResult, setLastResult] = useState<{ decided: number; skipped: number } | null>(null);

  async function run() {
    setState("loading");
    setLastResult(null);
    try {
      const res = await post<{ decided: number; skipped: number }>("/admin/sweep/run-slow", {});
      setLastResult(res);
      setState("ok");
      setTimeout(() => setState("idle"), 8000);
    } catch {
      setState("err");
      setTimeout(() => setState("idle"), 4000);
    }
  }

  const btnLabel = state === "loading"
    ? "Checking 5…"
    : state === "ok" && lastResult
      ? `✓ ${lastResult.decided} decided, ${lastResult.skipped} skipped`
      : state === "err"
        ? "✗ Failed"
        : "Run (5 at a time)";

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-border bg-secondary/20">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">🐢 Slow Sweep — Safe Backlog Mode</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Processes <strong>5 submissions</strong> with a <strong>3s gap</strong> between each so proxies don’t get rate-limited.
          Keep clicking until it shows <em>0 decided, 0 skipped</em>.
        </p>
      </div>
      <button
        onClick={run}
        disabled={state === "loading"}
        className={cn(
          "shrink-0 px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors disabled:opacity-50",
          "border-green-500/40 text-green-300 hover:bg-green-500/10",
          state === "ok"  && "border-green-500/40 text-green-400 bg-green-500/10",
          state === "err" && "border-red-500/40 text-red-400 bg-red-500/10",
        )}
      >
        {btnLabel}
      </button>
    </div>
  );
}

export default function Console() {
  const { data, isLoading, dataUpdatedAt } = useQuery<ConsoleLogsResponse>({
    queryKey: ["admin-console-logs"],
    queryFn: () => get<ConsoleLogsResponse>("/admin/console-logs?limit=200"),
    refetchInterval: 5000,
  });

  const logs = [...(data?.logs ?? [])].reverse();

  return (
    <div className="p-6 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Server Console</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Live logs — auto-refreshing every 5s
            {dataUpdatedAt ? ` · Last updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          Live
        </div>
      </div>

      {/* Manual triggers */}
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">Manual Triggers</p>
        <SlowSweepButton />
        <ActionButton
          label="⚡ Force Sweep Pending Submissions (fast — 100 batch)"
          endpoint="/admin/sweep/run-now"
          description="Re-checks ALL pending submissions older than 24h at once. Only use when no proxy rate-limiting concern — otherwise use Slow Sweep above."
          color="amber"
        />
        <ActionButton
          label="🔍 Force Liveness Check"
          endpoint="/admin/liveness/run-now"
          description="Scans approved submissions for deleted/removed posts and reverses payouts automatically."
          color="indigo"
        />
      </div>

      <div className="flex-1 rounded-xl border border-border bg-card overflow-hidden flex flex-col min-h-[400px]">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-secondary/30">
          {["error", "warn", "info", "debug"].map(level => (
            <span key={level} className={cn("flex items-center gap-1 text-xs font-mono", levelColor(level))}>
              <span className={cn("w-1.5 h-1.5 rounded-full inline-block", {
                "bg-red-400":    level === "error",
                "bg-yellow-400": level === "warn",
                "bg-blue-400":   level === "info",
                "bg-gray-500":   level === "debug",
              })} />
              {level}
            </span>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-1">
          {isLoading ? (
            <div className="text-muted-foreground animate-pulse">Loading logs...</div>
          ) : logs.length === 0 ? (
            <div className="text-muted-foreground">No logs yet. Bot activity will appear here.</div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="flex gap-3 hover:bg-secondary/20 px-2 py-0.5 rounded group">
                <span className="text-muted-foreground shrink-0 select-none">
                  {new Date(log.time).toLocaleTimeString()}
                </span>
                <span className={cn("shrink-0 w-10 uppercase font-bold select-none", levelColor(log.level))}>
                  {log.level.slice(0, 4)}
                </span>
                <span className="text-foreground/80 break-all">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
