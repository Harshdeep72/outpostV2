import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ProxyAgent, fetch as undiciFetch, Agent } from "undici";
import { logger } from "../lib/logger.js";
import { getProxiesWithMeta } from "../lib/settings.js";

const PROXIES_FILE_CANDIDATES = [
  resolve(process.cwd(), "proxies.txt"),
  resolve(process.cwd(), "../../proxies.txt"),
  resolve(process.cwd(), "../../../proxies.txt"),
  "/opt/render/project/src/proxies.txt",
];

const RELOAD_INTERVAL_MS = 60_000;

interface ProxyEntry {
  url: string;
  agent: ProxyAgent;
}

let proxies: ProxyEntry[] = [];
let rotationIndex = 0;
let lastLoad = 0;
let resolvedFile: string | null = null;
const directAgent = new Agent({
  connect: { timeout: 4_000 },
  bodyTimeout: 6_000,
  headersTimeout: 6_000,
});

function normalizeProxyLine(raw: string): string | null {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  if (/^https?:\/\//i.test(line) || /^socks/i.test(line)) return line;

  // Webshare-style "host:port:user:pass" — 4 colon-separated parts where
  // the 2nd part is numeric. Convert to "http://user:pass@host:port" so
  // operators can paste the raw download from webshare directly.
  const parts = line.split(":");
  if (parts.length === 4) {
    const [host, port, user, pass] = parts as [string, string, string, string];
    if (/^\d+$/.test(port) && host && user && pass) {
      return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
  }

  // "user:pass@host:port" — already URL-ish, just prepend scheme.
  // Otherwise assume plain "host:port" (no auth).
  return `http://${line}`;
}

async function findProxiesFile(): Promise<string | null> {
  if (resolvedFile && existsSync(resolvedFile)) return resolvedFile;
  for (const candidate of PROXIES_FILE_CANDIDATES) {
    if (existsSync(candidate)) {
      resolvedFile = candidate;
      return candidate;
    }
  }
  return null;
}

export async function loadProxies(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastLoad < RELOAD_INTERVAL_MS) return;
  lastLoad = now;

  // PRIMARY source: dashboard-managed list in DB (system_settings.proxies).
  // FALLBACK: legacy proxies.txt on disk — kept for local dev and any
  // pre-existing Render env where ops pasted a file.
  //
  // Important: a DB row with an EMPTY list is still authoritative — the
  // operator explicitly chose "no proxies, use direct". File fallback only
  // kicks in when the DB row does not exist at all (`exists:false`), i.e.
  // proxies have never been configured from the dashboard.
  let lines: string[] = [];
  let source: "db" | "file" | "none" = "none";

  try {
    const fromDb = await getProxiesWithMeta();
    if (fromDb.exists) {
      lines = fromDb.list;
      source = "db";
    }
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "Failed to read proxies from DB; will try file fallback");
  }

  if (source === "none") {
    const file = await findProxiesFile();
    if (file) {
      try {
        const raw = await readFile(file, "utf-8");
        lines = raw.split(/\r?\n/);
        source = "file";
      } catch (err) {
        logger.warn({ err, file }, "Failed to read proxies.txt");
      }
    }
  }

  if (source === "none") {
    if (proxies.length > 0) {
      logger.warn("Proxy list now empty (no DB entries, no proxies.txt) — clearing");
      proxies = [];
    }
    return;
  }

  const fresh: ProxyEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const url = normalizeProxyLine(line);
    if (!url) continue;
    try {
      const agent = new ProxyAgent({
        uri: url,
        connectTimeout: 4_000,
        bodyTimeout: 6_000,
        headersTimeout: 6_000,
      });
      fresh.push({ url, agent });
    } catch (err) {
      // SECURITY: never log the raw line — proxy URLs contain credentials
      // (user:pass@host:port). Log only the masked host:port + line index
      // so the operator can locate the bad entry without leaking secrets.
      logger.warn({ err, index: i, host: maskProxy(url) }, "Skipping invalid proxy entry");
    }
  }

  if (fresh.length !== proxies.length) {
    logger.info({ count: fresh.length, source }, "Proxy list reloaded");
  }
  proxies = fresh;
}

/**
 * Force an immediate reload of the proxy list, bypassing the rate limiter.
 * Called by the admin dashboard right after PUT /admin/settings/proxies so
 * a save reflects in bot behavior within seconds instead of up to 60s.
 */
export async function reloadProxiesNow(): Promise<number> {
  await loadProxies(true);
  return proxies.length;
}

export function getProxyCount(): number {
  return proxies.length;
}

/** Returns the raw proxy URL strings currently loaded (for custom fetch logic). */
export function getProxiesRaw(): string[] {
  return proxies.map(p => p.url);
}


const METRICS_WINDOW = 100;
type Attempt = { ok: boolean; ms: number; status: number; kind: "proxy" | "direct" };
const proxyAttempts: Attempt[] = [];
const directAttempts: Attempt[] = [];

function recordAttempt(kind: "proxy" | "direct", ok: boolean, ms: number, status: number) {
  const buf = kind === "proxy" ? proxyAttempts : directAttempts;
  buf.push({ ok, ms, status, kind });
  if (buf.length > METRICS_WINDOW) buf.shift();
}

function summarize(buf: Attempt[]) {
  const total = buf.length;
  const successes = buf.filter((a) => a.ok).length;
  const failures = total - successes;
  const successRate = total === 0 ? 0 : successes / total;
  const avgLatencyMs = total === 0 ? 0 : Math.round(buf.reduce((s, a) => s + a.ms, 0) / total);
  return { total, successes, failures, successRate, avgLatencyMs };
}

