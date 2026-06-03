import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { get } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";

interface UserRef {
  id: number;
  discord_id: string;
  discord_username: string;
  trust_score: number;
  flagged: boolean;
}
interface HighReject extends UserRef { reviewed: number; rejected: number; rejection_pct: number; }
interface FastSubs extends UserRef { subs: number; avg_seconds: number; }
interface GhostClaim extends UserRef { claims: number; submissions: number; submit_pct: number; }
interface FastWd extends UserRef { total_earned: string; withdrawn_7d: string; }
interface SharedReddit {
  reddit_username: string;
  user_count: number;
  users: { id: number; discordId: string; username: string; flagged: boolean }[];
}
interface DuplicateDestination {
  destination: string;
  userCount: number;
  users: { id: number; discordId: string; username: string; flagged: boolean }[];
}
interface SignalsResp {
  highRejection: HighReject[];
  fastSubmissions: FastSubs[];
  sharedReddit: SharedReddit[];
  ghostClaims: GhostClaim[];
  fastWithdrawals: FastWd[];
  duplicateDestinations: DuplicateDestination[];
}

export default function FraudSignals() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["admin", "fraud-signals"],
    queryFn: () => get<SignalsResp>("/admin/fraud-signals"),
  });

  const dupDest = data?.duplicateDestinations || [];

  const totalSignals = data
    ? (data.highRejection?.length || 0) + 
      (data.fastSubmissions?.length || 0) + 
      (data.sharedReddit?.length || 0) +
      (data.ghostClaims?.length || 0) + 
      (data.fastWithdrawals?.length || 0) + 
      dupDest.length
    : 0;

  return (
    <div className="p-5 sm:p-7 space-y-5 max-w-6xl">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-zinc-100">Fraud Signals</h1>
          <p className="text-[13px] text-zinc-500 mt-1">
            Read-only heuristics surfacing suspicious worker patterns. These are <em>signals</em>, not verdicts —
            review each user's full profile before taking action.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-[12px] text-zinc-200 disabled:opacity-50"
        >{isFetching ? "Refreshing…" : "Refresh"}</button>
      </div>

      {isLoading && <div className="text-[13px] text-zinc-500">Loading signals…</div>}
      {error && <div className="text-[13px] text-red-400">Failed: {(error as Error).message}</div>}

      {data && (
        <>
          <div className="border border-zinc-800 rounded-md bg-zinc-900/40 px-4 py-3 text-[12.5px] text-zinc-400">
            <span className={totalSignals === 0 ? "text-emerald-400" : "text-amber-300"}>
              {totalSignals === 0 ? "✓ All clear" : `${totalSignals} signal${totalSignals === 1 ? "" : "s"} flagged`}
            </span>
            <span className="text-zinc-600"> · </span>
            <span>{(data.highRejection || []).length} high-reject · {(data.fastSubmissions || []).length} fast-subs · {(data.sharedReddit || []).length} shared reddit · {dupDest.length} shared dest · {(data.ghostClaims || []).length} ghost claimers · {(data.fastWithdrawals || []).length} fast cash-out</span>
          </div>

          <SignalCard
            title="High rejection rate"
            help="Users with ≥5 reviewed submissions and >50% rejected."
            empty={(data.highRejection || []).length === 0}
            emptyMsg="No workers tripping this signal."
            rows={(data.highRejection || []).map((u) => ({
              key: u.id,
              user: u,
              cells: [
                <Metric label="Rejected" value={`${u.rejected}/${u.reviewed}`} />,
                <Metric label="Pct" value={`${u.rejection_pct}%`} accent="red" />,
              ],
            }))}
          />

          <SignalCard
            title="Suspiciously fast submitters"
            help="Avg time from claim to submit < 30 seconds across ≥5 subs."
            empty={(data.fastSubmissions || []).length === 0}
            emptyMsg="No workers tripping this signal."
            rows={(data.fastSubmissions || []).map((u) => ({
              key: u.id,
              user: u,
              cells: [
                <Metric label="Subs" value={String(u.subs)} />,
                <Metric label="Avg time" value={`${u.avg_seconds}s`} accent="red" />,
              ],
            }))}
          />

          <SharedRedditCard rows={data.sharedReddit || []} />

          <DuplicateDestCard rows={dupDest} />

          <SignalCard
            title="Ghost claimers"
            help="Claim a lot but rarely submit — ≥5 claims, submit rate < 30%."
            empty={(data.ghostClaims || []).length === 0}
            emptyMsg="No workers tripping this signal."
            rows={(data.ghostClaims || []).map((u) => ({
              key: u.id,
              user: u,
              cells: [
                <Metric label="Claims/Subs" value={`${u.claims}/${u.submissions}`} />,
                <Metric label="Submit %" value={`${u.submit_pct}%`} accent="red" />,
              ],
            }))}
          />

          <SignalCard
            title="Fast cash-out"
            help="Withdrew ≥80% of lifetime earnings (and ≥$5) in the last 7 days."
            empty={(data.fastWithdrawals || []).length === 0}
            emptyMsg="No workers tripping this signal."
            rows={(data.fastWithdrawals || []).map((u) => ({
              key: u.id,
              user: u,
              cells: [
                <Metric label="Lifetime" value={formatCurrency(u.total_earned)} />,
                <Metric label="7d withdrawn" value={formatCurrency(u.withdrawn_7d)} accent="red" />,
              ],
            }))}
          />
        </>
      )}
    </div>
  );
}

