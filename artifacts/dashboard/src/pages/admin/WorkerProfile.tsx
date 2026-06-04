import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { get, post, del, patch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency, timeAgo, statusColor, cn } from "@/lib/utils";

interface ProfileUser {
  id: number;
  discordId: string;
  discordUsername: string;
  redditUsername: string | null;
  verified: boolean;
  trustScore: number;
  balanceAvailable: string;
  balancePending: string;
  totalEarned: string;
  flagged: boolean;
  isMod: boolean;
  isAdmin: boolean;
  createdAt: string;
  upiId: string | null;
  paypalEmail: string | null;
  cryptoWallets: Record<string, any> | null;
}
interface Stats {
  accepted: number; rejected: number; pending: number; total: number;
  lifetimeEarned: string; approvalRate: number; avgSubmitSeconds: number | null;
}
interface Profile {
  user: ProfileUser;
  stats: Stats;
  recentSubmissions: any[];
  recentClaims: any[];
  withdrawals: any[];
  rejectionReasons: { reason: string; count: number }[];
  taskBlocks: { task_id: number; task_title: string | null; reason: string; blocked_at: string }[];
}
interface Note { id: number; author_username: string; body: string; created_at: string; }
interface LinkedAccount { reddit_username: string; last_used_at: string | null; verified_at: string | null; }