export function getProxyMetrics(): {
  proxy: { total: number; successes: number; failures: number; successRate: number; avgLatencyMs: number };
  direct: { total: number; successes: number; failures: number; successRate: number; avgLatencyMs: number };
  windowSize: number;
  proxyCount: number;
} {
  return {
    proxy: summarize(proxyAttempts),
    direct: summarize(directAttempts),
    windowSize: METRICS_WINDOW,
    proxyCount: proxies.length,
  };
}

function nextProxies(n: number): ProxyEntry[] {
  if (proxies.length === 0) return [];
  const out: ProxyEntry[] = [];
  for (let i = 0; i < Math.min(n, proxies.length); i++) {
    out.push(proxies[(rotationIndex + i) % proxies.length]!);
  }
  rotationIndex = (rotationIndex + 1) % proxies.length;
  return out;
}

export interface ProxyFetchOptions {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Override the Accept header (default: application/json). */
  acceptHeader?: string;
}

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface ProxyFetchResult {
  ok: boolean;
  status: number;
  body: any;
  via: string;
}

async function fetchOnce(
  url: string,
  dispatcher: Agent | ProxyAgent,
  via: string,
  timeoutMs: number,
  headers: Record<string, string>,
  kind: "proxy" | "direct",
  acceptHeader = "application/json"
): Promise<ProxyFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await undiciFetch(url, {
      dispatcher,
      headers: { "User-Agent": DEFAULT_UA, "Accept": acceptHeader, ...headers },
      signal: controller.signal,
    });
    let body: any = null;
    try {
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } catch {
      body = null;
    }
    recordAttempt(kind, res.ok, Date.now() - start, res.status);
    return { ok: res.ok, status: res.status, body, via };
  } catch (err) {
    recordAttempt(kind, false, Date.now() - start, 0);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function runProxyRace(
  urls: string[],
  opts: ProxyFetchOptions,
  acceptHeader: string
): Promise<ProxyFetchResult> {
  await loadProxies().catch(() => {});

  const timeoutMs = opts.timeoutMs ?? 5_000;
  const headers = opts.headers ?? {};
  const targets = nextProxies(3);

  const tasks: Promise<ProxyFetchResult>[] = [];

  if (targets.length === 0) {
    for (const url of urls) {
      tasks.push(fetchOnce(url, directAgent, "direct", timeoutMs, headers, "direct", acceptHeader));
    }
  } else {
    for (const proxy of targets) {
      const url = urls[Math.floor(Math.random() * urls.length)]!;
      tasks.push(fetchOnce(url, proxy.agent, `proxy:${maskProxy(proxy.url)}`, timeoutMs, headers, "proxy", acceptHeader));
    }
    // Always also try direct as a fallback in case proxies are all slow/dead.
    tasks.push(fetchOnce(urls[0]!, directAgent, "direct-fallback", timeoutMs, headers, "direct", acceptHeader));
  }

  // Race: only treat 2xx as a winner. 404 and other errors are NOT short-circuit successes
  // because one bad proxy returning 404 fast must not beat a good 2xx from another endpoint.
  try {
    return await Promise.any(tasks.map(async (p) => {
      const result = await p;
      if (!result.ok) {
        throw Object.assign(new Error(`HTTP ${result.status}`), { status: result.status, result });
      }
      return result;
    }));
  } catch (err: any) {
    // All attempts failed. Decide the consolidated outcome.
    if (err instanceof AggregateError) {
      const errors = err.errors as any[];
      const results = errors.map((e) => e?.result).filter(Boolean) as ProxyFetchResult[];

      // If EVERY attempt returned 404, then the resource really is missing.
      if (results.length > 0 && results.every((r) => r.status === 404)) {
        return results[0]!;
      }

      // Otherwise prefer a non-404 failure (network/5xx) for retry signaling.
      const nonNotFound = results.find((r) => r.status !== 404 && r.status !== 0);
      if (nonNotFound) return nonNotFound;

      const last = results[results.length - 1];
      return last ?? { ok: false, status: 0, body: null, via: "all-failed" };
    }
    return { ok: false, status: 0, body: null, via: "error" };
  }
}

export async function proxyFetchJson(
  urls: string[],
  opts: ProxyFetchOptions = {}
): Promise<ProxyFetchResult> {
  return runProxyRace(urls, opts, opts.acceptHeader ?? "application/json");
}

/**
 * Like proxyFetchJson but returns the raw text body (not parsed as JSON).
 * Used for RSS/XML/HTML fetches that need the same proxy-rotation logic.
 * Returns null if all attempts fail or the body is empty/not a string.
 */
export async function proxyFetchText(
  urls: string[],
  opts: ProxyFetchOptions = {}
): Promise<string | null> {
  const accept = opts.acceptHeader ?? "text/html, application/xml, text/xml, */*";
  const result = await runProxyRace(urls, opts, accept);
  if (!result.ok) return null;
  if (typeof result.body === "string" && result.body.length > 0) return result.body;
  return null;
}

function maskProxy(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port}`;
  } catch {
    return "unknown";
  }
}

export function startProxyAutoReload(): void {
  loadProxies(true).catch((err) => logger.warn({ err }, "Initial proxy load failed"));
  setInterval(() => {
    loadProxies(true).catch(() => {});
  }, RELOAD_INTERVAL_MS).unref();
}
