import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { get, patch, post, put } from "@/lib/api";

interface CooldownConfig {
  enabled: boolean;
  minutes: number;
}

const PRESETS: { label: string; minutes: number }[] = [
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
  { label: "4 hours", minutes: 240 },
  { label: "8 hours", minutes: 480 },
  { label: "24 hours", minutes: 1440 },
];

export default function Settings() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery<CooldownConfig>({
    queryKey: ["admin-settings-cooldown"],
    queryFn: () => get<CooldownConfig>("/admin/settings/cooldown"),
    // The API server (Render) sometimes lags behind a dashboard deploy by
    // a minute or two right after a release. Retry a few times so the page
    // self-heals once the new route is live.
    retry: 4,
    retryDelay: (attempt) => Math.min(15_000, 2000 * 2 ** attempt),
  });

  const [enabled, setEnabled] = useState(true);
  const [minutes, setMinutes] = useState("240");
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setMinutes(String(data.minutes));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      patch<CooldownConfig>("/admin/settings/cooldown", {
        enabled,
        minutes: parseInt(minutes),
      }),
    onSuccess: (next) => {
      qc.setQueryData(["admin-settings-cooldown"], next);
      setSavedAt(Date.now());
    },
  });

  const minutesNum = parseInt(minutes);
  const hoursLabel = Number.isFinite(minutesNum)
    ? minutesNum >= 60
      ? `${(minutesNum / 60).toFixed(minutesNum % 60 === 0 ? 0 : 1)} hour${minutesNum >= 120 ? "s" : ""}`
      : `${minutesNum} min`
    : "—";

  if (isLoading) {
    return (
      <div className="p-6 max-w-2xl">
        <div className="animate-pulse rounded-xl border border-border bg-card p-6 h-48" />
      </div>
    );
  }

  if (error) {
    const msg = (error as Error).message;
    const looks404 = /404|not.?found/i.test(msg);
    return (
      <div className="p-6 max-w-2xl space-y-4">
        <header>
          <h1 className="text-2xl font-bold">Settings</h1>
        </header>
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 p-4 text-sm space-y-3">
          <div className="font-semibold">
            {looks404 ? "Settings endpoint not available yet" : "Couldn't load settings"}
          </div>
          <p className="text-amber-100/80">
            {looks404 ? (
              <>
                The dashboard was updated but the bot/API server hasn't
                finished its deploy yet. Wait ~1–2 minutes, then click
                <strong> Retry</strong>. Nothing on the bot is broken — this
                page just needs the new <code>/api/admin/settings/cooldown</code>
                route which ships with the next API redeploy.
              </>
            ) : (
              <>Error from server: <code>{msg}</code></>
            )}
          </p>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="px-3 py-1.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-100 text-xs font-medium disabled:opacity-50"
          >
            {isFetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Global rules that apply to every task. Per-task overrides set in Create
          Task / Bulk Tasks take priority over these defaults.
        </p>
      </header>

      <GoogleSheetsSection />

      <MaxRedditAccountsSection />

      <section className="rounded-xl border border-border bg-card p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold">Task Cooldown</h2>
          <p className="text-sm text-muted-foreground mt-1">
            How long a worker must wait between submitting one task and claiming
            the next. For Reddit tasks the cooldown applies <strong>per Reddit
            account</strong> — a user with 3 linked accounts can keep working as
            long as one account is off cooldown.
          </p>
        </div>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-input"
          />
          <span className="text-sm">
            <span className="font-medium text-foreground">Cooldown enabled</span>
            <span className="block text-muted-foreground mt-0.5">
              When off, no task cooldown is enforced (other limits like 1 active
              claim still apply). Useful for special drops or testing.
            </span>
          </span>
        </label>

        <div className={enabled ? "" : "opacity-50 pointer-events-none"}>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            Cooldown duration (minutes)
          </label>
          <input
            type="number"
            min={0}
            max={60 * 24 * 30}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg bg-background border border-input text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.minutes}
                type="button"
                onClick={() => setMinutes(String(p.minutes))}
                className="text-xs px-2.5 py-1 rounded-md border border-border bg-background hover:bg-secondary transition"
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Currently: <strong>{hoursLabel}</strong>
          </p>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border">
          <div className="text-xs text-muted-foreground">
            {savedAt ? (
              <span className="text-green-500">
                Saved {new Date(savedAt).toLocaleTimeString()}
              </span>
            ) : (
              "Changes apply within ~30 seconds of saving"
            )}
          </div>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>

        {save.isError && (
          <div className="rounded-lg border border-destructive bg-destructive/10 text-destructive p-3 text-sm">
            {(save.error as Error).message}
          </div>
        )}
      </section>

      <AutoBumpSection />

      <ProxiesSection />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Sheets connection — operator's own Google account (via OAuth).
// Replaces the broken service-account path on personal-Gmail Cloud projects.
// Connecting uses your own 15 GB Drive quota, no subscription needed.
// ─────────────────────────────────────────────────────────────────────────────
interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
}

function googleConnectUrl(): string {
  const raw = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
  const base = raw ? `${raw}/api` : "/api";
  return `${base}/admin/google/oauth/start`;
}

function GoogleSheetsSection() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery<GoogleStatus>({
    queryKey: ["admin-google-status"],
    queryFn: () => get<GoogleStatus>("/admin/google/status"),
    retry: 2,
  });
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // After OAuth callback redirects back with ?google=connected, refresh status.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("google") === "connected") {
      refetch();
      setSavedAt(Date.now());
      params.delete("google");
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? `?${qs}` : "");
      window.history.replaceState({}, "", newUrl);
    }
  }, [refetch]);

  const disconnect = useMutation({
    mutationFn: () => post<{ ok: boolean }>("/admin/google/disconnect", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-google-status"] });
      setSavedAt(Date.now());
    },
  });

  return (
    <section className="rounded-xl border border-border bg-card p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold">Google Sheets</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your Google account once and the bot will create campaign
          sheets in <strong>your own Drive</strong> (15 GB free) — no Workspace
          subscription, no service-account hassles. Every submission auto-fills
          into the campaign's sheet.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {!isLoading && !error && data && (
        <>
          {!data.configured && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 p-3 text-xs">
              Operator setup pending: <code>GOOGLE_OAUTH_CLIENT_ID</code> and{" "}
              <code>GOOGLE_OAUTH_CLIENT_SECRET</code> env vars are not set on the
              API server. Add them on Render and redeploy to enable this button.
            </div>
          )}

          {data.configured && data.connected && (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 p-3 text-sm flex items-center gap-3">
              <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  Connected as <span className="font-mono break-all">{data.email || "(unknown)"}</span>
                </p>
                {data.connectedAt && (
                  <p className="text-xs text-emerald-300/80 mt-0.5">
                    Linked {new Date(data.connectedAt).toLocaleDateString()}
                  </p>
                )}
              </div>
            </div>
          )}

          {data.configured && !data.connected && (
            <div className="rounded-lg border border-zinc-700 bg-zinc-900/50 p-3 text-sm text-zinc-300">
              Not connected yet. New campaign sheets will fail to create until
              you connect a Google account.
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
            {data.configured && (
              <a
                href={googleConnectUrl()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition"
                title={data.connected ? "Re-connect with a different Google account" : "Connect your Google account"}
              >
                <svg className="w-4 h-4" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
                  <path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
                  <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
                  <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
                </svg>
                {data.connected ? "Re-connect Google" : "Connect Google"}
              </a>
            )}
            {data.connected && (
              <button
                type="button"
                onClick={() => {
                  if (confirm("Disconnect this Google account? New campaign sheets won't be creatable until you connect again. Existing sheets stay in your Drive.")) {
                    disconnect.mutate();
                  }
                }}
                disabled={disconnect.isPending}
                className="px-3 py-2 rounded-lg border border-border bg-background text-sm font-medium text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
              >
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </button>
            )}
            <div className="ml-auto text-xs text-muted-foreground">
              {savedAt && <span className="text-green-500">Updated {new Date(savedAt).toLocaleTimeString()}</span>}
            </div>
          </div>

          {disconnect.isError && (
            <div className="rounded-lg border border-destructive bg-destructive/10 text-destructive p-3 text-xs">
              {(disconnect.error as Error).message}
            </div>
          )}

          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer hover:text-zinc-300">How does this work?</summary>
            <div className="mt-2 space-y-2 pl-4 border-l border-border">
              <p>
                When you click "Connect Google", you'll be sent to Google's
                consent screen. Approve once and the bot gets permission to
                create &amp; edit only the sheets it creates (drive.file scope —
                it cannot read any of your other files).
              </p>
              <p>
                After that, "Create Sheet" on any campaign builds a brand-new
                Google Sheet in <strong>your</strong> Drive (15 GB free) instead
                of the service-account path that fails on personal Gmail.
              </p>
              <p>
                You only need to connect once — Google issues a long-lived
                refresh token that the bot stores securely. Disconnect any time
                from this page or at{" "}
                <a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer" className="underline">
                  myaccount.google.com/connections
                </a>.
              </p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function MaxRedditAccountsSection() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<{ max: number }>({
    queryKey: ["admin-settings-max-reddit"],
    queryFn: () => get<{ max: number }>("/admin/settings/max-reddit-accounts"),
    retry: 2,
  });
  const [max, setMax] = useState("3");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => { if (data) setMax(String(data.max)); }, [data]);

  const save = useMutation({
    mutationFn: () => patch<{ max: number }>("/admin/settings/max-reddit-accounts", { max: parseInt(max) }),
    onSuccess: (next) => { qc.setQueryData(["admin-settings-max-reddit"], next); setSavedAt(Date.now()); },
  });

  return (
    <section className="rounded-xl border border-border bg-card p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold">Max Reddit Accounts per User</h2>
        <p className="text-sm text-muted-foreground mt-1">
          How many Reddit accounts a single Discord user can link. When you lower this number,
          existing linked accounts are <strong>not</strong> removed — it only prevents new links above the limit.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {!isLoading && !error && (
        <>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">
              Maximum accounts (1–20)
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={max}
              onChange={(e) => setMax(e.target.value)}
              className="w-32 px-3 py-2.5 rounded-lg bg-background border border-input text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground mt-1.5">
              Currently: <strong>{data?.max ?? "—"}</strong> account{(data?.max ?? 1) !== 1 ? "s" : ""} per user
            </p>
          </div>
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div className="text-xs text-muted-foreground">
              {savedAt ? <span className="text-green-500">Saved {new Date(savedAt).toLocaleTimeString()}</span> : "Takes effect immediately"}
            </div>
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || parseInt(max) === (data?.max ?? 3)}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
          {save.isError && (
            <div className="rounded-lg border border-destructive bg-destructive/10 text-destructive p-3 text-sm">
              {(save.error as Error).message}
            </div>
          )}
        </>
      )}
    </section>
  );
}

