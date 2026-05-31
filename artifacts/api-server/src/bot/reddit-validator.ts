import { logger } from "../lib/logger.js";
import { proxyFetchText } from "./proxy.js";
import { fetch as undiciFetch } from "undici";
import { executePythonRedditClient } from "./pythonClient.js";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Fetch text content (RSS/XML/HTML) via proxy rotation.
 * Tries the proxy pool first; falls back to direct if no proxies are loaded.
 * This replaces the original direct-only fetchDirectText so the sweeper can
 * reach Reddit even when the server's IP is rate-limited or blocked.
 */
async function fetchDirectText(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    let text = await proxyFetchText([url], { timeoutMs, acceptHeader: "application/xml, text/xml, text/html, */*" });
    if (!text) {
      logger.info({ url }, "fetchDirectText: proxy fetch returned null, trying Python client fallback");
      const pyRes = await executePythonRedditClient({
        url,
        isJson: false,
        useProxy: true,
        timeout: Math.floor(timeoutMs / 1000),
      }).catch(() => null);
      if (pyRes && pyRes.ok && typeof pyRes.body === "string") {
        text = pyRes.body;
      }
    }
    return text;
  } catch (err) {
    logger.warn({ url, err }, "fetchDirectText proxy fetch unexpected error");
    return null;
  }
}

/**
 * Resolves a Reddit share short-link (reddit.com/r/sub/s/XXXX) by following
 * its 301 redirect and returning the canonical post/comment URL.
 *
 * Reddit's share links are mobile-app-generated and always redirect to the
 * full browser URL. We follow the redirect with a HEAD request so we don't
 * download the full page body.
 *
 * Returns the resolved URL string, or null on failure.
 */
export async function resolveShareLink(shareUrl: string, timeoutMs = 8000): Promise<string | null> {
  const cookieHeaders: Record<string, string> = {};
  if (process.env.REDDIT_SESSION_COOKIE) {
    cookieHeaders["Cookie"] = process.env.REDDIT_SESSION_COOKIE;
  }

  // ── Strategy 1: HEAD + redirect:manual (fastest, reads Location header) ───
  // Works when the server receives a proper 301/302 from Reddit's CDN.
  try {
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort(), Math.min(timeoutMs, 5000));
    try {
      const res = await undiciFetch(shareUrl, {
        method: "HEAD",
        headers: { "User-Agent": DEFAULT_UA, ...cookieHeaders },
        signal: ctrl1.signal,
        redirect: "manual",
      });
      const location = res.headers.get("location");
      if (location && location.includes("/comments/")) {
        const resolved = location.startsWith("/")
          ? `https://www.reddit.com${location}`
          : location;
        logger.info({ shareUrl, resolved, via: "HEAD/manual" }, "Share link resolved");
        return resolved;
      }
    } finally {
      clearTimeout(t1);
    }
  } catch (err) {
    logger.debug({ shareUrl, err }, "resolveShareLink: HEAD/manual attempt failed");
  }

  // ── Strategy 2: GET + redirect:follow (handles 200-HTML responses) ─────────
  // Datacenter IPs sometimes receive a 200 HTML page (login wall / regional
  // redirect) instead of a 301. With redirect:follow, undici tracks the final
  // URL after all hops and we can read it from the response URL.
  try {
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), timeoutMs);
    try {
      const res = await undiciFetch(shareUrl, {
        method: "GET",
        headers: {
          "User-Agent": DEFAULT_UA,
          "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
          ...cookieHeaders,
        },
        signal: ctrl2.signal,
        redirect: "follow",
      });

      // If we followed redirects, the final URL is where we landed.
      const finalUrl = res.url ?? "";
      if (finalUrl.includes("/comments/")) {
        // Strip query-string tracking params Reddit appends on redirect.
        const clean = finalUrl.split("?")[0]!.replace(/\/$/, "");
        logger.info({ shareUrl, resolved: clean, via: "GET/follow" }, "Share link resolved via redirect follow");
        return clean;
      }

      // Fallback: parse the <link rel="canonical"> or og:url from the HTML body.
      const html = await res.text();
      const canonicalMatch =
        /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html) ??
        /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i.exec(html);
      if (canonicalMatch) {
        const candidate = canonicalMatch[1]!;
        if (candidate.includes("/comments/")) {
          const clean = candidate.split("?")[0]!.replace(/\/$/, "");
          logger.info({ shareUrl, resolved: clean, via: "GET/canonical" }, "Share link resolved via canonical tag");
          return clean;
        }
      }
    } finally {
      clearTimeout(t2);
    }
  } catch (err) {
    logger.debug({ shareUrl, err }, "resolveShareLink: GET/follow attempt failed");
  }

  logger.warn({ shareUrl }, "resolveShareLink: all strategies failed");
  return null;
}

/**
 * Fetches the old.reddit.com HTML for a specific comment permalink and returns
 * whether the comment container is present (= publicly visible) in the page.
 *
 * old.reddit is significantly more resistant to IP-based rate limiting than the
 * JSON API, and its HTML accurately reflects a comment's removal state:
 *   - Comment present with noncollapsed class → live and publicly visible
 *   - Comment present with collapsed class → collapsed/removed
 *   - Comment container absent entirely → fully removed / shadow-banned
 *
 * Returns:
 *   true  — comment is visible in old.reddit HTML
 *   false — comment is absent or collapsed (removed/deleted/spam-filtered)
 *   null  — could not fetch HTML (network error / rate-limited)
 */