function SignalCard({
  title, help, empty, emptyMsg, rows,
}: {
  title: string; help: string; empty: boolean; emptyMsg: string;
  rows: { key: number; user: UserRef; cells: React.ReactNode[] }[];
}) {
  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/40 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-zinc-800 flex items-baseline gap-3">
        <h2 className="text-[13px] font-medium text-zinc-100">{title}</h2>
        <span className="text-[10.5px] uppercase tracking-wide text-zinc-500">{rows.length}</span>
        <span className="text-[11.5px] text-zinc-500 ml-auto">{help}</span>
      </div>
      {empty ? (
        <p className="px-4 py-5 text-[12.5px] text-zinc-500 italic">{emptyMsg}</p>
      ) : (
        <ul className="divide-y divide-zinc-800">
          {rows.map((r) => (
            <li key={r.key} className="px-4 py-2.5 flex items-center gap-4">
              <UserCell user={r.user} />
              <div className="flex items-center gap-4 ml-auto shrink-0">
                {r.cells.map((c, i) => <div key={i}>{c}</div>)}
                <Link href={`/admin/workers/${r.user.id}`} className="text-[12px] text-emerald-400 hover:text-emerald-300 whitespace-nowrap">
                  Profile →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SharedRedditCard({ rows }: { rows: SharedReddit[] }) {
  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/40 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-zinc-800 flex items-baseline gap-3">
        <h2 className="text-[13px] font-medium text-zinc-100">Shared Reddit accounts</h2>
        <span className="text-[10.5px] uppercase tracking-wide text-zinc-500">{rows.length}</span>
        <span className="text-[11.5px] text-zinc-500 ml-auto">Same reddit_username verified on multiple Discord IDs.</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-5 text-[12.5px] text-zinc-500 italic">No workers tripping this signal.</p>
      ) : (
        <ul className="divide-y divide-zinc-800">
          {rows.map((r) => (
            <li key={r.reddit_username} className="px-4 py-3">
              <div className="flex items-baseline gap-3 mb-1.5">
                <span className="text-[13px] text-zinc-100 font-mono">u/{r.reddit_username}</span>
                <span className="text-[11px] text-zinc-500">used by {r.user_count} accounts</span>
              </div>
              <ul className="text-[12px] space-y-1 ml-2">
                {r.users.map((u) => (
                  <li key={u.id} className="flex items-center gap-2">
                    {u.flagged && <span className="text-red-400 text-[10px]">🚩</span>}
                    <span className="text-zinc-200">{u.username}</span>
                    <span className="font-mono text-zinc-500 text-[10.5px]">{u.discordId}</span>
                    <Link href={`/admin/workers/${u.id}`} className="text-emerald-400 hover:text-emerald-300 text-[11px] ml-auto">Profile →</Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DuplicateDestCard({ rows }: { rows: DuplicateDestination[] }) {
  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/40 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-zinc-800 flex items-baseline gap-3">
        <h2 className="text-[13px] font-medium text-zinc-100">Duplicate payment destinations</h2>
        <span className="text-[10.5px] uppercase tracking-wide text-zinc-500">{rows.length}</span>
        <span className="text-[11.5px] text-zinc-500 ml-auto">Same UPI, PayPal, or Crypto address on multiple Discord IDs.</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-5 text-[12.5px] text-zinc-500 italic">No workers tripping this signal.</p>
      ) : (
        <ul className="divide-y divide-zinc-800">
          {rows.map((r) => (
            <li key={r.destination} className="px-4 py-3">
              <div className="flex items-baseline gap-3 mb-1.5">
                <span className="text-[13px] text-zinc-100 font-mono">{r.destination}</span>
                <span className="text-[11px] text-zinc-500">used by {r.userCount} accounts</span>
              </div>
              <ul className="text-[12px] space-y-1 ml-2">
                {r.users.map((u) => (
                  <li key={u.id} className="flex items-center gap-2">
                    {u.flagged && <span className="text-red-400 text-[10px]">🚩</span>}
                    <span className="text-zinc-200">{u.username}</span>
                    <span className="font-mono text-zinc-500 text-[10.5px]">{u.discordId}</span>
                    <Link href={`/admin/workers/${u.id}`} className="text-emerald-400 hover:text-emerald-300 text-[11px] ml-auto">Profile →</Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UserCell({ user }: { user: UserRef }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] text-zinc-100 truncate">{user.discord_username}</span>
        {user.flagged && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30">flagged</span>}
        <span className="text-[10.5px] text-zinc-500">trust {user.trust_score}</span>
      </div>
      <p className="text-[10.5px] text-zinc-500 font-mono truncate">{user.discord_id}</p>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: "red" }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`text-[12.5px] font-mono ${accent === "red" ? "text-red-400" : "text-zinc-200"}`}>{value}</p>
    </div>
  );
}
