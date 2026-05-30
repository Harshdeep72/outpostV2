import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { formatCurrency, cn } from "@/lib/utils";

interface Stats {
  totalUsers: number;
  verifiedUsers: number;
  totalTasks: number;
  openTasks: number;
  pendingSubmissions: number;
  approvedSubmissions: number;
  totalEarned: string;
  pendingPayout: string;
  activeCampaigns: number;
  flaggedUsers: number;
}

function StatCard({
  label,
  value,
  sub,
  color = "default",
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: "default" | "red" | "yellow" | "green";
}) {
  const accent = {
    default: "text-foreground",
    red: "text-destructive",
    yellow: "text-yellow-400",
    green: "text-green-400",
  }[color];

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">{label}</p>
      <p className={cn("text-2xl font-bold", accent)}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

export default function Overview() {
  const { data: stats, isLoading, error } = useQuery<Stats>({
    queryKey: ["admin-stats"],
    queryFn: () => get<Stats>("/admin/stats"),
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-5 animate-pulse">
              <div className="h-3 bg-secondary rounded w-2/3 mb-3" />
              <div className="h-7 bg-secondary rounded w-1/2" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load stats. Make sure the API server is running.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-foreground">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Outpost Bot overview</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard label="Total Users" value={stats.totalUsers} sub={`${stats.verifiedUsers} verified`} />
        <StatCard label="Flagged Users" value={stats.flaggedUsers} color="red" />
        <StatCard label="Total Tasks" value={stats.totalTasks} sub={`${stats.openTasks} open`} color="yellow" />
        <StatCard label="Pending Reviews" value={stats.pendingSubmissions} color="yellow" />
        <StatCard label="Approved" value={stats.approvedSubmissions} color="green" />
        <StatCard label="Lifetime Earnings" value={formatCurrency(stats.totalEarned)} color="green" />
        <StatCard label="Pending Payout" value={formatCurrency(stats.pendingPayout)} color="yellow" />
        <StatCard label="Active Campaigns" value={stats.activeCampaigns} color="yellow" />
        <StatCard label="Verified Users" value={stats.verifiedUsers} sub={`of ${stats.totalUsers}`} color="green" />
        <StatCard
          label="Verification Rate"
          value={stats.totalUsers > 0 ? `${Math.round((stats.verifiedUsers / stats.totalUsers) * 100)}%` : "0%"}
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Quick Status</h2>
        <div className="space-y-3">
          {[
            { label: "Bot Status", value: "Online", ok: true },
            { label: "Database", value: "Connected", ok: true },
            { label: "Pending Reviews", value: `${stats.pendingSubmissions} awaiting`, ok: stats.pendingSubmissions === 0 },
            { label: "Flagged Accounts", value: `${stats.flaggedUsers} flagged`, ok: stats.flaggedUsers === 0 },
            { label: "Open Tasks", value: `${stats.openTasks} available`, ok: stats.openTasks > 0 },
          ].map(item => (
            <div key={item.label} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{item.label}</span>
              <span className={cn("flex items-center gap-1.5 font-medium", item.ok ? "text-green-400" : "text-yellow-400")}>
                <span className={cn("w-1.5 h-1.5 rounded-full", item.ok ? "bg-green-400" : "bg-yellow-400")} />
                {item.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
