import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { cn, formatCurrency, timeAgo } from "@/lib/utils";

interface ProofSubmission {
  id: number;
  discord_id: string;
  discord_username: string | null;
  reddit_username: string | null;
  review_status: string;
  live_status: string | null;
  reward: string;
  proof_link: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  review_reason: string | null;
}

function ProofsPanel({ taskId }: { taskId: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["task-proofs", taskId],
    queryFn: () => get<{ taskId: number; submissions: ProofSubmission[] }>(`/admin/tasks/${taskId}/proofs`),
  });
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copy = (id: number, text: string) => {
    navigator.clipboard.writeText(text).then(() => { setCopiedId(id); setTimeout(() => setCopiedId(null), 1500); });
  };
  if (isLoading) return <p className="mt-3 text-[11.5px] text-zinc-500">Loading proofs…</p>;
  if (error) return <p className="mt-3 text-[11.5px] text-red-400">{(error as Error).message}</p>;
  const subs = data?.submissions ?? [];
  if (subs.length === 0) return <p className="mt-3 text-[11.5px] text-zinc-600 italic">No submissions for this task yet.</p>;
  return (
    <div className="mt-3 border border-zinc-800 rounded bg-zinc-950 divide-y divide-zinc-800">
      {subs.map((s) => (
        <div key={s.id} className="px-3 py-2 text-[11.5px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-zinc-200 font-medium truncate max-w-[140px]">{s.discord_username ?? s.discord_id}</span>
            {s.reddit_username && <span className="text-zinc-500 text-[10.5px]">u/{s.reddit_username}</span>}
            <span className={cn("px-1.5 py-0.5 rounded text-[9.5px] uppercase tracking-wide border",
              s.review_status === "accepted" ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
              : s.review_status === "rejected" ? "bg-red-500/10 text-red-400 border-red-500/30"
              : "bg-amber-500/10 text-amber-300 border-amber-500/30"
            )}>{s.review_status}</span>
            {s.live_status && s.live_status !== "unchecked" && (
              <span className={cn("px-1.5 py-0.5 rounded text-[9.5px] uppercase tracking-wide border",
                s.live_status === "live" ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                : s.live_status === "removed" ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
                : s.live_status === "deleted" ? "bg-red-500/10 text-red-400 border-red-500/30"
                : "bg-zinc-800 text-zinc-400 border-zinc-700"
              )}>{s.live_status}</span>
            )}
            <span className="font-mono text-emerald-300 ml-auto">{formatCurrency(s.reward)}</span>
          </div>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <span className="text-zinc-600 text-[10.5px]">{timeAgo(s.submitted_at)}</span>
            {s.proof_link ? (
              <>
                <a href={s.proof_link} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline truncate max-w-[280px]">{s.proof_link}</a>
                <button onClick={() => copy(s.id, s.proof_link!)}
                  className="px-1.5 py-0.5 rounded text-[9.5px] border border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition">
                  {copiedId === s.id ? "✓" : "copy"}
                </button>
              </>
            ) : <span className="text-zinc-600 italic">no proof link</span>}
          </div>
          {s.review_status === "rejected" && s.review_reason && (
            <p className="mt-1 text-[10.5px] text-red-400/80">Reason: {s.review_reason}</p>
          )}
        </div>
      ))}
    </div>
  );
}

interface Submitter {
  discordId: string;
  discordUsername: string | null;
  count: number;
  totalEarned: string;
}

interface CreatorTask {
  id: number;
  title: string;
  type: string;
  reward: string;
  status: string;
  createdAt: string;
  submitters: Submitter[];
  totalAccepted: number;
  totalPaid: string;
}

interface Creator {
  creatorDiscordId: string;
  creatorName: string;
  totalTasks: number;
  totalAcceptedSubs: number;
  totalPaid: string;
  tasks: CreatorTask[];
}

