import { logger } from "../lib/logger.js";
import { proxyFetchText, proxyFetchJson } from "./proxy.js";
import { executePythonRedditClient } from "./pythonClient.js";
import { getRedditSessionCookie } from "./redditCookieManager.js";

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


/**
 * Fetch Reddit profile data from the Arctic Shift public archive API.
 *
 * Arctic Shift (https://arctic-shift.photon-reddit.com) is a Reddit data archive
 * that indexes posts and comments. It is publicly accessible without authentication
 * and works reliably from datacenter IPs (e.g. Render, AWS) without proxies or auth.
 *
 * Strategy:
 *   - Sum all archived post + comment scores as a karma FLOOR (real karma ≥ this).
 *   - If the floor meets the ≥100 karma requirement, karmaVerified=true → auto-approve.
 *     (Real Reddit karma is always ≥ the sum of archived scores, so this is a safe lower bound.)
 *   - If below 100, karmaVerified=false → manual review.
 *   - The oldest archived created_utc gives an account age lower bound.
 *
 * Returns null only if the archive has zero entries for this user (new/unknown user).
 */
async function fetchViaArcticShift(name: string): Promise<RedditFetchResult | null> {
  const BASE = "https://arctic-shift.photon-reddit.com/api";
  // Fetch up to 1000 items to get a better karma floor estimate.
  const fields = "score,created_utc";

  try {
    const { fetch: undiciFetch, Agent } = await import("undici");
    const agent = new Agent({ connect: { timeout: 6_000 }, bodyTimeout: 12_000, headersTimeout: 12_000 });
    const headers = { "User-Agent": "OutpostBot/1.0", "Accept": "application/json" };

    const [postsRes, commentsRes] = await Promise.all([
      undiciFetch(`${BASE}/posts/search?author=${encodeURIComponent(name)}&limit=1000&fields=${fields}`, { dispatcher: agent, headers }),
      undiciFetch(`${BASE}/comments/search?author=${encodeURIComponent(name)}&limit=1000&fields=${fields}`, { dispatcher: agent, headers }),
    ]);

    if (!postsRes.ok || !commentsRes.ok) {
      logger.warn({ name, postStatus: postsRes.status, commentStatus: commentsRes.status }, "Arctic Shift API error");
      return null;
    }

    const [postsJson, commentsJson] = await Promise.all([
      postsRes.json() as Promise<{ data?: Array<{ score?: number; created_utc?: number }> }>,
      commentsRes.json() as Promise<{ data?: Array<{ score?: number; created_utc?: number }> }>,
    ]);

    const posts    = postsJson.data    ?? [];
    const comments = commentsJson.data ?? [];
    const all      = [...posts, ...comments];

    if (all.length === 0) {
      logger.info({ name }, "Arctic Shift: no archived entries for user — skipping");
      return null;
    }

    // ── Karma floor from archived scores ──────────────────────────────────────
    // Reddit karma is always ≥ the sum of a user's post/comment scores because:
    //   1. Reddit only archives posts/comments that received votes.
    //   2. The archive may be incomplete (not every post is indexed).
    // Therefore: sum(archived scores) ≤ actual karma ≤ ∞.
    // If this floor ≥ MIN_KARMA (100), the user definitely qualifies.
    //
    // Note: score=1 is the author's own upvote and contributes 0 net karma.
    // We subtract 1 from each item's score to account for this, giving a
    // conservative floor (actual karma may still be higher).
    const karmaFloor = all.reduce((sum, item) => {
      const s = typeof item.score === "number" ? Math.max(0, item.score - 1) : 0;
      return sum + s;
    }, 0);

    // Account age: oldest archived created_utc is a confirmed lower bound.
    const allUtcs   = all.map(i => i.created_utc).filter((v): v is number => typeof v === "number" && v > 0);
    const oldestUtc = allUtcs.length > 0 ? Math.min(...allUtcs) : 0;
    const ageDays   = oldestUtc ? Math.floor((Date.now() / 1000 - oldestUtc) / 86400) : 0;

    // If the karma floor meets the requirement, auto-verify.
    // Otherwise route to manual review (mods can check old.reddit.com).
    const karmaVerified = karmaFloor >= 100;

    logger.info(
      { name, posts: posts.length, comments: comments.length, karmaFloor, karmaVerified, ageDays },
      `Reddit profile via Arctic Shift archive (karma floor=${karmaFloor}, verified=${karmaVerified})`
    );

    return {
      ok: true,
      profile: {
        name,
        createdUtc: oldestUtc,
        linkKarma:    karmaFloor,   // floor, not exact — but safe to use as ≥ check
        commentKarma: 0,
        totalKarma:   karmaFloor,
        iconImg: undefined,
        accountAgeDays: ageDays,
        karmaVerified,
      },
    };
  } catch (err) {
    logger.warn({ err, name }, "fetchViaArcticShift error");
    return null;
  }
}


