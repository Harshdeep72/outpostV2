import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
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
    case "warn": return "text-yellow-400";
    case "info": return "text-blue-400";
    case "debug": return "text-muted-foreground";
    default: return "text-foreground";
  }
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

      <div className="flex-1 rounded-xl border border-border bg-card overflow-hidden flex flex-col min-h-[400px]">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-secondary/30">
          {["error", "warn", "info", "debug"].map(level => (
            <span key={level} className={cn("flex items-center gap-1 text-xs font-mono", levelColor(level))}>
              <span className={cn("w-1.5 h-1.5 rounded-full inline-block", {
                "bg-red-400": level === "error",
                "bg-yellow-400": level === "warn",
                "bg-blue-400": level === "info",
                "bg-gray-500": level === "debug",
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