export default function TasksByCreator() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "tasks-by-creator"],
    queryFn: () => get<{ creators: Creator[] }>("/admin/tasks-by-creator"),
  });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [openProofs, setOpenProofs] = useState<Set<number>>(new Set());
  const toggleProofs = (taskId: number) => {
    const next = new Set(openProofs);
    if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
    setOpenProofs(next);
  };

  const creators = (data?.creators ?? []).filter((c) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return c.creatorName.toLowerCase().includes(q)
      || c.creatorDiscordId.toLowerCase().includes(q)
      || c.tasks.some((t) => t.title.toLowerCase().includes(q));
  });

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="p-5 sm:p-7 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-zinc-100">Tasks by Creator</h1>
          <p className="text-[13px] text-zinc-500 mt-1">
            Each task creator's tasks, the users who completed them, and what's been paid out so far.
          </p>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search creator or task…"
          className="w-full sm:w-72 px-3 py-2 rounded-md bg-zinc-900 border border-zinc-800 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
        />
      </div>

      {isLoading && (
        <div className="text-[13px] text-zinc-500">Loading…</div>
      )}
      {error && (
        <div className="text-[13px] text-red-400">Failed to load: {(error as Error).message}</div>
      )}

      {!isLoading && !error && creators.length === 0 && (
        <div className="text-[13px] text-zinc-500 border border-zinc-800 rounded-md p-6 text-center bg-zinc-900/40">
          No creators found.
        </div>
      )}

      <div className="space-y-2">
        {creators.map((c) => {
          const open = expanded.has(c.creatorDiscordId);
          return (
            <div key={c.creatorDiscordId} className="border border-zinc-800 rounded-md bg-zinc-900/40">
              <button
                onClick={() => toggle(c.creatorDiscordId)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-900/70"
              >
                <svg className={cn("w-3.5 h-3.5 text-zinc-500 transition-transform", open && "rotate-90")} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-zinc-100 truncate">{c.creatorName}</p>
                  <p className="text-[11px] text-zinc-500 truncate font-mono">{c.creatorDiscordId}</p>
                </div>
                <div className="hidden sm:flex items-center gap-5 text-[12px] text-zinc-400 shrink-0">
                  <span><span className="text-zinc-200 font-semibold">{c.totalTasks}</span> tasks</span>
                  <span><span className="text-zinc-200 font-semibold">{c.totalAcceptedSubs}</span> accepted</span>
                  <span><span className="text-emerald-300 font-semibold">{formatCurrency(c.totalPaid)}</span> paid</span>
                </div>
              </button>

              {open && (
                <div className="border-t border-zinc-800 divide-y divide-zinc-800">
                  {c.tasks.length === 0 && (
                    <div className="px-5 py-4 text-[12px] text-zinc-500">No tasks.</div>
                  )}
                  {c.tasks.map((t) => (
                    <div key={t.id} className="px-5 py-4">
                      <div className="flex items-start gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium text-zinc-100 truncate">
                            #{t.id} — {t.title}
                          </p>
                          <p className="text-[11px] text-zinc-500 mt-0.5">
                            {t.type} · {formatCurrency(t.reward)} reward · created {timeAgo(t.createdAt)} ·
                            <span className={cn("ml-1.5 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide",
                              t.status === "open" ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/30"
                                : "bg-zinc-800 text-zinc-400 border border-zinc-700")}>
                              {t.status}
                            </span>
                          </p>
                        </div>
                        <div className="text-right text-[11.5px] text-zinc-400 shrink-0">
                          <p>{t.totalAccepted} completion{t.totalAccepted === 1 ? "" : "s"}</p>
                          <p className="text-emerald-300 font-mono">{formatCurrency(t.totalPaid)} paid</p>
                        </div>
                      </div>

                      {t.submitters.length > 0 && (
                        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                          {t.submitters.map((s) => (
                            <div key={s.discordId} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-zinc-950 border border-zinc-800/70">
                              <div className="min-w-0">
                                <p className="text-[12px] text-zinc-200 truncate">{s.discordUsername ?? s.discordId}</p>
                                <p className="text-[10px] text-zinc-500 font-mono truncate">{s.discordId}</p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-[11.5px] text-emerald-300 font-mono">{formatCurrency(s.totalEarned)}</p>
                                <p className="text-[10px] text-zinc-500">×{s.count}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {t.submitters.length === 0 && (
                        <p className="mt-2 text-[11.5px] text-zinc-600 italic">No accepted submissions yet.</p>
                      )}

                      <div className="mt-2.5">
                        <button
                          onClick={() => toggleProofs(t.id)}
                          className="text-[11px] text-zinc-400 hover:text-zinc-200 underline-offset-2 hover:underline transition"
                        >
                          {openProofs.has(t.id) ? "▾ Hide proofs" : "▸ View proofs"}
                        </button>
                        {openProofs.has(t.id) && <ProofsPanel taskId={t.id} />}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