interface AutoBumpConfig { enabled: boolean }

function AutoBumpSection() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<AutoBumpConfig>({
    queryKey: ["admin-settings-auto-bump"],
    queryFn: () => get<AutoBumpConfig>("/admin/settings/auto-bump"),
    retry: 2,
  });
  const [enabled, setEnabled] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => { if (data) setEnabled(data.enabled); }, [data]);

  const save = useMutation({
    mutationFn: () => patch<AutoBumpConfig>("/admin/settings/auto-bump", { enabled }),
    onSuccess: (next) => {
      qc.setQueryData(["admin-settings-auto-bump"], next);
      setSavedAt(Date.now());
    },
  });

  return (
    <section className="rounded-xl border border-border bg-card p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold">Auto-Bump (Dutch auction)</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Master switch for the reward auto-bumper. When ON, unclaimed tasks
          with per-task auto-bump configured will have their reward gradually
          raised until claimed (capped). When OFF, the cron is fully dormant
          and no task is ever bumped — safe default.
        </p>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {!isLoading && !error && (
        <>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-input"
            />
            <span className="text-sm">
              <span className="font-medium text-foreground">Auto-bump enabled</span>
              <span className="block text-muted-foreground mt-0.5">
                Off by default. Even when ON, only tasks you explicitly
                configured via the per-task auto-bump endpoint will be bumped.
              </span>
            </span>
          </label>

          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div className="text-xs text-muted-foreground">
              {savedAt ? (
                <span className="text-green-500">Saved {new Date(savedAt).toLocaleTimeString()}</span>
              ) : (
                "Changes apply within ~30 seconds of saving"
              )}
            </div>
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || enabled === (data?.enabled ?? false)}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>

          {save.isError && (
            <div className="rounded-lg border border-destructive bg-destructive/10 text-destructive p-3 text-sm">
              {(save.error as Error).message}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxy list — HTTP/SOCKS proxies the bot rotates through when hitting
// Reddit's public API. Stored in DB (not file) because Render's filesystem
// is ephemeral. One proxy per line. Format: user:pass@host:port (or full
// http://… / socks5://… URI). Empty = direct connection (no rotation).
// ─────────────────────────────────────────────────────────────────────────────
interface ProxyMetrics {
  proxy: { total: number; successes: number; failures: number; successRate: number; avgLatencyMs: number };
  direct: { total: number; successes: number; failures: number; successRate: number; avgLatencyMs: number };
  proxyCount: number;
}
interface ProxiesResponse { list: string[]; metrics: ProxyMetrics }

function ProxiesSection() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<ProxiesResponse>({
    queryKey: ["admin-settings-proxies"],
    queryFn: () => get<ProxiesResponse>("/admin/settings/proxies"),
    retry: 2,
    refetchInterval: 15_000,
  });

  const [text, setText] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [uploadInfo, setUploadInfo] = useState<string | null>(null);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  // File upload — accepts ANY text file (.txt, .csv, no extension, anything).
  // We don't validate the filename or extension; we just try to read it as
  // UTF-8 text and dump it into the textarea. Operator clicks Save after.
  // Size cap: 1 MB (sane limit, ~30k proxy lines max — way over our 500 cap).
  async function handleFile(file: File) {
    setUploadErr(null);
    setUploadInfo(null);
    if (file.size > 1_000_000) {
      setUploadErr(`File too large (${(file.size / 1024).toFixed(0)} KB). Max 1 MB.`);
      return;
    }
    let content: string;
    try {
      // Use TextDecoder with fatal:true so binary files (PDF, images, zips)
      // throw instead of silently producing replacement-char garbage that
      // Blob.text() would let through.
      const buf = await file.arrayBuffer();
      content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      setUploadErr(`"${file.name}" doesn't look like a text file. Open it in a text editor and paste the contents instead.`);
      return;
    }
    // Extra sanity check: count lines that look proxy-shaped. If a "text"
    // file has zero proxy-like lines (e.g. random log file), warn the
    // operator but still load it — they can clean up in the textarea.
    const allLines = content.split(/\r?\n/);
    const proxyLikeLines = allLines.filter((l) => {
      const t = l.trim();
      if (!t || t.startsWith("#")) return false;
      // crude proxy shape: must contain ":" (host:port or user:pass@host:port)
      return t.includes(":");
    }).length;

    if (proxyLikeLines === 0) {
      setUploadErr(`"${file.name}" has no lines that look like proxies (need "host:port" or "user:pass@host:port"). Nothing was loaded.`);
      return;
    }

    // Append to existing text if there's already content, else replace.
    // This lets the operator merge multiple files (e.g. Webshare + IPRoyal).
    const trimmed = text.trim();
    const next = trimmed.length > 0
      ? `${trimmed}\n${content.trim()}`
      : content.trim();
    setText(next);
    setUploadInfo(`Loaded ${proxyLikeLines} proxy line${proxyLikeLines === 1 ? "" : "s"} from "${file.name}". Click Save to apply.`);
  }

  // Hydrate textarea from server, but only when user hasn't started editing
  // (we detect this by checking if text matches the previously-loaded list).
  const [hydratedFrom, setHydratedFrom] = useState<string | null>(null);
  useEffect(() => {
    if (data) {
      const joined = data.list.join("\n");
      if (hydratedFrom === null || text === hydratedFrom) {
        setText(joined);
        setHydratedFrom(joined);
      }
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () =>
      put<{ list: string[]; loadedCount: number; metrics: ProxyMetrics }>(
        "/admin/settings/proxies",
        { list: text.split(/\r?\n/) }
      ),
    onSuccess: (next) => {
      qc.setQueryData(["admin-settings-proxies"], { list: next.list, metrics: next.metrics });
      const joined = next.list.join("\n");
      setText(joined);
      setHydratedFrom(joined);
      setSavedAt(Date.now());
    },
  });

  const linesCount = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
  const isDirty = hydratedFrom !== null && text !== hydratedFrom;

  return (
    <section className="rounded-xl border border-border bg-card p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold">Reddit Proxies</h2>
        <p className="text-sm text-muted-foreground mt-1">
          The bot rotates through these proxies when checking Reddit posts /
          accounts / comments. Empty list = direct connection (works but Reddit
          will rate-limit the bot's IP after ~60 requests/minute).
        </p>
      </div>

      {/* FORMAT — always visible so the operator never has to guess */}
      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-muted-foreground space-y-2">
        <p className="font-semibold text-foreground">Format (one proxy per line):</p>
        <ul className="list-disc list-inside space-y-1 ml-1">
          <li><code className="text-foreground">user:pass@host:port</code> — HTTP proxy (most common, Webshare gives this)</li>
          <li><code className="text-foreground">http://user:pass@host:port</code> — same thing, explicit scheme</li>
          <li><code className="text-foreground">socks5://user:pass@host:port</code> — SOCKS5 proxy</li>
          <li><code className="text-foreground">host:port</code> — proxy without auth (free/open proxies)</li>
          <li>Lines starting with <code className="text-foreground">#</code> are treated as comments (ignored)</li>
        </ul>
        <p className="pt-1 text-foreground"><strong>Webshare quick start:</strong></p>
        <ol className="list-decimal list-inside space-y-1 ml-1">
          <li>webshare.io → Dashboard → Proxy → List → "Download"</li>
          <li>Format: <strong>Username:Password</strong> → Connection: <strong>Backbone</strong></li>
          <li>Upload the downloaded file below (any filename works) OR paste contents into the textarea</li>
        </ol>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {!isLoading && !error && data && (
        <>
          {/* Live stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Loaded" value={String(data.metrics.proxyCount)} />
            <Stat
              label="Success rate"
              value={data.metrics.proxy.total > 0
                ? `${Math.round(data.metrics.proxy.successRate * 100)}%`
                : "—"}
              hint={data.metrics.proxy.total > 0 ? `${data.metrics.proxy.successes}/${data.metrics.proxy.total} (last ${data.metrics.proxy.total})` : "no traffic yet"}
            />
            <Stat
              label="Avg latency"
              value={data.metrics.proxy.avgLatencyMs > 0 ? `${data.metrics.proxy.avgLatencyMs}ms` : "—"}
            />
            <Stat
              label="Direct fallback"
              value={data.metrics.direct.total > 0
                ? `${Math.round(data.metrics.direct.successRate * 100)}%`
                : "—"}
              hint={data.metrics.direct.total > 0 ? `${data.metrics.direct.successes}/${data.metrics.direct.total}` : "unused"}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-sm font-medium text-foreground">
                Proxy list ({linesCount} active line{linesCount === 1 ? "" : "s"})
              </label>
              <div className="flex items-center gap-2">
                {/* File upload — accepts ANY filename / extension. We just read
                    text; the user's downloaded file from Webshare/IPRoyal/etc.
                    can be called anything. The contents get APPENDED so the
                    operator can merge proxies from multiple providers. */}
                <label className="text-xs px-3 py-1.5 rounded-md border border-border bg-background hover:bg-secondary transition cursor-pointer flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Upload file
                  <input
                    type="file"
                    /* No `accept` filter — operator may have any extension or none.
                       We read the file as text regardless of what the OS thinks it is. */
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) await handleFile(f);
                      // Reset so the same file can be re-uploaded later if needed.
                      e.target.value = "";
                    }}
                  />
                </label>
                {text.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setText("")}
                    className="text-xs px-2.5 py-1.5 rounded-md border border-border bg-background hover:bg-secondary transition text-muted-foreground"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              rows={10}
              placeholder={"user:pass@host.example.com:8080\nuser:pass@host2.example.com:8080\n# Lines starting with # are ignored\n\n…or click 'Upload file' above to load proxies from any text file."}
              className="w-full px-3 py-2.5 rounded-lg bg-background border border-input text-xs font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {uploadInfo && (
              <div className="mt-2 text-xs text-green-500">{uploadInfo}</div>
            )}
            {uploadErr && (
              <div className="mt-2 text-xs text-destructive">{uploadErr}</div>
            )}
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div className="text-xs text-muted-foreground">
              {savedAt ? (
                <span className="text-green-500">
                  Saved {new Date(savedAt).toLocaleTimeString()} — bot reloaded
                </span>
              ) : isDirty ? (
                <span className="text-amber-400">Unsaved changes</span>
              ) : (
                "Changes apply within ~5 seconds of saving (no restart needed)"
              )}
            </div>
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || !isDirty}
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 transition"
            >
              {save.isPending ? "Saving…" : "Save & Reload"}
            </button>
          </div>

          {save.isError && (
            <div className="rounded-lg border border-destructive bg-destructive/10 text-destructive p-3 text-sm">
              {(save.error as Error).message}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/50 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}