function fmtSecs(secs: number | null): string {
  if (secs == null) return "—";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

function liveStatusBadge(status: string | null) {
  if (!status || status === "unchecked") return <span className="text-zinc-500 text-[10px]">—</span>;
  const map: Record<string, string> = {
    live: "emerald",
    removed: "amber",
    deleted: "red",
    pending: "amber",
  };
  return <Badge color={map[status] ?? "zinc"}>{status}</Badge>;
}

function CopyButton({ text }: { text: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      className="ml-1 px-1.5 py-0.5 rounded text-[9px] border border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition"
      title="Copy proof link"
    >
      {copied ? "✓" : "copy"}
    </button>
  );
}

export default function WorkerProfile() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id);
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin" || me?.role === "dev";

  const profile = useQuery({
    queryKey: ["worker-profile", id],
    queryFn: () => get<Profile>(`/admin/users/${id}/profile`),
    enabled: Number.isFinite(id),
  });
  const notesQ = useQuery({
    queryKey: ["worker-notes", id],
    queryFn: () => get<{ notes: Note[] }>(`/admin/users/${id}/notes`),
    enabled: Number.isFinite(id),
  });
  const linkedAccountsQ = useQuery({
    queryKey: ["linked-reddit", id],
    queryFn: () => get<{ accounts: LinkedAccount[] }>(`/admin/users/${id}/reddit-accounts`),
    enabled: Number.isFinite(id),
  });

  const [noteBody, setNoteBody] = useState("");
  const addNote = useMutation({
    mutationFn: (body: string) => post<Note>(`/admin/users/${id}/notes`, { body }),
    onSuccess: () => { setNoteBody(""); qc.invalidateQueries({ queryKey: ["worker-notes", id] }); },
  });
  const removeNote = useMutation({
    mutationFn: (noteId: number) => del(`/admin/users/notes/${noteId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["worker-notes", id] }),
  });
  // "Send Stats" — posts a fresh paginated stats card (last 21 days)
  // to the user's workspace channel. The user then flips pages with
  // the ◀/▶ buttons attached to the message. We don't poll for
  // delivery; the API returns ok=true as soon as Discord accepts the
  // message, and we surface that as a transient confirmation pill.
  const [sendStatsMsg, setSendStatsMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const sendStats = useMutation({
    mutationFn: () => post<{ ok: true; totalPages?: number; totalSubs?: number }>(
      `/admin/users/${id}/send-stats`,
      {},
    ),
    onSuccess: (data) => {
      const pages = data.totalPages ?? 1;
      const subs = data.totalSubs ?? 0;
      setSendStatsMsg({
        kind: "ok",
        text: pages > 1
          ? `✓ Sent ${subs} submissions across ${pages} pages — user can flip with ◀/▶`
          : `✓ Stats card posted to workspace channel`,
      });
      setTimeout(() => setSendStatsMsg(null), 6000);
    },
    onError: (err: Error) => {
      setSendStatsMsg({ kind: "err", text: `✗ ${err.message}` });
      setTimeout(() => setSendStatsMsg(null), 8000);
    },
  });
  const unlinkAccount = useMutation({
    mutationFn: ({ discordId, redditUsername }: { discordId: string; redditUsername: string }) =>
      del(`/admin/reddit-accounts/${discordId}/${encodeURIComponent(redditUsername)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["linked-reddit", id] });
      qc.invalidateQueries({ queryKey: ["worker-profile", id] });
    },
  });

  if (!Number.isFinite(id)) return <div className="p-7 text-red-400 text-[13px]">Invalid user id.</div>;
  if (profile.isLoading) return <div className="p-7 text-zinc-500 text-[13px]">Loading…</div>;
  if (profile.error) return <div className="p-7 text-red-400 text-[13px]">Failed: {(profile.error as Error).message}</div>;
  if (!profile.data) return null;

  const { user, stats, recentSubmissions, recentClaims, withdrawals, rejectionReasons, taskBlocks } = profile.data;

  const [showPaymentDialog, setShowPaymentDialog] = useState(false);

  return (
    <div className="p-5 sm:p-7 space-y-5 max-w-6xl">
      <div className="flex items-center gap-3">
        <Link href="/admin/users" className="text-[12.5px] text-zinc-500 hover:text-zinc-300">← Users</Link>
      </div>

      <div className="border border-zinc-800 rounded-md bg-zinc-900/40 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-zinc-100 truncate">{user.discordUsername}</h1>
            <p className="text-[12px] text-zinc-500 font-mono mt-0.5">{user.discordId}</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {user.verified && <Badge color="emerald">verified</Badge>}
              {user.flagged && <Badge color="red">flagged</Badge>}
              {user.isMod && <Badge color="violet">mod</Badge>}
              {user.isAdmin && <Badge color="amber">admin</Badge>}
              {user.redditUsername && <span className="text-[11px] text-zinc-400">u/{user.redditUsername}</span>}
              <span className="text-[11px] text-zinc-500">joined {timeAgo(user.createdAt)}</span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="text-right">
              <p className="text-[10.5px] uppercase tracking-wide text-zinc-500">Trust score</p>
              <p className="text-[22px] font-semibold text-zinc-100">{user.trustScore}</p>
            </div>
            {isAdmin && (
              <>
                <button
                  onClick={() => sendStats.mutate()}
                  disabled={sendStats.isPending}
                  className="px-3 py-1.5 rounded-md text-[12px] font-medium border border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700 hover:border-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  title="Post a paginated stats card (last 21 days) to this user's workspace channel"
                >
                  {sendStats.isPending ? "Sending…" : "📊 Send Stats"}
                </button>
                {sendStatsMsg && (
                  <p className={cn(
                    "text-[11px] max-w-[260px] text-right",
                    sendStatsMsg.kind === "ok" ? "text-emerald-400" : "text-red-400",
                  )}>
                    {sendStatsMsg.text}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Stat label="Lifetime earned" value={formatCurrency(stats.lifetimeEarned)} accent="emerald" />
        <Stat label="Balance available" value={formatCurrency(user.balanceAvailable)} />
        <Stat label="Approval rate" value={`${stats.approvalRate}%`} accent={stats.approvalRate >= 80 ? "emerald" : stats.approvalRate < 50 ? "red" : undefined} />
        <Stat label="Avg time-to-submit" value={fmtSecs(stats.avgSubmitSeconds)} />
        <Stat label="Accepted" value={String(stats.accepted)} accent="emerald" />
        <Stat label="Rejected" value={String(stats.rejected)} accent="red" />
        <Stat label="Pending" value={String(stats.pending)} />
        <Stat label="Total subs" value={String(stats.total)} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* ── Submissions ───────────────────────────────────────────── */}
        <Card title="Recent submissions" wide>
          {recentSubmissions.length === 0 ? <Empty msg="No submissions yet." /> : (
            <ul className="divide-y divide-zinc-800 text-[12px]">
              {recentSubmissions.map((s) => (
                <li key={s.id} className="px-4 py-2.5 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-zinc-300 font-medium truncate max-w-[220px]">#{s.task_id} {s.task_title ?? "—"}</span>
                    <Badge color={statusColor(s.review_status) as any}>{s.review_status}</Badge>
                    {liveStatusBadge(s.live_status)}
                    <span className="font-mono text-emerald-300 ml-auto">{formatCurrency(s.reward)}</span>
                  </div>
                  {(s.campaign_title || s.campaign_creator) && (
                    <p className="text-zinc-500 text-[10.5px]">
                      Campaign: <span className="text-zinc-400">{s.campaign_title ?? "—"}</span>
                      {s.campaign_creator && (
                        <span className="ml-2 text-zinc-600">
                          by {s.campaign_creator.startsWith("dashboard:") ? s.campaign_creator.replace("dashboard:", "") : `<@${s.campaign_creator}>`}
                        </span>
                      )}
                    </p>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-zinc-600">{timeAgo(s.submitted_at)}</span>
                    {s.proof_link && (
                      <span className="flex items-center gap-0.5">
                        <a href={s.proof_link} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline text-[10.5px] truncate max-w-[180px]">
                          {s.proof_link}
                        </a>
                        <CopyButton text={s.proof_link} />
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ── Withdrawals ───────────────────────────────────────────── */}
        <Card title="Withdrawals">
          {withdrawals.length === 0 ? <Empty msg="No withdrawals yet." /> :
            <Table rows={withdrawals.map((w) => ({
              key: w.id,
              cells: [
                <span className="font-mono">#{w.id}</span>,
                <span className="font-mono text-emerald-300">{formatCurrency(w.amount)}</span>,
                <span className="text-zinc-400">{w.method}</span>,
                <Badge color={statusColor(w.status) as any}>{w.status}</Badge>,
                <span className="text-zinc-500">{timeAgo(w.requested_at)}</span>,
              ],
            }))} />
          }
        </Card>

        {/* ── Recent claims ─────────────────────────────────────────── */}
        <Card title="Recent claims">
          {recentClaims.length === 0 ? <Empty msg="No claims yet." /> :
            <Table rows={recentClaims.map((c) => ({
              key: c.id,
              cells: [
                <span className="truncate block max-w-[200px]">#{c.task_id} {c.task_title ?? "—"}</span>,
                <Badge color={c.status === "expired" ? "red" : c.status === "claimed" ? "amber" : "emerald"}>{c.status}</Badge>,
                <span className="text-zinc-500">{timeAgo(c.claimed_at)}</span>,
              ],
            }))} />
          }
        </Card>

        {/* ── Rejection reasons ─────────────────────────────────────── */}
        <Card title="Rejection reasons (top 10)">
          {rejectionReasons.length === 0 ? <Empty msg="No rejections — nice." /> :
            <ul className="text-[12.5px] text-zinc-300 divide-y divide-zinc-800">
              {rejectionReasons.map((r, i) => (
                <li key={i} className="px-4 py-2 flex items-start gap-3">
                  <span className="text-zinc-500 font-mono shrink-0">×{r.count}</span>
                  <span className="break-words">{r.reason}</span>
                </li>
              ))}
            </ul>
          }
        </Card>

        {/* ── Linked Reddit accounts ────────────────────────────────── */}
        <Card title="Linked Reddit accounts">
          {linkedAccountsQ.isLoading ? <Empty msg="Loading…" /> :
            linkedAccountsQ.isError ? (
              <p className="px-4 py-3 text-[11.5px] text-red-400">
                Failed to load linked accounts: {(linkedAccountsQ.error as Error)?.message ?? "unknown error"}
              </p>
            ) :
            (linkedAccountsQ.data?.accounts ?? []).length === 0 ? <Empty msg="No linked accounts." /> :
            <ul className="divide-y divide-zinc-800 text-[12.5px]">
              {(linkedAccountsQ.data?.accounts ?? []).map((acc) => (
                <li key={acc.reddit_username} className="px-4 py-2.5 flex items-center gap-3">
                  <span className="flex-1 text-zinc-200 font-medium">u/{acc.reddit_username}</span>
                  <span className="text-zinc-500 text-[11px]">
                    {acc.last_used_at ? `last used ${timeAgo(acc.last_used_at)}` : "never used"}
                  </span>
                  {isAdmin && (
                    <button
                      onClick={() => {
                        if (!confirm(`Unlink u/${acc.reddit_username} from this user? If it's their last account, they'll be unverified.`)) return;
                        unlinkAccount.mutate({ discordId: user.discordId, redditUsername: acc.reddit_username });
                      }}
                      disabled={unlinkAccount.isPending}
                      className="px-2 py-1 rounded text-[10px] border border-red-800/50 text-red-400 hover:bg-red-900/20 disabled:opacity-40 transition"
                    >
                      Unlink
                    </button>
                  )}
                </li>
              ))}
            </ul>
          }
          {unlinkAccount.isError && (
            <p className="px-4 pb-2 text-[11px] text-red-400">{(unlinkAccount.error as Error).message}</p>
          )}
        </Card>

        {/* ── Payment Methods ────────────────────────────────────────── */}
        <Card title="Payment Methods">
          <div className="p-4 space-y-3 text-[12.5px]">
            <div className="flex justify-between items-start border-b border-zinc-800 pb-2">
              <span className="text-zinc-500">PayPal</span>
              <span className="text-zinc-200">{user.paypalEmail || "—"}</span>
            </div>
            <div className="flex justify-between items-start border-b border-zinc-800 pb-2">
              <span className="text-zinc-500">UPI ID</span>
              <span className="text-zinc-200">{user.upiId || "—"}</span>
            </div>
            <div className="flex justify-between items-start pb-1">
              <span className="text-zinc-500">Crypto</span>
              <div className="text-right">
                {user.cryptoWallets && Object.keys(user.cryptoWallets).length > 0 ? (
                  <pre className="text-[10px] text-zinc-300 bg-zinc-950 p-2 rounded border border-zinc-800">
                    {JSON.stringify(user.cryptoWallets, null, 2)}
                  </pre>
                ) : (
                  <span className="text-zinc-500">—</span>
                )}
              </div>
            </div>
            {isAdmin && (
              <div className="pt-2">
                <button
                  onClick={() => setShowPaymentDialog(true)}
                  className="w-full py-1.5 rounded text-[11px] font-medium border border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition"
                >
                  Edit Payments
                </button>
              </div>
            )}
          </div>
        </Card>

        {taskBlocks.length > 0 && (
          <Card title="Re-claim blocks">
            <Table rows={taskBlocks.map((b) => ({
              key: `${b.task_id}-${b.blocked_at}`,
              cells: [
                <span className="truncate block max-w-[200px]">#{b.task_id} {b.task_title ?? "—"}</span>,
                <span className="text-zinc-400 text-[11px]">{b.reason}</span>,
                <span className="text-zinc-500">{timeAgo(b.blocked_at)}</span>,
              ],
            }))} />
          </Card>
        )}

        {/* ── Admin notes ───────────────────────────────────────────── */}
        <Card title="Admin notes" wide={taskBlocks.length === 0}>
          <div className="p-3 space-y-2">
            <textarea
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              placeholder="Add a note about this worker…"
              maxLength={4000}
              rows={2}
              className="w-full px-3 py-2 rounded-md bg-zinc-950 border border-zinc-800 text-[13px] text-zinc-100 focus:outline-none focus:border-zinc-600"
            />
            <div className="flex justify-between items-center">
              <span className="text-[10.5px] text-zinc-600">{noteBody.length}/4000</span>
              <button
                onClick={() => noteBody.trim() && addNote.mutate(noteBody.trim())}
                disabled={!noteBody.trim() || addNote.isPending}
                className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-[12px] text-white font-medium"
              >{addNote.isPending ? "Saving…" : "Add note"}</button>
            </div>
            {addNote.error && <p className="text-[11.5px] text-red-400">{(addNote.error as Error).message}</p>}
          </div>
          <div className="border-t border-zinc-800">
            {notesQ.isLoading ? <Empty msg="Loading…" /> :
              (notesQ.data?.notes ?? []).length === 0 ? <Empty msg="No notes yet." /> :
              <ul className="divide-y divide-zinc-800">
                {(notesQ.data?.notes ?? []).map((n) => (
                  <li key={n.id} className="px-4 py-3">
                    <p className="text-[12.5px] text-zinc-200 whitespace-pre-wrap break-words">{n.body}</p>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <p className="text-[10.5px] text-zinc-500">by {n.author_username} · {timeAgo(n.created_at)}</p>
                      {isAdmin && (
                        <button
                          onClick={() => { if (confirm("Delete this note?")) removeNote.mutate(n.id); }}
                          className="text-[10.5px] text-zinc-600 hover:text-red-400"
                        >delete</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            }
          </div>
        </Card>
      </div>

      <EditPaymentDialog
        user={user}
        open={showPaymentDialog}
        onOpenChange={setShowPaymentDialog}
        onSaved={() => qc.invalidateQueries({ queryKey: ["worker-profile", id] })}
      />
    </div>
  );
}

function EditPaymentDialog({
  user,
  open,
  onOpenChange,
  onSaved,
}: {
  user: ProfileUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [paypalEmail, setPaypalEmail] = useState(user.paypalEmail ?? "");
  const [upiId, setUpiId] = useState(user.upiId ?? "");
  const [cryptoJson, setCryptoJson] = useState(() => JSON.stringify(user.cryptoWallets ?? {}, null, 2));
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      let parsedCrypto: Record<string, any> | null = null;
      if (cryptoJson.trim()) {
        try {
          parsedCrypto = JSON.parse(cryptoJson);
        } catch (e: any) {
          throw new Error("Invalid JSON in Crypto Wallets field.");
        }
      }
      return patch(`/admin/users/${user.id}`, {
        paypalEmail: paypalEmail.trim() || null,
        upiId: upiId.trim() || null,
        cryptoWallets: parsedCrypto,
      });
    },
    onSuccess: () => {
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setErrorMsg(err.message);
    },
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h2 className="font-semibold text-zinc-100">Edit Payment Methods</h2>
          <button onClick={() => onOpenChange(false)} className="text-zinc-500 hover:text-zinc-300">✕</button>
        </div>
        <div className="p-5 overflow-y-auto flex-1 space-y-4 text-sm">
          {errorMsg && <div className="text-red-400 text-xs">{errorMsg}</div>}
          
          <div className="space-y-1">
            <label className="text-xs text-zinc-400 font-medium uppercase tracking-wide">PayPal Email</label>
            <input
              type="email"
              value={paypalEmail}
              onChange={(e) => setPaypalEmail(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-500"
              placeholder="e.g. email@domain.com"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-zinc-400 font-medium uppercase tracking-wide">UPI ID</label>
            <input
              type="text"
              value={upiId}
              onChange={(e) => setUpiId(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-zinc-100 focus:outline-none focus:border-zinc-500"
              placeholder="e.g. username@bank"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-zinc-400 font-medium uppercase tracking-wide">Crypto Wallets (JSON)</label>
            <textarea
              value={cryptoJson}
              onChange={(e) => setCryptoJson(e.target.value)}
              rows={6}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-zinc-100 font-mono text-xs focus:outline-none focus:border-zinc-500"
            />
          </div>
        </div>
        <div className="px-5 py-4 border-t border-zinc-800 bg-zinc-900/50 flex justify-end gap-2">
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 rounded text-zinc-300 hover:bg-zinc-800 transition"
          >
            Cancel
          </button>
          <button
            onClick={() => { setErrorMsg(null); save.mutate(); }}
            disabled={save.isPending}
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={cn("border border-zinc-800 rounded-md bg-zinc-900/40 overflow-hidden", wide && "lg:col-span-2")}>
      <p className="px-4 py-2.5 text-[11px] uppercase tracking-wide text-zinc-500 font-medium border-b border-zinc-800">{title}</p>
      {children}
    </div>
  );
}
function Stat({ label, value, accent }: { label: string; value: string; accent?: "emerald" | "red" }) {
  const color = accent === "emerald" ? "text-emerald-300" : accent === "red" ? "text-red-400" : "text-zinc-100";
  return (
    <div className="border border-zinc-800 rounded-md bg-zinc-900/40 px-3.5 py-3">
      <p className="text-[10.5px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-[18px] font-semibold ${color}`}>{value}</p>
    </div>
  );
}
function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  const cls: Record<string, string> = {
    emerald: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    red: "bg-red-500/10 text-red-400 border-red-500/30",
    amber: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    violet: "bg-violet-500/10 text-violet-300 border-violet-500/30",
    zinc: "bg-zinc-800 text-zinc-400 border-zinc-700",
    blue: "bg-blue-500/10 text-blue-300 border-blue-500/30",
  };
  return <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide border ${cls[color] ?? cls.zinc}`}>{children}</span>;
}
function Empty({ msg }: { msg: string }) {
  return <p className="px-4 py-6 text-[12px] text-zinc-500 text-center italic">{msg}</p>;
}
function Table({ rows }: { rows: { key: any; cells: React.ReactNode[] }[] }) {
  return (
    <ul className="divide-y divide-zinc-800 text-[12.5px]">
      {rows.map((r) => (
        <li key={r.key} className="px-4 py-2 flex items-center gap-3 text-zinc-300">
          {r.cells.map((c, i) => <span key={i} className={i === 0 ? "flex-1 min-w-0" : "shrink-0"}>{c}</span>)}
        </li>
      ))}
    </ul>
  );
}
