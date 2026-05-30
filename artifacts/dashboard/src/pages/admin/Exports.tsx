import { useState } from "react";
import { downloadFile, post } from "@/lib/api";

interface ExportDef {
  key: string;
  label: string;
  path: string;
  desc: string;
}

const EXPORTS: ExportDef[] = [
  {
    key: "submissions",
    label: "Submissions",
    path: "/admin/exports/submissions.csv",
    desc: "Every proof submission with reviewer + status, live status, and reward.",
  },
  {
    key: "withdrawals",
    label: "Withdrawals",
    path: "/admin/exports/withdrawals.csv",
    desc: "All payout requests with method, destination, reviewer, and timestamps.",
  },
  {
    key: "creator-payouts",
    label: "Per-creator payouts",
    path: "/admin/exports/creator-payouts.csv",
    desc: "Each creator's split of every withdrawal, with mark-paid status and timestamps.",
  },
  {
    key: "claims",
    label: "Claims audit",
    path: "/admin/exports/claims.csv",
    desc: "Every claim attempt — claimed, submitted, expired — for traceability.",
  },
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function isoNDaysAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export default function Exports() {
  const [from, setFrom] = useState(isoNDaysAgo(30));
  const [to, setTo] = useState(todayISO());
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [backfillCampaignId, setBackfillCampaignId] = useState("");

  const runBackfill = async () => {
    setBackfillMsg(null);
    if (!from || !to) {
      setBackfillMsg({ kind: "err", text: "Pick both a From and a To date first." });
      return;
    }
    setBackfillBusy(true);
    try {
      const cid = backfillCampaignId.trim();
      const body: { from: string; to: string; campaignId?: number } = { from, to };
      if (cid) {
        const n = parseInt(cid);
        if (!Number.isFinite(n)) {
          setBackfillMsg({ kind: "err", text: "Campaign ID must be a number (or leave blank for all)." });
          setBackfillBusy(false);
          return;
        }
        body.campaignId = n;
      }
      const r = await post<{ ok: boolean; queued: number; capped: boolean }>("/admin/sheets/backfill", body);
      setBackfillMsg({
        kind: "ok",
        text: r.capped
          ? `Queued ${r.queued} submissions to their Google Sheets. Hit the per-call cap — run again to backfill the rest.`
          : `Queued ${r.queued} submissions to their Google Sheets. May take a minute to fully land.`,
      });
    } catch (e: any) {
      setBackfillMsg({ kind: "err", text: e?.message ?? "Backfill failed" });
    } finally {
      setBackfillBusy(false);
    }
  };

  const download = async (e: ExportDef) => {
    setErr(null);
    setBusy(e.key);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const path = qs.toString() ? `${e.path}?${qs.toString()}` : e.path;
      const fallback = `${e.key}_${from || "all"}_to_${to || "now"}.csv`;
      await downloadFile(path, fallback);
    } catch (e: any) {
      setErr(e?.message ?? "Download failed");
    } finally {
      setBusy(null);
    }
  };

  const setPreset = (days: number | null) => {
    setTo(todayISO());
    setFrom(days == null ? "" : isoNDaysAgo(days));
  };

  return (
    <div className="p-5 sm:p-7 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Data Exports</h1>
        <p className="text-[13px] text-zinc-500 mt-1">
          Download CSV snapshots for accounting, tax, or analysis. Date range is inclusive on both ends and applies to the record's primary timestamp (submitted/requested/claimed/created). Leave blank for all time.
        </p>
      </div>

      <div className="border border-zinc-800 rounded-md bg-zinc-900/40 p-4 space-y-3">
        <p className="text-[12px] uppercase tracking-wide text-zinc-500 font-medium">Date range</p>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex flex-col">
            <label className="text-[11px] text-zinc-500 mb-1">From</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="px-3 py-2 rounded-md bg-zinc-950 border border-zinc-800 text-[13px] text-zinc-100 focus:outline-none focus:border-zinc-600"
            />
          </div>
          <div className="flex flex-col">
            <label className="text-[11px] text-zinc-500 mb-1">To</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="px-3 py-2 rounded-md bg-zinc-950 border border-zinc-800 text-[13px] text-zinc-100 focus:outline-none focus:border-zinc-600"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setPreset(7)} className="px-2.5 py-1.5 rounded text-[11.5px] bg-zinc-800 hover:bg-zinc-700 text-zinc-200">Last 7d</button>
            <button onClick={() => setPreset(30)} className="px-2.5 py-1.5 rounded text-[11.5px] bg-zinc-800 hover:bg-zinc-700 text-zinc-200">Last 30d</button>
            <button onClick={() => setPreset(90)} className="px-2.5 py-1.5 rounded text-[11.5px] bg-zinc-800 hover:bg-zinc-700 text-zinc-200">Last 90d</button>
            <button onClick={() => setPreset(null)} className="px-2.5 py-1.5 rounded text-[11.5px] bg-zinc-800 hover:bg-zinc-700 text-zinc-200">All time</button>
          </div>
        </div>
      </div>

      {err && (
        <div className="text-[13px] text-red-400 border border-red-900/50 bg-red-950/30 rounded-md p-3">{err}</div>
      )}

      <div className="border border-zinc-800 rounded-md bg-zinc-900/40 p-4 space-y-3">
        <div>
          <p className="text-[14px] font-medium text-zinc-100">Google Sheets backfill</p>
          <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
            Re-push every submission in the date range above to its Google Sheet. Use this after linking a sheet to a campaign so it gets the older rows too, or to rebuild a sheet for a specific date range for your accountant. Up to 500 rows per call — run twice if you have more.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex flex-col">
            <label className="text-[11px] text-zinc-500 mb-1">Campaign ID (optional)</label>
            <input
              type="text"
              placeholder="all campaigns"
              value={backfillCampaignId}
              onChange={(e) => setBackfillCampaignId(e.target.value)}
              className="px-3 py-2 rounded-md bg-zinc-950 border border-zinc-800 text-[13px] text-zinc-100 w-44 focus:outline-none focus:border-zinc-600"
            />
          </div>
          <button
            onClick={runBackfill}
            disabled={backfillBusy}
            className="px-3.5 py-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-[12.5px] text-white font-medium"
          >
            {backfillBusy ? "Backfilling…" : "Backfill sheets"}
          </button>
        </div>
        {backfillMsg && (
          <p className={`text-[12px] ${backfillMsg.kind === "ok" ? "text-emerald-400" : "text-red-400"}`}>
            {backfillMsg.text}
          </p>
        )}
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {EXPORTS.map((e) => (
          <div key={e.key} className="border border-zinc-800 rounded-md bg-zinc-900/40 p-4 flex flex-col gap-2.5">
            <div>
              <p className="text-[14px] font-medium text-zinc-100">{e.label}</p>
              <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">{e.desc}</p>
            </div>
            <button
              onClick={() => download(e)}
              disabled={busy !== null}
              className="self-start px-3.5 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-[12.5px] text-white font-medium"
            >
              {busy === e.key ? "Preparing…" : "Download CSV"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