async function isCommentVisibleOnOldReddit(
  subreddit: string,
  postId: string,
  commentId: string,
  isUserPost = false,
  timeoutMs = 10000
): Promise<boolean | null> {
  const sub = isUserPost ? `user/${subreddit.slice(2)}` : `r/${subreddit}`;
  // Try both old.reddit (most rate-limit-resistant) and www.reddit as fallback.
  const urls = [
    `https://old.reddit.com/${sub}/comments/${postId}/_/${commentId}/`,
    `https://www.reddit.com/${sub}/comments/${postId}/_/${commentId}/`,
  ];
  try {
    const html = await proxyFetchText(urls, { timeoutMs, acceptHeader: "text/html, */*" });
    if (!html) {
      logger.warn({ urls, commentId }, "old.reddit HTML fetch returned null — inconclusive");
      return null;
    }

    // ── Sanity-check: is this actually a Reddit thread page? ────────────────
    // Proxies can return CAPTCHA pages, Cloudflare challenges, or error pages.
    // If the HTML doesn’t look like old.reddit, we can't trust the result.
    // old.reddit thread pages always contain these markers:
    const isRealRedditPage =
      html.includes('class="commentarea"') ||
      html.includes('class="comment"')     ||
      html.includes('data-subreddit=')     ||
      html.includes('class="thing"')       ||
      html.includes('id="siteTable"');
    if (!isRealRedditPage) {
      logger.warn(
        { commentId, subreddit, htmlLen: html.length },
        "old.reddit HTML doesn’t look like a Reddit page (proxy returned CAPTCHA/error?) — inconclusive"
      );
      return null;
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Look for the comment’s container div by its id attribute.
    // old.reddit uses id="thing_t1_<commentId>" for each comment div.
    const containerPresent = html.includes(`id="thing_t1_${commentId}"`);
    if (!containerPresent) {
      logger.info({ commentId, subreddit }, "Comment NOT found in old.reddit HTML — treated as removed");
      return false;
    }
    // Check if the container is in a collapsed (removed/deleted) state.
    // old.reddit adds class "collapsed" to hidden/removed comments.
    const idx = html.indexOf(`id="thing_t1_${commentId}"`);
    // Grab the opening tag of the container (which is always a few chars before the id attr)
    const fragmentStart = Math.max(0, idx - 300);
    const fragment = html.substring(fragmentStart, idx + 200);
    // Collapsed pattern: class="... collapsed ..."
    const isCollapsed = /class="[^"]*\bcollapsed\b[^"]*"/.test(fragment);
    if (isCollapsed) {
      logger.info({ commentId, subreddit }, "Comment is collapsed in old.reddit HTML — treated as removed");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ urls, err }, "old.reddit HTML liveness check failed");
    return null;
  }
}


export type SubmissionStatus =
  | "live"
  | "deleted_by_author"
  | "removed_by_mod"
  | "removed_by_reddit"
  | "removed_by_automod"
  | "locked"
  | "not_found"
  | "wrong_subreddit"
  | "wrong_post"
  | "author_mismatch"
  | "comment_missing"
  | "comment_deleted"
  | "comment_too_short"
  | "stale_proof"
  | "url_invalid"
  | "api_unreachable";

export interface ValidationResult {
  passed: boolean;
  autoApproved: boolean;
  status: SubmissionStatus;
  failures: string[];
  authorFound?: string;
  subredditFound?: string;
  postLive?: boolean;
  upvotes?: number;
  numComments?: number;
  ageMinutes?: number;
  statusEmoji: string;
  statusLabel: string;
  title?: string;
  createdAt?: string;
  /** Which source confirmed the comment was live: 'oauth' | 'json_proxy' | 'html' | 'rss' */
  verifiedVia?: "oauth" | "json_proxy" | "html" | "rss";
  /** Raw comment body text as read by the checker — useful for debugging deletion detection */
  bodyText?: string;
}

// Minimum chars a comment body must contain (after stripping HTML tags).
// Stops trivial one-word comments like "Nice!" from passing.
// 0 = disabled. Can be raised per-deployment via env var.
const MIN_COMMENT_CHARS = Number(process.env.MIN_COMMENT_CHARS ?? 0);

// How many milliseconds BEFORE the task was created a comment is still
// allowed to be (grace period for admins who create tasks retroactively).
const TASK_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

const STATUS_META: Record<SubmissionStatus, { emoji: string; label: string }> = {
  live: { emoji: "✅", label: "Live" },
  deleted_by_author: { emoji: "🗑️", label: "Deleted by author" },
  removed_by_mod: { emoji: "🛡️", label: "Removed by subreddit mod" },
  removed_by_reddit: { emoji: "🚫", label: "Removed by Reddit (anti-spam / TOS)" },
  removed_by_automod: { emoji: "🤖", label: "Filtered by AutoMod" },
  locked: { emoji: "🔒", label: "Post is locked" },
  not_found: { emoji: "❌", label: "Post not found / 404" },
  wrong_subreddit: { emoji: "🚷", label: "Wrong subreddit" },
  wrong_post: { emoji: "🎯", label: "Comment on wrong post" },
  author_mismatch: { emoji: "👤", label: "Author mismatch" },
  comment_missing: { emoji: "❓", label: "Comment not found on post" },
  comment_deleted: { emoji: "🗑️", label: "Comment deleted/removed" },
  comment_too_short: { emoji: "✏️", label: "Comment too short" },
  stale_proof: { emoji: "🕰️", label: "Comment predates task" },
  url_invalid: { emoji: "⚠️", label: "Invalid Reddit URL" },
  api_unreachable: { emoji: "📡", label: "Reddit API unreachable" },
};

function meta(status: SubmissionStatus) {
  const m = STATUS_META[status];
  return { statusEmoji: m.emoji, statusLabel: m.label };
}

/**
 * Detects whether a URL is a Reddit app deep link / share link that CANNOT
 * be validated by the API (no subreddit/post path available).
 *
 * Returns a human-readable rejection reason string, or null if the URL looks
 * like a normal browser URL that we can try to parse.
 *
 * Patterns detected:
 *   - reddit://          (iOS/Android app scheme)
 *   - reddit.app.link    (branch.io universal links)
 *   - reddit.com/r/X/s/Y (new share short-links, no post path)
 *   - redd.it/X          (old short links, need browser redirect)
 */