/**
 * Fetch Reddit user profile via public Reddit-frontend proxy instances.
 *
 * Teddit and Redlib are open-source Reddit frontends that proxy Reddit's API.
 * Their servers run proper residential/CDN IPs and forward requests to Reddit
 * on our behalf — so this works from datacenter IPs (Render/AWS) with no auth.
 *
 * Teddit exposes Reddit's raw JSON via `?api&raw_json=1`.
 * Redlib exposes a JSON API at `/user/{name}/about.json`.
 *
 * Multiple instances are tried in parallel; first valid karma response wins.
 * Returns null if all instances are down or return unexpected data.
 */
async function fetchViaPublicFrontend(name: string): Promise<RedditFetchResult | null> {
  // Public instances — ordered roughly by reliability / uptime history.
  // Mix of Teddit (?api format) and Redlib (.json format).
  const candidates: Array<{ url: string; format: "teddit" | "redlib" }> = [
    { url: `https://teddit.net/user/${name}/about.json`,              format: "teddit"  },
    { url: `https://teddit.pussthecat.org/user/${name}/about.json`,   format: "teddit"  },
    { url: `https://redlib.catsarch.com/user/${name}/about.json`,     format: "redlib"  },
    { url: `https://redlib.privacydev.net/user/${name}/about.json`,   format: "redlib"  },
    { url: `https://libreddit.kavin.rocks/user/${name}/about.json`,   format: "redlib"  },
  ];

  try {
    const { fetch: undiciFetch, Agent } = await import("undici");
    const agent = new Agent({ connect: { timeout: 6_000 }, bodyTimeout: 10_000, headersTimeout: 10_000 });

    // Fire all in parallel — first non-null result wins via Promise.any.
    const attempts = candidates.map(async ({ url, format }): Promise<RedditFetchResult> => {
      const res = await undiciFetch(url, {
        dispatcher: agent,
        headers: {
          "User-Agent": "OutpostBot/1.0",
          "Accept": "application/json",
        },
      });

      if (res.status === 404) return { ok: false, notFound: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      let body: any;
      try { body = await res.json(); } catch { throw new Error("invalid JSON"); }

      // Teddit returns Reddit's raw JSON: { kind: "t2", data: { name, link_karma, ... } }
      // Redlib might use the same format or a different structure.
      const d = body?.data ?? body;
      const username = d?.name ?? d?.username;
      const linkKarma = d?.link_karma ?? d?.linkKarma;
      const commentKarma = d?.comment_karma ?? d?.commentKarma;
      const totalKarma = d?.total_karma ?? d?.totalKarma;
      const createdUtc = d?.created_utc ?? d?.createdUtc;

      // Validate we got real karma data (not a login page or error page masquerading as JSON)
      if (!username || (typeof linkKarma !== "number" && typeof commentKarma !== "number" && typeof totalKarma !== "number")) {
        throw new Error(`no karma in response (format=${format})`);
      }

      if (d?.is_suspended || d?.isSuspended) return { ok: false, notFound: true, suspended: true };

      const lk = typeof linkKarma === "number" ? linkKarma : 0;
      const ck = typeof commentKarma === "number" ? commentKarma : 0;
      const tk = typeof totalKarma === "number" ? totalKarma : lk + ck;
      const cu: number = typeof createdUtc === "number" ? createdUtc : 0;
      const ageDays = cu ? Math.floor((Date.now() / 1000 - cu) / 86400) : 0;

      logger.info({ name: username, url, format, lk, ck, tk, ageDays }, "Reddit profile via public frontend proxy");

      return {
        ok: true,
        profile: {
          name: username as string,
          createdUtc: cu,
          linkKarma: lk,
          commentKarma: ck,
          totalKarma: tk,
          iconImg: stripQuery(d?.icon_img ?? d?.iconImg),
          accountAgeDays: ageDays,
          karmaVerified: true,
        },
      };
    });

    // Return the first successful (ok:true) result.
    const result = await Promise.any(
      attempts.map(async (p) => {
        const r = await p;
        if (!r.ok) throw new Error("not-found");
        return r;
      })
    ).catch(() => null);

    if (result) return result;

    // If all returned not-found (suspended/banned), that's still a valid answer.
    const allResults = await Promise.allSettled(attempts);
    for (const r of allResults) {
      if (r.status === "fulfilled" && !r.value.ok && "notFound" in r.value && r.value.notFound) {
        return r.value;
      }
    }
  } catch (err) {
    logger.debug({ err, name }, "fetchViaPublicFrontend: unexpected error");
  }

  logger.warn({ name }, "fetchViaPublicFrontend: all instances failed or returned no karma");
  return null;
}

/**
 * Direct JSON probe — try the public about.json endpoint, routing through the
 * proxy pool when proxies are configured so Render's datacenter IP is masked.
 *
 * proxyFetchJson races up to 3 proxies + a direct fallback simultaneously.
 * If no proxies are loaded it behaves identically to a plain direct request.
 * On success we get real, verified karma. On failure we return null and the
 * caller falls through to the next method.
 */
async function fetchViaDirectJson(name: string): Promise<RedditFetchResult | null> {
  const candidates = [
    `https://old.reddit.com/user/${name}/about.json?raw_json=1`,
    `https://www.reddit.com/user/${name}/about.json?raw_json=1`,
  ];

  try {
    const headers: Record<string, string> = {};
    const sessionCookie = getRedditSessionCookie();
    if (sessionCookie) {
      headers["Cookie"] = sessionCookie;
    }

    const result = await proxyFetchJson(candidates, {
      timeoutMs: 10_000,
      acceptHeader: "application/json",
      headers,
    });

    if (!result.ok) return null;

    const body = result.body;
    if (body?.kind === "t2" && body?.data?.name === undefined) return null;

    // 404-style: user not found
    if (body?.error === 404 || body?.message === "Not Found") return { ok: false, notFound: true };

    const d = body?.data ?? {};
    if (!d.name) return null;
    if (d.is_suspended || d.is_banned) return { ok: false, notFound: true, suspended: true };

    const createdUtc: number = typeof d.created_utc === "number" ? d.created_utc : 0;
    const ageDays = createdUtc ? Math.floor((Date.now() / 1000 - createdUtc) / 86400) : 0;

    logger.info({ name: d.name, via: result.via }, "Reddit profile via JSON endpoint (proxy-routed)");
    return {
      ok: true,
      profile: {
        name: d.name as string,
        createdUtc,
        linkKarma:    (d.link_karma    as number) ?? 0,
        commentKarma: (d.comment_karma as number) ?? 0,
        totalKarma:   (d.total_karma   as number) ?? (((d.link_karma as number) ?? 0) + ((d.comment_karma as number) ?? 0)),
        iconImg:      stripQuery(d.icon_img as string | undefined),
        accountAgeDays: ageDays,
        karmaVerified: true,
      },
    };
  } catch (err) {
    logger.debug({ err, name }, "fetchViaDirectJson: all attempts failed");
  }

  return null;
}

/**
 * Extract karma from new Reddit's (shreddit) server-rendered page HTML.
 *
 * www.reddit.com user-about pages embed user profile JSON inside <script> tags
 * even on the initial server-side render — no JavaScript execution needed.
 * The page is generally reachable from datacenter IPs without proxies or auth.
 *
 * We look for standard Reddit JSON field names directly in the raw HTML:
 *   "link_karma":N, "comment_karma":N, "total_karma":N, "created_utc":N
 * Multiple occurrences are expected (repeated in different script blobs);
 * we take the first valid (non-zero karma) hit.
 *
 * Returns null if we cannot extract meaningful karma data.
 */
async function fetchViaNewRedditHtml(name: string): Promise<RedditFetchResult | null> {
  const url = `https://www.reddit.com/user/${name}/about`;
  try {
    const { fetch: undiciFetch, Agent } = await import("undici");
    const agent = new Agent({ connect: { timeout: 6_000 }, bodyTimeout: 14_000, headersTimeout: 14_000 });

    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    };
    const sessionCookie = getRedditSessionCookie();
    if (sessionCookie) {
      headers["Cookie"] = sessionCookie;
    }

    const res = await undiciFetch(url, {
      dispatcher: agent,
      headers,
    });

    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) {
      logger.debug({ name, status: res.status }, "fetchViaNewRedditHtml: non-200 response");
      return null;
    }

    const html = await res.text();

    // Suspended / not-found detection
    if (
      html.includes("has been suspended") ||
      html.includes("account-suspended") ||
      (html.includes("page not found") && !html.includes(name.toLowerCase()))
    ) {
      return { ok: false, notFound: true, suspended: true };
    }

    // ── Extract karma fields from embedded JSON blobs ──────────────────────
    // Reddit may repeat these fields multiple times in different script tags;
    // gather ALL occurrences and pick the most credible (highest sum, ≥1).

    function extractAll(pattern: RegExp): number[] {
      const results: number[] = [];
      let m: RegExpExecArray | null;
      const re = new RegExp(pattern.source, "g");
      while ((m = re.exec(html)) !== null) {
        const v = parseInt(m[1]!, 10);
        if (!isNaN(v)) results.push(v);
      }
      return results;
    }

    const linkKarmas    = extractAll(/"link_karma"\s*:\s*(\d+)/);
    const commentKarmas = extractAll(/"comment_karma"\s*:\s*(\d+)/);
    const totalKarmas   = extractAll(/"total_karma"\s*:\s*(\d+)/);
    const createdUtcs   = extractAll(/"created_utc"\s*:\s*(\d+(?:\.\d+)?)/);

    // Prefer the largest value seen (most likely the canonical profile block).
    const linkKarma    = linkKarmas.length    ? Math.max(...linkKarmas)    : 0;
    const commentKarma = commentKarmas.length ? Math.max(...commentKarmas) : 0;
    const totalKarma   = totalKarmas.length   ? Math.max(...totalKarmas)   : linkKarma + commentKarma;

    // Sanity check — if we found nothing useful, this method didn't work.
    if (linkKarma === 0 && commentKarma === 0 && totalKarma === 0) {
      logger.debug({ name, htmlLen: html.length }, "fetchViaNewRedditHtml: no karma fields found in embedded HTML");
      return null;
    }

    const createdUtc = createdUtcs.length ? Math.min(...createdUtcs) : 0; // oldest timestamp = account creation
    const ageDays    = createdUtc ? Math.floor((Date.now() / 1000 - createdUtc) / 86400) : 0;

    // Best-effort canonical username extraction
    const nameMatch = new RegExp(`"name"\\s*:\\s*"(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})"`, "i").exec(html);
    const resolvedName = nameMatch ? nameMatch[1]! : name;

    // Best-effort avatar
    const iconMatch = /"icon_img"\s*:\s*"([^"]+https[^"]+)"/.exec(html);
    const iconImg   = iconMatch ? stripQuery(iconMatch[1]) : undefined;

    logger.info({ name: resolvedName, linkKarma, commentKarma, totalKarma, ageDays }, "Reddit profile via new-Reddit embedded HTML (karmaVerified=true)");

    return {
      ok: true,
      profile: {
        name: resolvedName,
        createdUtc,
        linkKarma,
        commentKarma,
        totalKarma,
        iconImg,
        accountAgeDays: ageDays,
        karmaVerified: true,
      },
    };
  } catch (err) {
    logger.warn({ err, name }, "fetchViaNewRedditHtml error");
    return null;
  }
}

