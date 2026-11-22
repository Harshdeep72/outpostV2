import { executePythonRedditClient } from "./pythonClient.js";
import { logger } from "../lib/logger.js";

export interface BotBouncerCheckResult {
  active: boolean;
  subreddit: string | null;
  moderators?: string[];
  matchedBot?: string;
  reason?: string;
}

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours cache
const bouncerCache = new Map<string, { result: BotBouncerCheckResult; expiresAt: number }>();

/**
 * Extract clean subreddit name (lowercase, no r/ prefix) from a Reddit URL or string.
 */
export function extractSubreddit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = trimmed.match(/(?:reddit\.com\/r\/|^\/?r\/)([A-Za-z0-9_]{2,30})/i);
  if (match) return match[1]!.toLowerCase();
  if (/^[A-Za-z0-9_]{2,30}$/.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

/**
 * Check if a subreddit has Bot Bouncer (or related anti-bot apps like BotDefense)
 * active as a moderator.
 *
 * Checks https://www.reddit.com/r/{subreddit}/about/moderators.json via Python curl_cffi client.
 * Results are cached for 2 hours to avoid redundant network requests.
 */
export async function isSubredditBotBouncerActive(
  subredditOrUrl: string,
  options?: { bypassCache?: boolean }
): Promise<BotBouncerCheckResult> {
  const sub = extractSubreddit(subredditOrUrl);
  if (!sub) {
    return { active: false, subreddit: null };
  }

  const now = Date.now();
  if (!options?.bypassCache) {
    const cached = bouncerCache.get(sub);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }
  }

  try {
    // 1. Try direct fetch via Python curl_cffi client (Chrome TLS impersonation)
    let res = await executePythonRedditClient({
      url: `https://www.reddit.com/r/${sub}/about/moderators.json`,
      isJson: true,
      useProxy: false,
      timeout: 10,
    }).catch(() => null);

    // 2. Fall back to proxy if direct fails
    if (!res || !res.ok || !res.body) {
      res = await executePythonRedditClient({
        url: `https://www.reddit.com/r/${sub}/about/moderators.json`,
        isJson: true,
        useProxy: true,
        timeout: 15,
      }).catch(() => null);
    }

    if (!res || !res.ok || !res.body) {
      logger.warn(
        { sub, status: res?.status, error: res?.error },
        "isSubredditBotBouncerActive: could not fetch moderators.json (allowing task)"
      );
      return { active: false, subreddit: sub };
    }

    const children = res.body?.data?.children;
    if (!Array.isArray(children)) {
      return { active: false, subreddit: sub };
    }

    const modNames = children
      .map((c: any) => (c?.name ? String(c.name).toLowerCase().trim() : ""))
      .filter((n: string) => n.length > 0);

    // Detect Bot Bouncer or BotDefense in moderator list
    const bouncerMod = modNames.find(
      (m: string) =>
        m === "bot-bouncer" ||
        m === "botbouncer" ||
        m.includes("bot-bouncer") ||
        m.includes("botbouncer") ||
        m === "botdefense" ||
        m === "bot-defense" ||
        (m.includes("bouncer") && m.includes("bot"))
    );

    const result: BotBouncerCheckResult = bouncerMod
      ? {
          active: true,
          subreddit: sub,
          moderators: modNames,
          matchedBot: bouncerMod,
          reason: `Automated moderator bot '${bouncerMod}' detected in r/${sub} moderator list`,
        }
      : {
          active: false,
          subreddit: sub,
          moderators: modNames,
        };

    bouncerCache.set(sub, { result, expiresAt: now + CACHE_TTL_MS });
    if (result.active) {
      logger.warn({ sub, matchedBot: bouncerMod }, "Bot Bouncer detected on subreddit!");
    }
    return result;
  } catch (err: any) {
    logger.warn({ err: err?.message, sub }, "isSubredditBotBouncerActive error");
    return { active: false, subreddit: sub };
  }
}
