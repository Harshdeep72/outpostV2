import { logger } from "../lib/logger.js";

export interface RedditProfile {
  name: string;
  createdUtc: number;
  linkKarma: number;
  commentKarma: number;
  totalKarma: number;
  iconImg: string | undefined;
  accountAgeDays: number;
  /** true = karma from live JSON API; false = RSS fallback (karma unverifiable) */
  karmaVerified: boolean;
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

// ── Reddit OAuth (app-only) ───────────────────────────────────────────────────
// When REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET are set, use the official OAuth
// API (oauth.reddit.com) which is NOT IP-blocked. Token is cached 55 min.
let oauthToken: { token: string; expires: number } | null = null;

export function invalidateOAuthToken(): void {
  oauthToken = null;
}

/**
 * Fetch any reddit.com or oauth.reddit.com URL using the app-only OAuth token.
 * Automatically rewrites www/old.reddit.com URLs to oauth.reddit.com.
 * Returns { ok, status, body } — never throws.
 * Returns { ok: false, status: 0 } when OAuth is not configured or the token
 * could not be obtained.
 */
export async function fetchRedditApiUrl(url: string): Promise<{ ok: boolean; status: number; body: any }> {
  const token = await getOAuthToken();
  if (!token) return { ok: false, status: 0, body: null };

  const oauthUrl = url.replace(/^https:\/\/(www|old)\.reddit\.com\//, "https://oauth.reddit.com/");

  try {
    const { fetch: undiciFetch, Agent } = await import("undici");
    const agent = new Agent({ connect: { timeout: 5_000 }, bodyTimeout: 10_000, headersTimeout: 10_000 });
    const res = await undiciFetch(oauthUrl, {
      dispatcher: agent,
      headers: {
        "User-Agent": "OutpostBot/1.0",
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    });
    if (res.status === 401) {
      oauthToken = null;
      logger.warn({ oauthUrl }, "fetchRedditApiUrl: 401 — OAuth token invalidated");
      return { ok: false, status: 401, body: null };
    }
    if (!res.ok) return { ok: false, status: res.status, body: null };
    const body = await res.json();
    return { ok: true, status: res.status, body };
  } catch (err) {
    logger.warn({ err, oauthUrl }, "fetchRedditApiUrl error");
    return { ok: false, status: 0, body: null };
  }
}

export async function getOAuthToken(): Promise<string | null> {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const secret   = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !secret) return null;

  if (oauthToken && oauthToken.expires > Date.now()) return oauthToken.token;

  try {
    const { fetch: undiciFetch, Agent } = await import("undici");
    const agent = new Agent({ connect: { timeout: 5_000 }, bodyTimeout: 8_000, headersTimeout: 8_000 });
    const res = await undiciFetch("https://www.reddit.com/api/v1/access_token", {
      dispatcher: agent,
      method: "POST",
      headers: {
        "User-Agent": "OutpostBot/1.0",
        "Authorization": "Basic " + Buffer.from(`${clientId}:${secret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) { logger.warn({ status: res.status }, "Reddit OAuth token request failed"); return null; }
    const json = await res.json() as any;
    if (!json.access_token) { logger.warn({ json }, "Reddit OAuth: no access_token in response"); return null; }
    // Cache for 55 min (Reddit tokens expire in 60 min)
    oauthToken = { token: json.access_token as string, expires: Date.now() + 55 * 60 * 1000 };
    logger.info("Reddit OAuth token acquired");
    return oauthToken.token;
  } catch (err) {
    logger.warn({ err }, "Reddit OAuth token fetch failed");
    return null;
  }
}

async function fetchViaOAuth(name: string): Promise<RedditFetchResult | null> {
  const token = await getOAuthToken();
  if (!token) return null;

  try {
    const { fetch: undiciFetch, Agent } = await import("undici");
    const agent = new Agent({ connect: { timeout: 5_000 }, bodyTimeout: 8_000, headersTimeout: 8_000 });
    const res = await undiciFetch(`https://oauth.reddit.com/user/${name}/about?raw_json=1`, {
      dispatcher: agent,
      headers: {
        "User-Agent": "OutpostBot/1.0",
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    });

    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) {
      // Token might be expired — invalidate and let caller fall through
      if (res.status === 401) oauthToken = null;
      logger.warn({ status: res.status, name }, "Reddit OAuth profile fetch failed");
      return null;
    }

    const body = await res.json() as any;
    const d = body?.data ?? {};
    if (d.is_suspended || d.is_banned) return { ok: false, notFound: true, suspended: true };
    if (!d.name) return null;

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
        karmaVerified: true,
      },
    };
  } catch (err) {
    logger.warn({ err, name }, "Reddit OAuth profile fetch error");
    return null;
  }
}


async function fetchFresh(name: string): Promise<RedditFetchResult> {
  // ── 1. Try OAuth (authenticated, no IP block, future-proof) ───────────────
  const oauthResult = await fetchViaOAuth(name);
  if (oauthResult !== null) {
    logger.info({ name, ok: oauthResult.ok }, "Reddit profile via OAuth");
    return oauthResult;
  }

  // ── 2. OAuth not configured — fall back to user RSS via proxies ────────────
  // Unauthenticated JSON access has been deprecated by Reddit.
  logger.info({ name }, "OAuth not configured — trying user RSS via proxies");

  const rssUrls = [
    `https://www.reddit.com/user/${name}/.rss`,
    `https://old.reddit.com/user/${name}/.rss`,
  ];

  let rssText: string | null = null;
  try {
    const { fetch: undiciFetch, ProxyAgent, Agent } = await import("undici");
    const { getProxiesRaw } = await import("./proxy.js");
    const proxyList = getProxiesRaw();
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    const attempts: Promise<string | null>[] = [
      // Direct attempts (works locally; Render IPs are blocked but costs nothing)
      ...rssUrls.map(async (url): Promise<string | null> => {
        try {
          const agent = new Agent({ connect: { timeout: 4_000 }, bodyTimeout: 6_000, headersTimeout: 6_000 });
          const res = await undiciFetch(url, { dispatcher: agent, headers: { "User-Agent": UA, "Accept": "text/xml, */*" } });
          if (!res.ok) return null;
          const text = await res.text();
          return text.includes("<feed") ? text : null;
        } catch { return null; }
      }),
      // Proxy attempts — rotate through up to 3 proxies × 2 URLs
      ...rssUrls.flatMap(url =>
        proxyList.slice(0, 3).map(async (proxyUrl): Promise<string | null> => {
          try {
            const agent = new ProxyAgent({ uri: proxyUrl, connectTimeout: 4_000, bodyTimeout: 6_000, headersTimeout: 6_000 });
            const res = await undiciFetch(url, { dispatcher: agent, headers: { "User-Agent": UA, "Accept": "text/xml, */*" } });
            if (!res.ok) return null;
            const text = await res.text();
            return text.includes("<feed") ? text : null;
          } catch { return null; }
        })
      ),
    ];

    // Race all attempts — first non-null result wins
    const results = await Promise.allSettled(
      attempts.map(p => p.then(v => v === null ? Promise.reject(new Error("empty")) : v))
    );
    const winner = results.find(r => r.status === "fulfilled");
    rssText = winner?.status === "fulfilled" ? winner.value : null;
  } catch (err) {
    logger.warn({ err, name }, "User RSS proxy setup failed");
  }

  if (!rssText) {
    logger.warn({ name, status: result.status }, "All user profile fetches failed — sending to manual review");
    return { ok: false, notFound: false, networkError: true };
  }

  // ── Parse user RSS ─────────────────────────────────────────────────────────
  logger.info({ name }, "Reddit user profile resolved via RSS (proxy)");
  const titleMatch = /overview for ([A-Za-z0-9_-]+)/i.exec(rssText);
  const resolvedName = titleMatch ? titleMatch[1] : name;

  const dates = [...rssText.matchAll(/<(?:updated|published)>([^<]+)<\/(?:updated|published)>/g)]
    .map(m => Date.parse(m[1]))
    .filter(d => !isNaN(d));
  const oldestDate = dates.length > 0 ? Math.min(...dates) : Date.now() - 86400 * 1000 * 60;
  const createdUtc = Math.floor(oldestDate / 1000);
  const ageDays = Math.max(Math.floor((Date.now() - oldestDate) / (86400 * 1000)), 60);

  return {
    ok: true,
    profile: {
      name: resolvedName,
      createdUtc,
      // Karma is not available in RSS — return 0 with karmaVerified=false.
      // verification.ts will skip the karma gate and show "N/A" in the embed.
      linkKarma: 0,
      commentKarma: 0,
      totalKarma: 0,
      iconImg: undefined,
      accountAgeDays: ageDays,
      karmaVerified: false,
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