/**
 * Scrape old.reddit.com/user/{name}/about HTML to extract karma and account age.
 *
 * old.reddit.com user profile pages are still publicly accessible and contain
 * karma numbers in the sidebar HTML even without authentication.
 *
 * Extracts:
 *   - Link karma:    <span class="karma link-karma">N</span>
 *   - Comment karma: <span class="karma comment-karma">N</span>
 *   - Created date:  <span class="age">...<time datetime="ISO">...</time></span>
 *
 * Returns null if the page could not be fetched or parsed.
 */
async function fetchViaHtmlScrape(name: string): Promise<RedditFetchResult | null> {
  const profileUrls = [
    `https://old.reddit.com/user/${name}/about`,
    `https://old.reddit.com/user/${name}`,
    `https://www.reddit.com/user/${name}/about`,
  ];

  let html: string | null = null;
  try {
    const headers: Record<string, string> = {};
    const sessionCookie = getRedditSessionCookie();
    if (sessionCookie) {
      headers["Cookie"] = sessionCookie;
    }
    html = await proxyFetchText(profileUrls, {
      timeoutMs: 12_000,
      acceptHeader: "text/html, */*",
      headers,
    });
  } catch (err) {
    logger.warn({ err, name }, "fetchViaHtmlScrape: proxyFetchText threw");
    return null;
  }

  if (!html) {
    logger.warn({ name }, "fetchViaHtmlScrape: no HTML returned");
    return null;
  }

  // Verify this actually looks like an old.reddit user profile page
  const isUserPage =
    html.includes('class="titlebox"') ||
    html.includes('class="karma link-karma"') ||
    html.includes('class="karma comment-karma"') ||
    html.includes("redditor for") ||
    html.includes(`/user/${name}`);

  if (!isUserPage) {
    logger.warn({ name, htmlLen: html.length }, "fetchViaHtmlScrape: response doesn't look like a user profile page");
    return null;
  }

  // ── Detect suspended / banned accounts ────────────────────────────────────
  if (
    html.includes("has been suspended") ||
    html.includes("account has been suspended") ||
    html.includes("page not found") && html.toLowerCase().includes("sorry")
  ) {
    logger.info({ name }, "fetchViaHtmlScrape: account suspended/not found");
    return { ok: false, notFound: true, suspended: true };
  }

  // ── Detect private / user-not-found pages ─────────────────────────────────
  if (
    (html.includes("page not found") || html.includes("there doesn't seem to be anything here")) &&
    !html.includes('class="karma')
  ) {
    logger.info({ name }, "fetchViaHtmlScrape: user not found");
    return { ok: false, notFound: true };
  }

  // ── Parse link karma ───────────────────────────────────────────────────────
  // old.reddit: <span class="karma link-karma">1,234</span>
  // Also handles: <span class="karma">1,234</span> (total only) on some layouts
  const linkKarmaMatch = /class="karma link-karma"[^>]*>([\d,]+)</.exec(html);
  const commentKarmaMatch = /class="karma comment-karma"[^>]*>([\d,]+)</.exec(html);

  const parseKarma = (s: string): number => parseInt(s.replace(/,/g, ""), 10) || 0;

  const linkKarma    = linkKarmaMatch    ? parseKarma(linkKarmaMatch[1])    : 0;
  const commentKarma = commentKarmaMatch ? parseKarma(commentKarmaMatch[1]) : 0;
  const totalKarma   = linkKarma + commentKarma;

  // If we couldn't extract any karma numbers at all, this page isn't useful
  if (!linkKarmaMatch && !commentKarmaMatch) {
    logger.warn({ name, htmlLen: html.length }, "fetchViaHtmlScrape: no karma elements found in HTML");
    return null;
  }

  // ── Parse account creation date ────────────────────────────────────────────
  // old.reddit: <span class="age">redditor for <time datetime="2020-01-01T00:00:00+00:00" title="...">N years</time></span>
  let createdUtc = 0;
  const ageMatch = /class="age"[^>]*>[\s\S]{0,80}?<time[^>]+datetime="([^"]+)"/.exec(html);
  if (ageMatch) {
    const parsed = Date.parse(ageMatch[1]);
    if (!isNaN(parsed)) createdUtc = Math.floor(parsed / 1000);
  }

  // Fallback: look for any <time datetime="..."> near "redditor"
  if (!createdUtc) {
    const redditorIdx = html.toLowerCase().indexOf("redditor");
    if (redditorIdx !== -1) {
      const segment = html.substring(redditorIdx, redditorIdx + 300);
      const timeMatch = /datetime="([^"]+)"/.exec(segment);
      if (timeMatch) {
        const parsed = Date.parse(timeMatch[1]);
        if (!isNaN(parsed)) createdUtc = Math.floor(parsed / 1000);
      }
    }
  }

  const ageDays = createdUtc
    ? Math.floor((Date.now() / 1000 - createdUtc) / 86400)
    : 0;

  // ── Resolve canonical username from page ────────────────────────────────────
  const usernameMatch = /\/user\/([A-Za-z0-9_-]{3,20})\//.exec(html);
  const resolvedName = usernameMatch ? usernameMatch[1] : name;

  logger.info({ name: resolvedName, linkKarma, commentKarma, ageDays }, "Reddit profile via old.reddit HTML scrape");

  return {
    ok: true,
    profile: {
      name: resolvedName,
      createdUtc,
      linkKarma,
      commentKarma,
      totalKarma,
      iconImg: undefined,
      accountAgeDays: ageDays,
      karmaVerified: true,
    },
  };
}


