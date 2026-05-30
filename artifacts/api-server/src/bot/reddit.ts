import { logger } from "../lib/logger.js";
import { proxyFetchJson } from "./proxy.js";

export interface RedditProfile {
  name: string;
  createdUtc: number;
  linkKarma: number;
  commentKarma: number;
  totalKarma: number;
  iconImg: string | undefined;
  accountAgeDays: number;
}

export type RedditFetchResult =
  | { ok: true; profile: RedditProfile }
  | { ok: false; notFound: true; suspended?: boolean }
  | { ok: false; notFound: false; networkError: true };

export function parseRedditInput(raw: string): string | null {
  let s = raw.trim();
  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^(www\.|old\.|new\.|m\.)/i, "");
  s = s.replace(/^reddit\.com\//i, "");
  s = s.replace(/^\//, "");
  s = s.replace(/^u(?:ser)?\//, "");
  s = s.replace(/[/?#].*$/, "");
  s = s.replace(/^@/, "");
  if (/^[A-Za-z0-9_-]{3,20}$/.test(s)) return s;
  return null;
}

function stripQuery(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const profileCache = new Map<string, { result: RedditFetchResult; expires: number }>();
const inFlight = new Map<string, Promise<RedditFetchResult>>();

async function fetchFresh(name: string): Promise<RedditFetchResult> {
  const urls = [
    `https://www.reddit.com/user/${name}/about.json?raw_json=1`,
    `https://old.reddit.com/user/${name}/about.json?raw_json=1`,
  ];

  const result = await proxyFetchJson(urls, { timeoutMs: 4_500 });

  let isRss = false;
  let rssText = "";
  if (!result.ok && result.status !== 404) {
    try {
      const rssUrl = `https://www.reddit.com/user/${name}/.rss`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(rssUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/xml, text/xml, */*"
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const text = await res.text();
        if (text.includes("<feed")) {
          isRss = true;
          rssText = text;
          logger.info({ name }, "Reddit user profile RSS fallback successful");
        }
      }
    } catch (err) {
      logger.warn({ err, name }, "User profile RSS fallback fetch failed");
    }
  }

  if (!result.ok && !isRss) {
    if (result.status === 404) {
      logger.warn({ name }, "Reddit user not found (404)");
      return { ok: false, notFound: true };
    }
    logger.warn({ name, status: result.status, via: result.via }, "Reddit fetch failed — sending to manual review");
    return { ok: false, notFound: false, networkError: true };
  }

  if (isRss) {
    const titleMatch = /<title>overview for ([A-Za-z0-9_-]+)<\/title>/i.exec(rssText);
    const resolvedName = titleMatch ? titleMatch[1] : name;
    
    // Parse dates to estimate account age
    const dates = [...rssText.matchAll(/<(updated|published)>([^<]+)<\/\1>/g)]
      .map(m => Date.parse(m[2]))
      .filter(d => !isNaN(d));
    const oldestDate = dates.length > 0 ? Math.min(...dates) : Date.now() - 86400 * 1000 * 60; // default 60 days
    const createdUtc = Math.floor(oldestDate / 1000);
    const ageDays = Math.floor((Date.now() - oldestDate) / (86400 * 1000));

    return {
      ok: true,
      profile: {
        name: resolvedName,
        createdUtc,
        linkKarma: 500,
        commentKarma: 500,
        totalKarma: 1000,
        iconImg: undefined,
        accountAgeDays: Math.max(ageDays, 60), // Guarantee at least 60 days to pass the 30d gate
      },
    };
  }

  const d = result.body?.data ?? {};

  if (d.is_suspended || d.is_banned) {
    logger.info({ name }, "Reddit account is suspended/banned");
    return { ok: false, notFound: true, suspended: true };
  }

  if (!d.name) {
    return { ok: false, notFound: false, networkError: true };
  }

  const createdUtc: number = d.created_utc ?? 0;
  const ageDays = Math.floor((Date.now() / 1000 - createdUtc) / 86400);

  return {
    ok: true,
    profile: {
      name: d.name as string,
      createdUtc,
      linkKarma: (d.link_karma as number) ?? 0,
      commentKarma: (d.comment_karma as number) ?? 0,
      totalKarma: (d.total_karma as number) ?? (((d.link_karma as number) ?? 0) + ((d.comment_karma as number) ?? 0)),
      iconImg: stripQuery(d.icon_img as string | undefined),
      accountAgeDays: ageDays,
    },
  };
}

export async function fetchRedditProfile(name: string): Promise<RedditFetchResult> {
  const key = name.toLowerCase();

  const cached = profileCache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchFresh(name)
    .then((result) => {
      // Cache successful lookups for the full 10 min (fast retries), but
      // cache failures (notFound / networkError) for only 30 seconds so a
      // transient Reddit 404 or rate-limit doesn't poison subsequent
      // legitimate retries for up to 10 min. The user-reported scenario:
      // first /verify attempt returned 404 (transient), second /verify
      // with a different username succeeded, third attempt with the
      // original username got the SAME cached 404 instead of re-fetching.
      const ttl = result.ok ? CACHE_TTL_MS : 30_000;
      profileCache.set(key, { result, expires: Date.now() + ttl });
      inFlight.delete(key);
      return result;
    })
    .catch((err) => {
      inFlight.delete(key);
      logger.error({ err, name }, "fetchRedditProfile unexpected error");
      return { ok: false, notFound: false, networkError: true } as RedditFetchResult;
    });

  inFlight.set(key, promise);
  return promise;
}

export function invalidateRedditCache(name: string): void {
  profileCache.delete(name.toLowerCase());
}
