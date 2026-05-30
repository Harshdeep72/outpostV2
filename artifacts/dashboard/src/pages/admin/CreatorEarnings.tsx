import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

interface CreatorEarning {
  creatorDiscordId: string;
  creatorName: string;
  totalTasks: number;
  openTasks: number;
  closedTasks: number;
  totalSlots: number;
  totalSlotsFilled: number;
  fillRate: number;
  totalPaid: string;
  totalAccepted: number;
  totalRejected: number;
  totalPending: number;
  avgReward: string;
  avgCostPerSub: string;
  firstTaskAt: string | null;
  lastTaskAt: string | null;
}

type SortKey = "totalPaid" | "totalTasks" | "fillRate" | "avgCostPerSub" | "lastTaskAt";

export default function CreatorEarnings() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "creator-earnings"],
    queryFn: () => get<{ creators: CreatorEarning[] }>("/admin/creator-earnings"),
  });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("totalPaid");

  const rows = useMemo(() => {
    const list = (data?.creators ?? []).filter((c) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return c.creatorName.toLowerCase().includes(q) || c.creatorDiscordId.toLowerCase().includes(q);
    });
    const sorted = [...list].sort((a, b) => {
      switch (sort) {
        case "totalPaid": return parseFloat(b.totalPaid) - parseFloat(a.totalPaid);
        case "totalTasks": return b.totalTasks - a.totalTasks;
        case "fillRate": return b.fillRate - a.fillRate;
        case "avgCostPerSub": return parseFloat(b.avgCostPerSub) - parseFloat(a.avgCostPerSub);
        case "lastTaskAt":
          return new Date(b.lastTaskAt ?? 0).getTime() - new Date(a.lastTaskAt ?? 0).getTime();
      }
    });
    return sorted;
  }, [data, search, sort]);

  const totals = useMemo(() => {
    const list = data?.creators ?? [];
    return {
      creators: list.length,
      tasks: list.reduce((s, c) => s + c.totalTasks, 0),
      paid: list.reduce((s, c) => s + parseFloat(c.totalPaid), 0),
      accepted: list.reduce((s, c) => s + c.totalAccepted, 0),
    };
  }, [data]);

  return (
    <div className="p-5 sm:p-7 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-zinc-100">Creator Earnings & Spend</h1>
          <p className="text-[13px] text-zinc-500 mt-1">
            Financial summary per task creator — total spent, fill rate, avg cost per accepted submission. For a drill-down view, see Tasks by Creator.
          </p>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search creator…"
          className="w-full sm:w-64 px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 text-[13px] text-zinc-100 focus:outline-none focus:border-zinc-600"
        >
          <option value="totalPaid">Sort: Total paid</option>
          <option value="totalTasks">Sort: Total tasks</option>
          <option value="fillRate">Sort: Fill rate</option>
          <option value="avgCostPerSub">Sort: Avg cost/sub</option>
          <option value="lastTaskAt">Sort: Last task</option>
        </select>
      </div>

      {!isLoading && !error && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <Stat label="Creators" value={String(totals.creators)} />
          <Stat label="Tasks created" value={String(totals.tasks)} />
          <Stat label="Total paid out" value={formatCurrency(totals.paid.toFixed(2))} accent="emerald" />
          <Stat label="Accepted subs" value={String(totals.accepted)} />
        </div>
      )}

      {isLoading && <div className="text-[13px] text-zinc-500">Loading…</div>}
      {error && <div className="text-[13px] text-red-400">Failed to load: {(error as Error).message}</div>}

      {!isLoading && !error && rows.length === 0 && (
        <div className="text-[13px] text-zinc-500 border border-zinc-800 rounded-md p-6 text-center bg-zinc-900/40">
          No creators found.
        </div>
      )}

      {rows.length > 0 && (
        <div className="border border-zinc-800 rounded-md bg-zinc-900/40 overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="text-zinc-500 text-[11px] uppercase tracking-wide">
              <tr className="border-b border-zinc-800">
                <th className="text-left px-4 py-2.5 font-medium">Creator</th>
                <th className="text-right px-3 py-2.5 font-medium">Tasks</th>
                <th className="text-right px-3 py-2.5 font-medium">Open/Closed</th>
                <th className="text-right px-3 py-2.5 font-medium">Fill rate</th>
                <th className="text-right px-3 py-2.5 font-medium">Accepted</th>
                <th className="text-right px-3 py-2.5 font-medium">Avg reward</th>
                <th className="text-right px-3 py-2.5 font-medium">Avg cost/sub</th>
                <th className="text-right px-4 py-2.5 font-medium">Total paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {rows.map((c) => (
                <tr key={c.creatorDiscordId} className="hover:bg-zinc-900/60">
                  <td className="px-4 py-2.5">
                    <p className="text-zinc-100 truncate max-w-[260px]">{c.creatorName}</p>
                    <p className="text-[10.5px] text-zinc-500 font-mono truncate max-w-[260px]">{c.creatorDiscordId}</p>
                  </td>
                  <td className="text-right px-3 py-2.5 text-zinc-200 font-medium">{c.totalTasks}</td>
                  <td className="text-right px-3 py-2.5 text-zinc-400">
                    <span className="text-emerald-300">{c.openTasks}</span>
                    <span className="text-zinc-600"> / </span>
                    <span>{c.closedTasks}</span>
                  </td>
                  <td className="text-right px-3 py-2.5 text-zinc-300 font-mono">{c.fillRate}%</td>
                  <td className="text-right px-3 py-2.5 text-zinc-300">
                    {c.totalAccepted}
                    {(c.totalPending > 0 || c.totalRejected > 0) && (
                      <span className="text-[10.5px] text-zinc-500 ml-1">
                        ({c.totalPending}p · {c.totalRejected}r)
                      </span>
                    )}
                  </td>
                  <td className="text-right px-3 py-2.5 text-zinc-300 font-mono">{formatCurrency(c.avgReward)}</td>
                  <td className="text-right px-3 py-2.5 text-zinc-300 font-mono">{formatCurrency(c.avgCostPerSub)}</td>
                  <td className="text-right px-4 py-2.5 text-emerald-300 font-mono font-semibold">{formatCurrency(c.totalPaid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "emerald" }) {
  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/40 px-3.5 py-3">
      <p className="text-[10.5px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-[18px] font-semibold ${accent === "emerald" ? "text-emerald-300" : "text-zinc-100"}`}>{value}</p>
    </div>
  );
}