async function fetchViaPythonClient(name: string): Promise<RedditFetchResult | null> {
  try {
    const url = `https://www.reddit.com/user/${name}/about.json?raw_json=1`;
    const visitFirst = `https://www.reddit.com/user/${name}/`;

    const result = await executePythonRedditClient({
      url,
      visitFirst,
      isJson: true,
      useProxy: true,
    });

    if (!result.ok) return null;

    const body = result.body;
    if (body?.kind === "t2" && body?.data?.name === undefined) return null;

    if (body?.error === 404 || body?.message === "Not Found") return { ok: false, notFound: true };

    const d = body?.data ?? {};
    if (!d.name) return null;
    if (d.is_suspended || d.is_banned) return { ok: false, notFound: true, suspended: true };

    const createdUtc: number = typeof d.created_utc === "number" ? d.created_utc : 0;
    const ageDays = createdUtc ? Math.floor((Date.now() / 1000 - createdUtc) / 86400) : 0;

    logger.info({ name: d.name, via: result.via }, "Reddit profile via Python curl_cffi client");
    return {
      ok: true,
      profile: {
        name: d.name as string,
        createdUtc,
        linkKarma:    (d.link_karma    as number) ?? 0,
        commentKarma: (d.comment_karma as number) ?? 0,
        totalKarma:   (d.total_karma   as number) ?? (((d.link_karma as number) ?? 0) + ((d.comment_karma as number) ?? 0)),
        iconImg:      stripQuery(d.icon_img as string | undefined),
        accountAgeDays: ageDays,
        karmaVerified: true,
      },
    };
  } catch (err) {
    logger.warn({ err, name }, "fetchViaPythonClient failed");
  }
  return null;
}