export function detectAppUrl(url: string): string | null {
  // Bare protocol check first (no URL parse needed).
  if (/^reddit:\/\//i.test(url.trim())) {
    return "app_scheme";
  }
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();

    // reddit.app.link — branch.io mobile universal link
    if (host === "reddit.app.link" || host.endsWith(".reddit.app.link")) {
      return "app_link";
    }

    // New-style share short-links: reddit.com/r/sub/s/XXXXXX
    // These redirect to the real post URL in a browser but we can't resolve them here.
    if (host.endsWith("reddit.com")) {
      const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
      // New-style share links: /r/sub/s/XXXX — server-side resolvable via HEAD redirect
      if (parts[0] === "r" && parts[2] === "s") return "share_link_resolvable";
      // Also catch /r/sub/comments/id (no slug) on redd.it style
    }

    // redd.it short links: redirect to a browser URL — safe to convert
    // by appending .json, but we need the full URL. Flag as needing browser open.
    if (host === "redd.it") {
      return "short_link";
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Returns a user-facing instruction message explaining how to get the correct
 * browser URL for the given detected app-link type.
 */
export function appUrlHelpMessage(kind: string, platform: "ios" | "android" | "unknown" = "unknown"): string {
  const base =
    "❌ **App links cannot be verified automatically** — Reddit's API only works with regular browser URLs.\n\n";

  if (kind === "app_scheme") {
    return (
      base +
      "You submitted a **Reddit app deep link** (`reddit://...`). Here's how to get the right URL:\n\n" +
      "1. Open the post or comment **in the Reddit app**\n" +
      "2. Tap the **Share** button → choose **Copy Link**\n" +
      "3. Open that link in a browser (Safari / Chrome)\n" +
      "4. Copy the URL from the browser address bar — it should look like:\n" +
      "   `https://www.reddit.com/r/SubName/comments/XXXXXX/...`\n" +
      "5. Paste that URL here as your proof."
    );
  }

  if (kind === "app_link") {
    return (
      base +
      "You submitted a **Reddit universal link** (reddit.app.link/...). These only open in the app.\n\n" +
      "**How to get a browser URL:**\n" +
      "1. Open your Reddit post/comment\n" +
      "2. Tap **Share** → **Copy Link**\n" +
      "3. Paste the link in your browser (Safari/Chrome) and let it redirect\n" +
      "4. Copy the URL shown in the address bar (starts with `reddit.com/r/...`)\n" +
      "5. Submit that URL here."
    );
  }

  if (kind === "share_link") {
    return (
      base +
      "You submitted a **Reddit share short-link** (`reddit.com/r/.../s/...`). These only work in the app.\n\n" +
      "**How to get the full URL:**\n" +
      "1. Open the link in a browser (Safari / Chrome) — it will redirect\n" +
      "2. Copy the full URL from the address bar — it should look like:\n" +
      "   `https://www.reddit.com/r/SubName/comments/XXXXXX/post_title/`\n" +
      "3. Paste that URL here as your proof."
    );
  }

  if (kind === "short_link") {
    return (
      base +
      "You submitted a **redd.it short link**. Open it in a browser first:\n\n" +
      "1. Open the link in Safari / Chrome — it will redirect to the full Reddit URL\n" +
      "2. Copy the full URL from the address bar\n" +
      "3. Paste that URL here as your proof.\n\n" +
      "The URL you need looks like: `https://www.reddit.com/r/SubName/comments/XXXXXX/...`"
    );
  }

  return (
    base +
    "Please open the post or comment **in a browser** (Safari or Chrome), then copy the URL from the address bar.\n\n" +
    "It should look like: `https://www.reddit.com/r/SubName/comments/XXXXXX/...`"
  );
}

export function parseRedditProofUrl(url: string): {
  subreddit: string;
  postId: string;
  commentId: string | null;
  isUserPost?: boolean;
} | null {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("reddit.com")) return null;
    const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
    
    let subreddit = "";
    let postId = "";
    let commentId: string | null = null;
    let isUserPost = false;

    if (parts[0] === "r" && parts[1]) {
      subreddit = parts[1].toLowerCase();
      if (parts[2] !== "comments" || !parts[3]) return null;
      postId = parts[3];
      commentId = parts[5] ?? null;
    } else if ((parts[0] === "user" || parts[0] === "u") && parts[1]) {
      subreddit = `u_${parts[1].toLowerCase()}`;
      isUserPost = true;
      if (parts[2] !== "comments" || !parts[3]) return null;
      postId = parts[3];
      commentId = parts[5] ?? null;
    } else {
      return null;
    }

    return { subreddit, postId, commentId, isUserPost };
  } catch {
    return null;
  }
}

/**
 * Extract subreddit name from a task's reddit link, which may be either:
 *   - A specific post URL (reddit.com/r/sub/comments/abc/...)
 *   - A subreddit-only URL (reddit.com/r/sub or reddit.com/r/sub/)
 *   - The "r/sub" shorthand
 * Returns the lowercased subreddit name, or null if it can't be parsed.
 */
