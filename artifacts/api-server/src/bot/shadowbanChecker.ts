import { executePythonRedditClient } from "./pythonClient.js";
import { logger } from "../lib/logger.js";

export interface RedditAccountHealth {
  username: string;
  isHealthy: boolean;
  isShadowbanned: boolean;
  isSuspended: boolean;
  exists: boolean;
  karma?: number;
  accountAgeDays?: number;
  reason?: string;
  checkedVia: "osint" | "python" | "cache" | "error";
}

const HEALTHY_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes for healthy accounts
const UNHEALTHY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for shadowbanned/suspended (quicker recovery if appealed/false flag)

interface CachedEntry {
  result: RedditAccountHealth;
  expiresAt: number;
}

const healthCache = new Map<string, CachedEntry>();

/**
 * Clean a Reddit username string by removing leading u/ or /u/ and trimming whitespace.
 */
export function cleanRedditUsername(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/^\/?u\//i, "").trim();
}

/**
 * Invalidate cached health status for a specific Reddit username.
 */
export function invalidateAccountHealthCache(username: string): void {
  const clean = cleanRedditUsername(username).toLowerCase();
  if (clean) healthCache.delete(clean);
}

/**
 * Check whether a Reddit account is active or shadowbanned / suspended.
 *
 * 1. Checks in-memory TTL cache.
 * 2. Primary: Fast HTTP query to REDDIT_OSINT_URL (/api/external/check/user/:name).
 * 3. Fallback: High-fidelity TLS request via Python curl_cffi client (/user/:name/about.json).
 * 4. Fails open on transient network errors so outages never permanently block legitimate workers.
 */
export async function checkRedditAccountHealth(
  username: string,
  options?: { bypassCache?: boolean }
): Promise<RedditAccountHealth> {
  const clean = cleanRedditUsername(username);
  if (!clean) {
    return {
      username: "",
      isHealthy: false,
      isShadowbanned: false,
      isSuspended: false,
      exists: false,
      reason: "Empty username",
      checkedVia: "error",
    };
  }

  const cacheKey = clean.toLowerCase();
  const now = Date.now();

  if (!options?.bypassCache) {
    const cached = healthCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { ...cached.result, checkedVia: "cache" };
    }
  }

  // 1. Primary Check: REDDIT_OSINT_URL
  const osintUrl = process.env.REDDIT_OSINT_URL || "https://harrry953489-redditapi.hf.space";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(`${osintUrl}/api/external/check/user/${encodeURIComponent(clean)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data = (await res.json().catch(() => null)) as any;
    if (data) {
      if (!data.success || res.status === 404) {
        const innerStatus = data.data?.status;
        if (
          innerStatus === "deleted" ||
          innerStatus === "shadowbanned" ||
          data.message?.toLowerCase().includes("not found")
        ) {
          const result: RedditAccountHealth = {
            username: clean,
            isHealthy: false,
            isShadowbanned: true,
            isSuspended: false,
            exists: false,
            reason: "Account returns 404 / deleted on Reddit (Shadowbanned)",
            checkedVia: "osint",
          };
          healthCache.set(cacheKey, { result, expiresAt: now + UNHEALTHY_CACHE_TTL_MS });
          return result;
        }

        if (innerStatus === "suspended") {
          const result: RedditAccountHealth = {
            username: clean,
            isHealthy: false,
            isShadowbanned: false,
            isSuspended: true,
            exists: false,
            reason: "Account is suspended by Reddit",
            checkedVia: "osint",
          };
          healthCache.set(cacheKey, { result, expiresAt: now + UNHEALTHY_CACHE_TTL_MS });
          return result;
        }
      }

      if (data.success && (data.data?.status === "active" || data.data?.status === "valid")) {
        const totalKarma =
          typeof data.data?.total_karma === "number"
            ? data.data.total_karma
            : (data.data?.link_karma ?? 0) + (data.data?.comment_karma ?? 0);

        const result: RedditAccountHealth = {
          username: clean,
          isHealthy: true,
          isShadowbanned: false,
          isSuspended: false,
          exists: true,
          karma: totalKarma,
          accountAgeDays: data.data?.account_age_days ?? 0,
          checkedVia: "osint",
        };
        healthCache.set(cacheKey, { result, expiresAt: now + HEALTHY_CACHE_TTL_MS });
        return result;
      }
    }
  } catch (err: any) {
    logger.debug({ err: err?.message, username: clean }, "OSINT health check failed, trying Python fallback");
  }

  // 2. Fallback Check: Python curl_cffi client (/user/:name/about.json)
  try {
    let pyRes = await executePythonRedditClient({
      url: `https://www.reddit.com/user/${encodeURIComponent(clean)}/about.json`,
      isJson: true,
      useProxy: false,
      timeout: 8,
    }).catch(() => null);

    if (!pyRes || (!pyRes.ok && pyRes.status !== 404)) {
      // Retry with proxy if direct was blocked (e.g. Cloudflare / 403)
      pyRes = await executePythonRedditClient({
        url: `https://www.reddit.com/user/${encodeURIComponent(clean)}/about.json`,
        isJson: true,
        useProxy: true,
        timeout: 10,
      }).catch(() => null);
    }

    if (pyRes) {
      if (
        pyRes.status === 404 ||
        pyRes.body?.error === 404 ||
        pyRes.body?.message === "Not Found"
      ) {
        const result: RedditAccountHealth = {
          username: clean,
          isHealthy: false,
          isShadowbanned: true,
          isSuspended: false,
          exists: false,
          reason: "Profile returns 404 Not Found on Reddit (Shadowbanned)",
          checkedVia: "python",
        };
        healthCache.set(cacheKey, { result, expiresAt: now + UNHEALTHY_CACHE_TTL_MS });
        return result;
      }

      if (pyRes.body?.data?.is_suspended || pyRes.body?.data?.is_banned) {
        const result: RedditAccountHealth = {
          username: clean,
          isHealthy: false,
          isShadowbanned: false,
          isSuspended: true,
          exists: false,
          reason: "Profile is suspended/banned on Reddit",
          checkedVia: "python",
        };
        healthCache.set(cacheKey, { result, expiresAt: now + UNHEALTHY_CACHE_TTL_MS });
        return result;
      }

      if (pyRes.status === 200 && pyRes.body?.kind === "t2" && pyRes.body?.data?.name) {
        const d = pyRes.body.data;
        const totalKarma =
          typeof d.total_karma === "number"
            ? d.total_karma
            : (d.link_karma ?? 0) + (d.comment_karma ?? 0);

        const createdUtc: number = typeof d.created_utc === "number" ? d.created_utc : 0;
        const ageDays = createdUtc ? Math.floor((Date.now() / 1000 - createdUtc) / 86400) : 0;

        const result: RedditAccountHealth = {
          username: clean,
          isHealthy: true,
          isShadowbanned: false,
          isSuspended: false,
          exists: true,
          karma: totalKarma,
          accountAgeDays: ageDays,
          checkedVia: "python",
        };
        healthCache.set(cacheKey, { result, expiresAt: now + HEALTHY_CACHE_TTL_MS });
        return result;
      }
    }
  } catch (err: any) {
    logger.warn({ err: err?.message, username: clean }, "Python fallback health check failed");
  }

  // 3. Fail-open fallback: if both methods failed due to network issues, do not block the worker
  logger.warn({ username: clean }, "Reddit account health check inconclusive due to network — failing open");
  return {
    username: clean,
    isHealthy: true,
    isShadowbanned: false,
    isSuspended: false,
    exists: true,
    reason: "Health check inconclusive (network timeout)",
    checkedVia: "error",
  };
}