/**
 * Fetch Reddit user profile by fetching the HTML page via Python curl_cffi
 * and extracting the embedded JSON karma data.
 *
 * Reddit's new-UI HTML page (www.reddit.com/user/{name}/about) embeds the full
 * user profile JSON inside <script> tags on first render.  Fetching HTML (not
 * the JSON API) is far less likely to trigger Cloudflare blocks — combined with
 * curl_cffi Chrome TLS impersonation it works even from datacenter IPs and
 * without a session cookie.
 *
 * This is effectively fetchViaNewRedditHtml but powered by the Python client
 * instead of a plain undici fetch.
 */
async function fetchViaPythonHtml(name: string): Promise<RedditFetchResult | null> {
  try {
    const url = `https://www.reddit.com/user/${name}/about`;
    const result = await executePythonRedditClient({
      url,
      isJson: false,
      useProxy: true,
    });

    if (!result.ok || typeof result.body !== "string") return null;
    const html: string = result.body;

    // Suspended / not-found detection
    if (html.includes("has been suspended") || html.includes("account-suspended")) {
      return { ok: false, notFound: true, suspended: true };
    }
    if (html.includes("page not found") && !html.includes(name.toLowerCase())) {
      return { ok: false, notFound: true };
    }

    // Extract karma fields from the server-rendered JSON blobs embedded in the page.
    function extractAll(pattern: RegExp): number[] {
      const out: number[] = [];
      let m: RegExpExecArray | null;
      const re = new RegExp(pattern.source, "g");
      while ((m = re.exec(html)) !== null) {
        const v = parseInt(m[1]!, 10);
        if (!isNaN(v)) out.push(v);
      }
      return out;
    }

    const linkKarmas    = extractAll(/"link_karma"\s*:\s*(\d+)/);
    const commentKarmas = extractAll(/"comment_karma"\s*:\s*(\d+)/);
    const totalKarmas   = extractAll(/"total_karma"\s*:\s*(\d+)/);
    const createdUtcs   = extractAll(/"created_utc"\s*:\s*(\d+(?:\.\d+)?)/);

    const linkKarma    = linkKarmas.length    ? Math.max(...linkKarmas)    : 0;
    const commentKarma = commentKarmas.length ? Math.max(...commentKarmas) : 0;
    const totalKarma   = totalKarmas.length   ? Math.max(...totalKarmas)   : linkKarma + commentKarma;

    if (linkKarma === 0 && commentKarma === 0 && totalKarma === 0) {
      logger.debug({ name, htmlLen: html.length }, "fetchViaPythonHtml: no karma fields in page");
      return null;
    }

    const createdUtc = createdUtcs.length ? Math.min(...createdUtcs) : 0;
    const ageDays    = createdUtc ? Math.floor((Date.now() / 1000 - createdUtc) / 86400) : 0;

    const nameMatch = new RegExp(`"name"\\s*:\\s*"(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})"`, "i").exec(html);
    const resolvedName = nameMatch ? nameMatch[1]! : name;

    const iconMatch = /"icon_img"\s*:\s*"([^"]+https[^"]+)"/.exec(html);
    const iconImg   = iconMatch ? stripQuery(iconMatch[1]) : undefined;

    logger.info({ name: resolvedName, linkKarma, commentKarma, totalKarma, ageDays, via: result.via }, "Reddit profile via Python curl_cffi HTML scrape");

    return {
      ok: true,
      profile: {
        name: resolvedName,
        createdUtc,
        linkKarma,
        commentKarma,
        totalKarma,
        iconImg,
        accountAgeDays: ageDays,
        karmaVerified: true,
      },
    };
  } catch (err) {
    logger.warn({ err, name }, "fetchViaPythonHtml failed");
  }
  return null;
}


