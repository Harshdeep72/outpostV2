import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";

// A wallet entry can be the legacy string format (just an address — saved
// before /setwallet asked for a network) or the new object format with
// { address, network }. UI handles both.
type WalletEntry = string | { address?: string; network?: string | null } | null | undefined;

interface CryptoWallets {
  USDT?: WalletEntry;
  BINANCE?: WalletEntry;
  ETH?: WalletEntry;
  BTC?: WalletEntry;
  [key: string]: WalletEntry;
}

function normalizeWalletEntry(v: WalletEntry): { address: string; network: string | null } | null {
  if (typeof v === "string") {
    const a = v.trim();
    return a.length > 0 ? { address: a, network: null } : null;
  }
  if (v && typeof v === "object" && typeof v.address === "string" && v.address.trim().length > 0) {
    return {
      address: v.address.trim(),
      network: typeof v.network === "string" && v.network.length > 0 ? v.network : null,
    };
  }
  return null;
}

interface PaymentUser {
  id: number;
  discordId: string;
  discordUsername: string;
  redditUsername: string | null;
  verified: boolean;
  flagged: boolean;
  upiId: string | null;
  paypalEmail: string | null;
  cryptoWallets: CryptoWallets | null;
  createdAt: string;
}

interface PaymentListResponse {
  users: PaymentUser[];
  total: number;
  page: number;
  limit: number;
}

type MethodFilter = "all" | "upi" | "paypal" | "crypto";

const METHOD_TABS: { key: MethodFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "upi", label: "UPI" },
  { key: "paypal", label: "PayPal" },
  { key: "crypto", label: "Crypto" },
];

function CopyChip({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* ignore */
        }
      }}
      className="group inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-zinc-800 bg-zinc-900/60 hover:bg-zinc-900 text-[11px] font-mono text-zinc-200"
      title="Click to copy"
    >
      {label && <span className="text-zinc-500 not-italic">{label}</span>}
      <span className="truncate max-w-[200px]">{value}</span>
      <span className="text-[9px] uppercase tracking-wider text-zinc-500 group-hover:text-zinc-300">
        {copied ? "✓" : "copy"}
      </span>
    </button>
  );
}

function CryptoCell({ wallets }: { wallets: CryptoWallets | null }) {
  if (!wallets) return <span className="text-muted-foreground">—</span>;
  const entries = Object.entries(wallets)
    .map(([k, v]) => [k, normalizeWalletEntry(v as WalletEntry)] as const)
    .filter((pair): pair is readonly [string, { address: string; network: string | null }] => pair[1] !== null);
  if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([k, w]) => (
        <CopyChip
          key={k}
          label={w.network ? `${k} (${w.network})` : k}
          value={w.address}
        />
      ))}
    </div>
  );
}

export default function PaymentMethods() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [method, setMethod] = useState<MethodFilter>("all");

  const limit = 25;
  const { data, isLoading, isError, error } = useQuery<PaymentListResponse>({
    queryKey: ["admin-payment-methods", page, search, method],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (search) params.set("search", search);
      if (method !== "all") params.set("method", method);
      return get<PaymentListResponse>(`/admin/payment-methods?${params}`);
    },
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            Payment Methods
            <span className="text-xs font-medium text-blue-300 bg-blue-400/10 border border-blue-400/20 px-2 py-0.5 rounded-full">
              /setupi · /setpaypal · /setwallet
            </span>
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {data ? `${data.total} users have a payment method set` : "Loading..."}
          </p>
        </div>
        <div className="sm:ml-auto flex items-center gap-2">
          <input
            type="search"
            placeholder="Search username, UPI or PayPal..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="px-3 py-2 rounded-lg bg-card border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring w-72"
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {METHOD_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => { setMethod(t.key); setPage(1); }}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
              method === t.key
                ? "bg-zinc-100 text-zinc-900 border-zinc-100"
                : "bg-transparent text-zinc-400 border-zinc-800 hover:bg-zinc-900 hover:text-zinc-100"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {(error as Error)?.message ?? "Failed to load payment methods."}
        </div>
      )}

      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                {["Discord", "Reddit", "UPI", "PayPal", "Crypto / Binance", "Updated"].map((h, i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-border/50 animate-pulse">
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 bg-secondary rounded w-24" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : data?.users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    {search
                      ? `No users matching "${search}".`
                      : method === "all"
                      ? "No users have set a payment method yet."
                      : `No users have a ${method.toUpperCase()} payment method set.`}
                  </td>
                </tr>
              ) : (
                data?.users.map(u => (
                  <tr
                    key={u.id}
                    className={cn(
                      "border-b border-border/50 hover:bg-secondary/30 transition-colors align-top",
                      u.flagged && "bg-destructive/5"
                    )}
                  >
                    <td className="px-4 py-3 text-foreground">
                      <div className="flex items-center gap-2">
                        {u.flagged && <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" title="Flagged" />}
                        <span className="truncate max-w-[160px] font-medium">{u.discordUsername}</span>
                        {u.verified && (
                          <span className="text-[9px] uppercase tracking-wider text-green-300 bg-green-400/10 border border-green-400/20 px-1 py-0.5 rounded">
                            ✓
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-0.5 font-mono">{u.discordId}</div>
                    </td>
                    <td className="px-4 py-3">
                      {u.redditUsername ? (
                        <a
                          href={`https://reddit.com/u/${u.redditUsername}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline text-xs"
                        >
                          u/{u.redditUsername}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {u.upiId ? (
                        <CopyChip value={u.upiId} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {u.paypalEmail ? (
                        <CopyChip value={u.paypalEmail} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <CryptoCell wallets={u.cryptoWallets} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                      {timeAgo(u.createdAt)}
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
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed text-foreground transition-colors"
            >
              Prev
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className="px-3 py-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed text-foreground transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
