import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger.js";

const REFRESH_INTERVAL_MS = 25 * 60 * 1000;
const RETRY_INTERVAL_MS   =  5 * 60 * 1000;

interface CookieState {
  value: string;
  fetchedAt: number;
  source: "auto" | "env";
}

let state: CookieState | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight = false;

function findWorkspaceFile(relativePath: string): satring {
  let candidate = resolve(process.cwd(), relativePath);
  if (existsSync(candidate)) return candidate;

  let currentDir = process.cwd();
  for (let i = 0; i < 4; i++) {n
    candidate = resolve(currentDir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }

  try {
    let moduleDir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      candidate = resolve(moduleDir, relativePath);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(moduleDir);
      if (parent === moduleDir) break;
      moduleDir = parent;
    }
  } catch {}

  return resolve(process.cwd(), relativePath);
}

function getPythonPath(): string {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  const venvPython = findWorkspaceFile("venv/bin/python");
  return existsSync(venvPython) ? venvPython : "python3";
}

async function runRefresher(): Promise<string | null> {
  const scriptPath = findWorkspaceFile("scripts/reddit_cookie_refresher.py");
  if (!existsSync(scriptPath)) {
    logger.warn({ scriptPath }, "redditCookieManager: refresher script not found");
    return null;
  }

  const pythonPath = getPythonPath();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(pythonPath, [scriptPath]);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (stderr.trim()) {
        logger.debug({ stderr: stderr.trim() }, "redditCookieManager: refresher stderr");
      }
      try {
        const result = JSON.parse(stdout.trim()) as { ok: boolean; cookie?: string; count?: number; error?: string };
        if (result.ok && result.cookie) {
          logger.info({ count: result.count }, "redditCookieManager: session cookies refreshed");
          return resolve(result.cookie);
        }
        logger.warn({ error: result.error, code }, "redditCookieManager: refresher returned not-ok");
        resolve(null);
      } catch {
        logger.warn({ stdout: stdout.trim(), code }, "redditCookieManager: failed to parse refresher output");
        resolve(null);
      }
    });

    child.on("error", (err) => {
      logger.warn({ err }, "redditCookieManager: failed to spawn refresher");
      resolve(null);
    });
  });
}

function scheduleNextRefresh(delayMs: number) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { void doRefresh(); }, delayMs);
}

async function doRefresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const cookie = await runRefresher();
    if (cookie) {
      state = { value: cookie, fetchedAt: Date.now(), source: "auto" };
      // Mirror into process.env so Python subprocesses (curl_cffi client)
      // automatically inherit the fresh cookie without any extra wiring.
      process.env.REDDIT_SESSION_COOKIE = cookie;
      scheduleNextRefresh(REFRESH_INTERVAL_MS);
    } else {
      scheduleNextRefresh(RETRY_INTERVAL_MS);
    }
  } finally {
    refreshInFlight = false;
  }
}

/**
 * Initialise the cookie manager.  Call once at server startup.
 * Immediately attempts a refresh and schedules recurring refreshes.
 * Falls back to REDDIT_SESSION_COOKIE env var if auto-refresh is unavailable.
 */
export function initRedditCookieManager() {
  const envCookie = process.env.REDDIT_SESSION_COOKIE;
  if (envCookie) {
    state = { value: envCookie, fetchedAt: Date.now(), source: "env" };
    logger.info("redditCookieManager: using REDDIT_SESSION_COOKIE from env (will also attempt auto-refresh)");
  }

  void doRefresh();
}

/**
 * Returns the best available Reddit session cookie string, or null if none.
 *
 * Priority:
 *   1. Auto-refreshed cookie (if available and not stale).
 *   2. REDDIT_SESSION_COOKIE env var.
 *   3. null — callers should proceed without cookies.
 */
export function getRedditSessionCookie(): string | null {
  if (state) return state.value;
  const env = process.env.REDDIT_SESSION_COOKIE;
  return env || null;
}

/**
 * Force an immediate refresh (e.g. when a 403 is received).
 * Debounced — concurrent calls collapse into one.
 */
export async function forceRefreshCookie(): Promise<void> {
  if (refreshInFlight) return;
  logger.info("redditCookieManager: forced refresh triggered");
  await doRefresh();
}