async function fetchFresh(name: string): Promise<RedditFetchResult> {
  // ── 1. Python curl_cffi JSON (PRIMARY) + OAuth (FALLBACK) — in parallel ───
  // Python browser TLS impersonation bypasses datacenter IP blocks that reject
  // unauthenticated Reddit API calls from server IPs.
  // Both fire simultaneously so we pay only one round-trip of latency.
  // Python result is preferred; OAuth is used only if Python returns null.
  const [pythonResult, oauthResult] = await Promise.all([
    fetchViaPythonClient(name).catch(() => null),
    fetchViaOAuth(name).catch(() => null),
  ]);
  if (pythonResult !== null) {
    logger.info({ name, ok: pythonResult.ok }, "Reddit profile via Python curl_cffi JSON (primary)");
    return pythonResult;
  }
  if (oauthResult !== null) {
    logger.info({ name, ok: oauthResult.ok }, "Reddit profile via OAuth (Python JSON unavailable — fallback)");
    return oauthResult;
  }

  // ── 1b. Python curl_cffi HTML — JSON endpoint blocked, try HTML page ───────
  // When Cloudflare challenges the JSON API endpoint, the full HTML page is
  // typically served without challenge to a browser-fingerprinted client.
  // Reddit server-renders karma inside <script> tags, so we can extract it
  // from the HTML even without running JavaScript.
  logger.info({ name }, "Python JSON + OAuth both failed — trying Python HTML scrape");
  const pythonHtmlResult = await fetchViaPythonHtml(name);
  if (pythonHtmlResult !== null) {
    logger.info({ name, ok: pythonHtmlResult.ok }, "Reddit profile via Python curl_cffi HTML (primary fallback)");
    return pythonHtmlResult;
  }

  // ── 2. Arctic Shift public archive API (no auth, no proxy, works from Render) ─
  // arctic-shift.photon-reddit.com indexes Reddit posts/comments publicly and is
  // reachable from datacenter IPs without auth. We use archived score sum as a
  // karma FLOOR: if floor ≥ 100, the user definitely has ≥ 100 karma → auto-verify.
  // If below, we fall through and try other methods before routing to manual review.
  logger.info({ name }, "Python client unavailable — trying Arctic Shift karma floor");
  const arcticResult = await fetchViaArcticShift(name);
  if (arcticResult !== null && arcticResult.ok && arcticResult.profile.karmaVerified) {
    logger.info({ name, karmaFloor: arcticResult.profile.totalKarma }, "Reddit profile via Arctic Shift (karma floor verified)");
    return arcticResult;
  }

  // ── 3. Public Reddit-frontend proxies (Teddit / Redlib) ────────────────────
  // These open-source frontends run on residential/CDN IPs and proxy Reddit's
  // API — so they work from datacenter IPs (Render/AWS) with no auth required.
  // Multiple instances tried in parallel; first with real karma data wins.
  logger.info({ name }, "Arctic Shift karma floor not met or no entries — trying public Reddit-frontend proxies");
  const frontendResult = await fetchViaPublicFrontend(name);
  if (frontendResult !== null) {
    logger.info({ name, ok: frontendResult.ok }, "Reddit profile via public frontend proxy");
    return frontendResult;
  }

  // ── 4. Direct JSON probe (no auth, no proxy, low latency) ─────────────────
  // Try old.reddit.com/user/{name}/about.json directly — still reachable from
  // many server IPs even after Reddit's 2023 API changes.
  logger.info({ name }, "Public frontends failed — trying direct JSON probe");
  const directJsonResult = await fetchViaDirectJson(name);
  if (directJsonResult !== null) {
    logger.info({ name, ok: directJsonResult.ok }, "Reddit profile via direct JSON");
    return directJsonResult;
  }

  // ── 5. new Reddit embedded-JSON scrape (no auth, no proxy needed) ──────────
  // www.reddit.com/user/{name}/about server-renders user profile data (including
  // karma) inside <script> tags even from datacenter IPs. Extract with regex.
  logger.info({ name }, "Direct JSON blocked — trying new-Reddit embedded HTML");
  const newRedditResult = await fetchViaNewRedditHtml(name);
  if (newRedditResult !== null) {
    logger.info({ name, ok: newRedditResult.ok }, "Reddit profile via new-Reddit HTML");
    return newRedditResult;
  }

  // ── 6. Scrape old.reddit.com user profile HTML via proxies ────────────────
  // old.reddit HTML pages contain karma in the sidebar; works when the proxy
  // pool has residential (non-datacenter) IPs that bypass Reddit's CDN block.
  logger.info({ name }, "new-Reddit scrape failed — trying old.reddit HTML scrape via proxies");
  const htmlResult = await fetchViaHtmlScrape(name);
  if (htmlResult !== null) {
    logger.info({ name, ok: htmlResult.ok }, "Reddit profile via old.reddit HTML scrape");
    return htmlResult;
  }

  // ── 7. Arctic Shift fallback (low-karma accounts / no karma floor met) ─────
  // If the karma floor wasn't high enough to auto-verify above, use the Arctic
  // Shift result anyway (if we got one) so at least the account age is known.
  // karmaVerified=false will route to manual review in verification.ts.
  if (arcticResult !== null) {
    logger.info({ name, ok: arcticResult.ok }, "Reddit profile via Arctic Shift archive (low-karma fallback)");
    return arcticResult;
  }

  // ── 6. Last resort: user RSS via proxies (no karma, triggers manual review) ─
  // RSS feeds are still available but do NOT contain karma data.
  logger.info({ name }, "Arctic Shift found nothing — falling back to user RSS (no karma data)");

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
          const headers: Record<string, string> = { "User-Agent": UA, "Accept": "text/xml, */*" };
          const sc = getRedditSessionCookie();
          if (sc) headers["Cookie"] = sc;
          const res = await undiciFetch(url, { dispatcher: agent, headers });
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
            const headers: Record<string, string> = { "User-Agent": UA, "Accept": "text/xml, */*" };
            const sc = getRedditSessionCookie();
            if (sc) headers["Cookie"] = sc;
            const res = await undiciFetch(url, { dispatcher: agent, headers });
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
    logger.warn({ name }, "All user profile fetches failed — sending to manual review");
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