export function extractTaskSubreddit(taskRedditLink: string): string | null {
  const trimmed = taskRedditLink.trim();
  // r/somesub shorthand
  const shortMatch = /^\/?r\/([A-Za-z0-9_]+)\/?$/i.exec(trimmed);
  if (shortMatch && shortMatch[1]) return shortMatch[1].toLowerCase();
  try {
    const u = new URL(trimmed);
    if (!u.hostname.endsWith("reddit.com")) return null;
    const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
    if (parts[0] !== "r" || !parts[1]) return null;
    return parts[1].toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Extract the specific post ID from a task's Reddit link when the task
 * requires engagement on ONE particular post (not just any post in a sub).
 *
 * Returns the postId string (e.g. "1tmpysc") if the link is a full post URL,
 * or null if the link is a subreddit-only URL / r/name shorthand.
 *
 * Examples:
 *   https://reddit.com/r/jawsurgery/comments/1tmpysc/recessed/ → "1tmpysc"
 *   https://reddit.com/r/jawsurgery/                           → null
 *   r/jawsurgery                                               → null
 */
export function extractTaskPostId(taskRedditLink: string): string | null {
  const trimmed = taskRedditLink.trim();
  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("reddit.com")) return null;
    const parts = u.pathname.replace(/^\//, "").split("/").filter(Boolean);
    // /r/sub/comments/POSTID/...
    if ((parts[0] === "r" || parts[0] === "user" || parts[0] === "u") &&
        parts[2] === "comments" && parts[3]) {
      return parts[3].toLowerCase();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strip HTML tags and decode common HTML entities from an RSS <content> value.
 * Returns the plain text, collapsed whitespace, trimmed.
 */
function decodeRssContent(raw: string): string {
  return raw
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ")   // strip all HTML tags
    .replace(/\s+/g, " ").trim();
}

/**
 * Classify a Reddit post's removal/visibility state from the JSON `data` blob.
 * Reddit signals:
 *   - removed_by_category: "deleted" | "moderator" | "anti_evil_ops" | "automod_filtered" | "reddit" | "author"
 *   - selftext === "[removed]" or "[deleted]"
 *   - author === "[deleted]" → user nuked the account or post
 *   - locked === true
 */
function classifyPost(data: any): SubmissionStatus | null {
  const cat = (data.removed_by_category ?? "") as string;
  const selftextDeleted = data.selftext === "[deleted]";
  const selftextRemoved = data.selftext === "[removed]";
  const authorDeleted = data.author === "[deleted]";

  if (cat === "deleted" || cat === "author" || selftextDeleted || authorDeleted) {
    return "deleted_by_author";
  }
  if (cat === "moderator") return "removed_by_mod";
  if (cat === "anti_evil_ops" || cat === "reddit" || cat === "copyright_takedown") {
    return "removed_by_reddit";
  }
  if (cat === "automod_filtered") return "removed_by_automod";
  if (selftextRemoved) return "removed_by_mod"; // most common cause when category isn't set

  return null;
}

function classifyComment(c: any): SubmissionStatus | null {
  const body = c.body ?? "";
  const author = c.author ?? "";
  const cat = c.removed_by_category as string | undefined;

  if (author === "[deleted]" || body === "[deleted]" || cat === "deleted" || cat === "author") {
    return "deleted_by_author";
  }
  if (cat === "moderator" || body === "[removed]") return "removed_by_mod";
  if (cat === "anti_evil_ops" || cat === "reddit") return "removed_by_reddit";
  if (cat === "automod_filtered") return "removed_by_automod";
  return null;
}

export interface ValidateOptions {
  /** Task creation date — comments posted before this (minus TASK_GRACE_MS) are rejected. */
  taskCreatedAt?: Date;
  /** Minimum comment body length in characters after stripping HTML. 0 = disabled. */
  minCommentChars?: number;
  /**
   * Task type (e.g. "comment", "post", "upvote"). When set to "comment", the
   * proof URL MUST contain a comment ID or the submission is rejected immediately.
   * This prevents post-only URLs from slipping through the RSS post-check path.
   */
  taskType?: string;
}

export async function validateRedditProof(
  proofUrl: string,
  // Backwards compatible: accept a single username (legacy single-account
  // path) OR an array (multi-account: any of the user's verified Reddit
  // accounts is acceptable as the proof author).
  expectedAuthor: string | string[],
  taskRedditLink: string,
  options?: ValidateOptions
): Promise<ValidationResult> {
  const failures: string[] = [];

  const expectedLowerList = (Array.isArray(expectedAuthor) ? expectedAuthor : [expectedAuthor])
    .map((u) => {
      let name = (u ?? "").toLowerCase().trim();
      name = name.replace(/^\/?u\//, ""); // Strip leading u/ or /u/
      return name;
    })
    .filter((u) => u.length > 0);

  // ── Share-link resolution ──────────────────────────────────────────────────
  // Reddit's /r/sub/s/XXXX share links are 301-redirected to the real URL.
  // We can resolve them server-side by following the HEAD redirect.
  let resolvedProofUrl = proofUrl;
  const appKind = detectAppUrl(proofUrl);
  if (appKind === "share_link_resolvable") {
    logger.info({ proofUrl }, "Resolving share link via HEAD redirect");
    const resolved = await resolveShareLink(proofUrl);
    if (resolved) {
      resolvedProofUrl = resolved;
      logger.info({ proofUrl, resolved }, "Share link resolved to canonical URL");
    } else {
      // Could not resolve — tell the user to get the full URL from a browser.
      return {
        passed: false, autoApproved: false, status: "url_invalid",
        failures: [
          "Your proof link is a Reddit share short-link that could not be resolved automatically. " +
          "Please open it in a browser, copy the full URL from the address bar (it should look like " +
          "`https://www.reddit.com/r/SubName/comments/XXXXXX/...`), and resubmit."
        ],
        ...meta("url_invalid"),
      };
    }
  }

  const parsed = parseRedditProofUrl(resolvedProofUrl);
  if (!parsed) {
    return {
      passed: false, autoApproved: false, status: "url_invalid",
      failures: ["Proof URL is not a valid reddit.com post or comment URL."],
      ...meta("url_invalid"),
    };
  }

  // ── Comment-task guard ─────────────────────────────────────────────────────
  // A comment task requires a proof URL that contains a specific comment ID
  // (i.e. the URL must look like /r/sub/comments/POST_ID/title/COMMENT_ID/).
  // Without this check, a post-only URL slips through to the RSS post-check
  // path below, which validates the post author — not the comment author —
  // and auto-approves even when the worker never actually commented.
  if (options?.taskType === "comment" && !parsed.commentId) {
    return {
      passed: false, autoApproved: false, status: "url_invalid",
      failures: [
        "Your proof link points to a Reddit post, not to a specific comment. " +
        "For comment tasks you must link directly to **your comment**. " +
        "Open your comment on Reddit, tap the three-dot menu → **Share** → **Copy link**, " +
        "then paste that URL here. It should look like: " +
        "`https://www.reddit.com/r/SubName/comments/POSTID/posttitle/COMMENTID/`."
      ],
      ...meta("url_invalid"),
    };
  }

  if (parsed.commentId) {
    const { deepCheckComment } = await import("./deepRedditCommentChecker.js");
    return deepCheckComment(resolvedProofUrl, expectedAuthor, taskRedditLink, {
      minCommentChars: options?.minCommentChars,
      taskCreatedAt: options?.taskCreatedAt,
    });
  }

  // Task link may be a full post URL (for comment/upvote/share/join tasks)
  // OR a subreddit URL / r/name shorthand (for post tasks). Extract both
  // the subreddit AND the specific postId (if the task targets a single post).
  const taskSubreddit = extractTaskSubreddit(taskRedditLink);
  const taskPostId    = extractTaskPostId(taskRedditLink);

  // ── Post ID check (pure URL — no network needed) ───────────────────────────
  // If the task specifies a SPECIFIC post, the proof comment MUST be on that
  // exact post. Without this, users can comment on ANY post in the subreddit.
  // This is the most impactful anti-fraud check: prevents submitting a comment
  // on r/jawsurgery/comments/OTHER_POST as proof for a task targeting
  // r/jawsurgery/comments/1tmpysc.
  if (taskPostId && parsed.commentId) {
    // parsed.postId is the postId embedded in the proof URL itself — no API needed.
    if (parsed.postId.toLowerCase() !== taskPostId.toLowerCase()) {
      failures.push(
        `Your comment is on the wrong post. This task requires a comment specifically on post \`${taskPostId}\`, ` +
        `but your proof link points to post \`${parsed.postId}\`.`
      );
      return {
        passed: false, autoApproved: false, status: "wrong_post",
        failures,
        ...meta("wrong_post"),
      };
    }
  }

  // ── Fetch strategy ────────────────────────────────────────────────────────
  // Unauthenticated JSON is deprecated. RSS is the primary source.
  const rssUrl = parsed.isUserPost
    ? `https://www.reddit.com/user/${parsed.subreddit.slice(2)}/comments/${parsed.postId}/.rss`
    : `https://www.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}/.rss`;

  const rssBody = await fetchDirectText(rssUrl, 8_000);

  let data: any = null;
  let isRss = false;

  if (rssBody && rssBody.includes("<feed")) {
    isRss = true;
    data = rssBody;
    logger.info({ proofUrl }, "RSS fetch succeeded");
  } else {
    logger.warn({ proofUrl }, "RSS fetch failed — manual review");
    return {
      passed: false, autoApproved: false, status: "api_unreachable",
      failures: ["Reddit API unreachable — queued for manual review."],
      ...meta("api_unreachable"),
    };
  }

  if (isRss) {
    // 1. Check Subreddit
    const catMatch = /<category\s+[^>]*term="([^"]+)"/i.exec(data);
    const subredditFound = catMatch ? catMatch[1].toLowerCase() : parsed.subreddit;
    if (taskSubreddit && subredditFound !== taskSubreddit) {
      failures.push(`Post is in r/${subredditFound} but task requires r/${taskSubreddit}.`);
      return {
        passed: false, autoApproved: false, status: "wrong_subreddit",
        failures, subredditFound, postLive: false,
        ...meta("wrong_subreddit"),
      };
    }

    // 2. Post author check (comment submissions are handled by deepCheckComment
    //    before this point and never reach the RSS fallback path).
    let authorFound = "";
    let targetPostEntryContent = "";

    // Try the post's own RSS feed first.
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    while ((match = entryRegex.exec(data)) !== null) {
      const entryContent = match[1];
      if (entryContent.includes(`<id>t3_${parsed.postId}</id>`) || entryContent.includes(`<id>t3_${parsed.postId.toLowerCase()}</id>`)) {
        const authMatch = /<author>\s*<name>\/u\/([A-Za-z0-9_-]+)<\/name>/i.exec(entryContent);
        if (authMatch) {
          authorFound = authMatch[1].toLowerCase();
          targetPostEntryContent = entryContent;
          break;
        }
      }
    }

    // Fallback: check the user's own RSS feed.
    if (!authorFound) {
      for (const user of expectedLowerList) {
        try {
          const userRssUrl = `https://www.reddit.com/user/${user}/.rss`;
          const userRssBody = await fetchDirectText(userRssUrl, 6000);
          if (userRssBody && userRssBody.includes("<feed")) {
            const uEntries = userRssBody.split("<entry>");
            for (const uEntry of uEntries) {
              if (uEntry.includes(`<id>t3_${parsed.postId}</id>`) || uEntry.includes(`<id>t3_${parsed.postId.toLowerCase()}</id>`)) {
                authorFound = user;
                targetPostEntryContent = uEntry;
                logger.info({ user, proofUrl }, "Post found in User RSS feed!");
                break;
              }
            }
          }
        } catch (err) {
          logger.warn({ err, user }, "User RSS check failed");
        }
        if (authorFound) break;
      }
    }

    if (!authorFound) {
      failures.push("Could not determine the author of the post (post not found in post or user feed).");
      return {
        passed: false, autoApproved: false, status: "author_mismatch",
        failures, subredditFound, postLive: true,
        ...meta("author_mismatch"),
      };
    }

    // ── RSS Post Removal Guard ──────────────────────────────────────────────────
    // Reddit's RSS feeds continue to serve removed/deleted posts for some time
    // after removal. Check the <content> of the matched entry for the standard
    // "[removed]" / "[deleted]" selftext markers that Reddit injects on removal.
    // This mirrors the classifyPost() check applied on the JSON path (line ~865).
    if (targetPostEntryContent) {
      const rssContentMatch = /<content[^>]*>([\s\S]*?)<\/content>/i.exec(targetPostEntryContent);
      if (rssContentMatch) {
        const plain = decodeRssContent(rssContentMatch[1]).trim();
        if (/^\[removed\]$/i.test(plain)) {
          failures.push("Reddit post has been **removed by moderators** (detected via RSS feed).");
          return {
            passed: false, autoApproved: false, status: "removed_by_mod",
            failures, subredditFound, postLive: false,
            ...meta("removed_by_mod"),
          };
        }
        if (/^\[deleted\]$/i.test(plain)) {
          failures.push("Reddit post has been **deleted** (detected via RSS feed).");
          return {
            passed: false, autoApproved: false, status: "deleted_by_author",
            failures, subredditFound, postLive: false,
            ...meta("deleted_by_author"),
          };
        }
      }
    }

    if (authorFound && expectedLowerList.length > 0 && !expectedLowerList.includes(authorFound)) {
      const expectedDisplay = expectedLowerList.length === 1
        ? `u/${expectedLowerList[0]}`
        : expectedLowerList.map((u) => `u/${u}`).join(" or ");
      failures.push(`Author mismatch: found u/${authorFound} but expected ${expectedDisplay}.`);
      return {
        passed: false, autoApproved: false, status: "author_mismatch",
        failures, authorFound, subredditFound, postLive: true,
        ...meta("author_mismatch"),
      };
    }

    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(data);
    const title = titleMatch ? titleMatch[1] : undefined;
    const publishedMatch = /<published>([\s\S]*?)<\/published>/i.exec(data);
    const createdAt = publishedMatch ? publishedMatch[1] : undefined;

    return {
      passed: true,
      autoApproved: true,
      status: "live",
      failures: [],
      authorFound,
      subredditFound,
      postLive: true,
      title,
      createdAt,
      ...meta("live"),
    };
  }

  // Unreachable — the rssBody check above always returns early if RSS fails.
  return {
    passed: false, autoApproved: false, status: "api_unreachable",
    failures: ["Reddit API unreachable — queued for manual review."],
    ...meta("api_unreachable"),
  };
}


/**
 * Lightweight liveness re-check for an existing submission. Returns one of:
 *   - 'live'    : post/comment is still visible
 *   - 'removed' : removed by mods, automod, or Reddit itself
 *   - 'deleted' : the user deleted their own post/comment (or account)
 *   - 'unknown' : couldn't determine (network failure, transient API error)
 *
 * Used by the periodic re-checker — does NOT validate author/subreddit since
 * those were already validated at submission time. Pure liveness only.
 */
export type LiveStatus = "live" | "removed" | "deleted" | "unknown";

export interface LivenessResult {
  liveStatus: LiveStatus;
  detailedStatus: SubmissionStatus | null;
  statusLabel: string;
  reason?: string;
}

export async function recheckRedditLiveness(proofUrl: string): Promise<LivenessResult> {
  // ── Resolve share links before parsing ────────────────────────────────────
  // reddit.com/r/sub/s/XXXX share links must be resolved to a full /comments/
  // URL first. Without this step parseRedditProofUrl returns null and the
  // bulk checker marks every share link as "Invalid URL".
  let resolvedUrl = proofUrl;
  const appKind = detectAppUrl(proofUrl);
  if (appKind === "share_link_resolvable") {
    const resolved = await resolveShareLink(proofUrl);
    if (!resolved) {
      logger.warn({ proofUrl }, "recheckRedditLiveness: share link could not be resolved");
      return { liveStatus: "unknown", detailedStatus: null, statusLabel: "Share link unresolvable" };
    }
    resolvedUrl = resolved;
    logger.info({ proofUrl, resolvedUrl }, "recheckRedditLiveness: share link resolved");
  }

  const parsed = parseRedditProofUrl(resolvedUrl);
  if (!parsed) {
    return { liveStatus: "unknown", detailedStatus: null, statusLabel: "Invalid URL" };
  }

  if (parsed.commentId) {
    const { deepCheckComment } = await import("./deepRedditCommentChecker.js");
    const validation = await deepCheckComment(resolvedUrl, [], "");
    let liveStatus: LiveStatus = "unknown";
    if (validation.passed) {
      liveStatus = "live";
    } else if (validation.status === "api_unreachable") {
      liveStatus = "unknown";
    } else if (
      validation.status === "deleted_by_author" ||
      validation.status === "comment_deleted"
    ) {
      liveStatus = "deleted";
    } else if (
      validation.status === "removed_by_mod" ||
      validation.status === "removed_by_reddit" ||
      validation.status === "removed_by_automod"
    ) {
      liveStatus = "removed";
    } else if (validation.status === "comment_missing") {
      // comment_missing means ALL sources (JSON + HTML + RSS) were unreachable/blocked
      // by Reddit's IP ban — it does NOT mean the comment is actually deleted.
      // Treat as unknown so the liveness checker retries on the next tick instead of
      // falsely reversing a payout for a comment that is still live.
      liveStatus = "unknown";
    }
    return {
      liveStatus,
      detailedStatus: validation.status,
      statusLabel: validation.statusLabel,
      reason: validation.failures.join("; ") || undefined,
    };
  }

  // ── Post-only liveness via RSS + old.reddit HTML ─────────────────────────
  // Comment URLs are handled above by deepCheckComment.
  // Unauthenticated JSON is deprecated and OAuth is not yet configured, so
  // RSS and old.reddit HTML are the sources for post liveness checks.

  const subPrefix = parsed.isUserPost
    ? `user/${parsed.subreddit.slice(2)}`
    : `r/${parsed.subreddit}`;
  const postRssUrl = `https://www.reddit.com/${subPrefix}/comments/${parsed.postId}/.rss`;

  // Fetch RSS and old.reddit HTML in parallel for speed.
  logger.info({ postId: parsed.postId }, "recheckRedditLiveness: fetching post RSS + old.reddit HTML in parallel");
  const [postRssText, oldRedditHtml] = await Promise.all([
    fetchDirectText(postRssUrl, 8_000),
    proxyFetchText(
      [
        `https://old.reddit.com/${subPrefix}/comments/${parsed.postId}/`,
        `https://www.reddit.com/${subPrefix}/comments/${parsed.postId}/`,
      ],
      { timeoutMs: 8_000, acceptHeader: "text/html, */*" }
    ).catch(() => null),
  ]);

  // ── 1. Parse old.reddit HTML ──────────────────────────────────────────────
  // old.reddit is fully server-rendered: a removed post still loads but
  // the thing div carries removal markers we can read without JS or OAuth.
  type HtmlPostResult = "live" | "removed" | "deleted" | "inconclusive";
  let htmlPostResult: HtmlPostResult = "inconclusive";

  if (oldRedditHtml) {
    const isOldRedditPage =
      oldRedditHtml.includes('class="commentarea"') ||
      oldRedditHtml.includes('id="siteTable"') ||
      oldRedditHtml.includes('data-subreddit=') ||
      oldRedditHtml.includes('class="thing"');

    if (isOldRedditPage) {
      const thingId = `id="thing_t3_${parsed.postId}"`;
      const thingIdLower = `id="thing_t3_${parsed.postId.toLowerCase()}"`;
      const thingIdx = oldRedditHtml.indexOf(thingId) !== -1
        ? oldRedditHtml.indexOf(thingId)
        : oldRedditHtml.indexOf(thingIdLower);

      if (thingIdx !== -1) {
        // Post container found — extract class attrs and selftext to detect removal.
        const fragmentStart = Math.max(0, thingIdx - 100);
        const fragment = oldRedditHtml.substring(fragmentStart, thingIdx + 800);

        // Detect removal via CSS class on the thing div.
        // old.reddit adds:
        //   "deleted" / "spam"     → author-deleted or spam-removed
        //   "removed"              → moderator-removed (link posts + text posts)
        const thingClassMatch = fragment.match(/class="([^"]+)"\s[^>]*id="thing_t3_/i) ||
          fragment.match(/class="([^"]+)"/);
        const thingClass = thingClassMatch ? thingClassMatch[1] : "";
        const isDeletedByClass = /\bdeleted\b/.test(thingClass) || /\bspam\b/.test(thingClass);
        const isRemovedByClass = /\bremoved\b/.test(thingClass);
        const hasDataDeleted = /\bdata-deleted="true"/i.test(fragment);

        // Detect removal via selftext body content.
        let selftextRemoved = false;
        const selftextIdx = oldRedditHtml.indexOf('class="usertext-body', thingIdx);
        if (selftextIdx !== -1 && selftextIdx - thingIdx < 4000) {
          const mdIdx = oldRedditHtml.indexOf('class="md"', selftextIdx);
          if (mdIdx !== -1) {
            const pStart = oldRedditHtml.indexOf("<p>", mdIdx);
            const pEnd = oldRedditHtml.indexOf("</p>", pStart);
            if (pStart !== -1 && pEnd !== -1 && pEnd - pStart < 500) {
              const bodyText = oldRedditHtml.substring(pStart + 3, pEnd).replace(/<[^>]*>/g, "").trim();
              const bodyNorm = bodyText.toLowerCase().replace(/\s+/g, "");
              selftextRemoved =
                bodyText === "[removed]" ||
                bodyText === "[deleted]" ||
                bodyNorm === "[removedbyreddit]" ||
                bodyNorm === "[deletedbyuser]" ||
                /^\[[\s\w]*(?:removed|deleted)[\s\w]*\]$/i.test(bodyText);
            }
          }
        }

        if (isDeletedByClass || hasDataDeleted) {
          htmlPostResult = "deleted";
          logger.info({ postId: parsed.postId }, "recheckRedditLiveness: old.reddit HTML shows post deleted (class/data-deleted)");
        } else if (isRemovedByClass || selftextRemoved) {
          // isRemovedByClass catches link posts removed by a moderator — they
          // have no selftext to check, but old.reddit adds class="removed" to
          // the thing div. selftextRemoved catches text posts whose body
          // content was replaced with "[removed]" by moderators.
          htmlPostResult = "removed";
          logger.info({ postId: parsed.postId, via: isRemovedByClass ? "class" : "selftext" }, "recheckRedditLiveness: old.reddit HTML shows post removed by mod");
        } else {
          htmlPostResult = "live";
          logger.info({ postId: parsed.postId }, "recheckRedditLiveness: old.reddit HTML confirms post live");
        }
      } else {
        // Post container absent from a valid old.reddit page → not found.
        htmlPostResult = "deleted";
        logger.info({ postId: parsed.postId }, "recheckRedditLiveness: post container absent from old.reddit HTML — treating as removed/deleted");
      }
    } else {
      // Page doesn't look like old.reddit (CAPTCHA, Cloudflare, shreddit).
      // Check shreddit for removal signals in the initial HTML.
      const isShredditPage =
        oldRedditHtml.includes("<shreddit-post") ||
        oldRedditHtml.includes("<shreddit-app") ||
        oldRedditHtml.includes("shreddit-");

      if (isShredditPage) {
        // Shreddit lazy-loads content — absence is inconclusive. But if the
        // post tag is present with a removed attribute, trust it.
        const postTagMatch = oldRedditHtml.match(new RegExp(`<shreddit-post[^>]+postid="${parsed.postId}"[^>]*>`, "i"));
        if (postTagMatch) {
          const tag = postTagMatch[0];
          if (tag.includes('removed="true"') || tag.includes('deleted="true"')) {
            htmlPostResult = "removed";
            logger.info({ postId: parsed.postId }, "recheckRedditLiveness: shreddit-post tag shows removed");
          } else {
            htmlPostResult = "live";
            logger.info({ postId: parsed.postId }, "recheckRedditLiveness: shreddit-post tag found, not removed");
          }
        }
        // else: shreddit page loaded but postId not in initial HTML — inconclusive
      }
      // else: unrecognised page — leave as inconclusive
    }
  }

  // If HTML gave us a clear answer, return it now without touching RSS.
  if (htmlPostResult === "live") {
    return { liveStatus: "live", detailedStatus: "live", statusLabel: "Live" };
  }
  if (htmlPostResult === "removed") {
    return {
      liveStatus: "removed",
      detailedStatus: "removed_by_mod",
      statusLabel: "Post removed",
      reason: "Post content is [removed] in old.reddit HTML.",
    };
  }
  if (htmlPostResult === "deleted") {
    return {
      liveStatus: "deleted",
      detailedStatus: "deleted_by_author",
      statusLabel: "Post deleted",
      reason: "Post not found or deleted in old.reddit HTML.",
    };
  }

  // ── 2. RSS fallback (HTML was inconclusive) ───────────────────────────────
  if (!postRssText || !postRssText.includes("<feed")) {
    logger.warn({ postId: parsed.postId }, "recheckRedditLiveness: post RSS unavailable and HTML inconclusive — unknown");
    return { liveStatus: "unknown", detailedStatus: "api_unreachable", statusLabel: "Reddit API unreachable" };
  }

  // Search for the post entry (kind t3) in the RSS feed.
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let entryMatch: RegExpExecArray | null;
  let postFound = false;
  let postRemoved = false;

  while ((entryMatch = entryRegex.exec(postRssText)) !== null) {
    const entry = entryMatch[1];
    if (
      entry.includes(`<id>t3_${parsed.postId}</id>`) ||
      entry.includes(`<id>t3_${parsed.postId.toLowerCase()}</id>`)
    ) {
      postFound = true;
      // Check the entry title for removal signals first.
      // Reddit sets the title to "[deleted]" when a post is deleted by its author.
      const entryTitleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(entry);
      const entryTitle = decodeRssContent(entryTitleMatch?.[1] ?? "").trim();
      if (/^\[(?:removed|deleted)\]$/i.test(entryTitle)) {
        postRemoved = true;
      }

      // Check the entry content body.
      // Reddit appends boilerplate after the sentinel, e.g.:
      //   "[removed]  submitted by  /u/Username [link]  [comments]"
      // So we cannot use a strict exact-match — check that the content
      // STARTS WITH the removal sentinel (after stripping HTML/entities).
      const contentMatch = /<content[^>]*>([\s\S]*?)<\/content>/i.exec(entry);
      if (contentMatch) {
        const plain = decodeRssContent(contentMatch[1]).trim();
        if (/^\[removed\]/i.test(plain) || /^\[deleted\]/i.test(plain)) {
          postRemoved = true;
        }
      }
      break;
    }
  }

  if (!postFound) {
    // No t3_ entry in the RSS. This is ambiguous: link-posts and posts
    // with 0 comments sometimes omit the t3_ entry from the feed.
    // Removed posts also omit the t3_ entry.
    //
    // We cannot rely on the feed <link> to prove existence because we always
    // request that specific thread's RSS URL — the feed link will always
    // contain the postId regardless of whether the post is live or removed.
    //
    // Check the feed title for a [removed] signal as a last resort.
    const feedTitleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(postRssText);
    const feedTitle = decodeRssContent(feedTitleMatch?.[1] ?? "").trim();
    if (/\[removed\]|\[deleted\]/i.test(feedTitle)) {
      logger.info({ postId: parsed.postId }, "recheckRedditLiveness: RSS feed title shows [removed] — post removed");
      return {
        liveStatus: "removed",
        detailedStatus: "removed_by_mod",
        statusLabel: "Post removed",
        reason: "Post is marked [removed] in the RSS feed title.",
      };
    }

    // Has t1_ comment entries? If so the post must exist (comments imply a post).
    const hasComments = postRssText.includes("<id>t1_");
    if (hasComments) {
      logger.info({ postId: parsed.postId }, "recheckRedditLiveness: no t3_ entry but t1_ comments present — post exists");
      return { liveStatus: "live", detailedStatus: "live", statusLabel: "Live" };
    }

    // No t3_, no comments, no [removed] in title — truly inconclusive.
    // Return unknown rather than guessing live/deleted.
    logger.warn({ postId: parsed.postId }, "recheckRedditLiveness: no t3_ entry and no comments in RSS, HTML inconclusive — unknown");
    return {
      liveStatus: "unknown",
      detailedStatus: "api_unreachable",
      statusLabel: "Reddit API unreachable",
      reason: "Could not determine post status from RSS or HTML.",
    };
  }

  if (postRemoved) {
    logger.info({ postId: parsed.postId }, "recheckRedditLiveness: post marked [removed] in RSS");
    return {
      liveStatus: "removed",
      detailedStatus: "removed_by_mod",
      statusLabel: "Post removed",
      reason: "Post content is [removed] in the RSS feed.",
    };
  }

  logger.info({ postId: parsed.postId }, "recheckRedditLiveness: post confirmed live via RSS");
  return { liveStatus: "live", detailedStatus: "live", statusLabel: "Live" };
}
