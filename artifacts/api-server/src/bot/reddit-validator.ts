import { logger } from "../lib/logger.js";
import { proxyFetchText } from "./proxy.js";
import { fetchRedditApiUrl } from "./reddit.js";
import { fetch as undiciFetch } from "undici";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Fetch text content (RSS/XML/HTML) via proxy rotation.
 * Tries the proxy pool first; falls back to direct if no proxies are loaded.
 * This replaces the original direct-only fetchDirectText so the sweeper can
 * reach Reddit even when the server's IP is rate-limited or blocked.
 */
async function fetchDirectText(url: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const text = await proxyFetchText([url], { timeoutMs, acceptHeader: "application/xml, text/xml, text/html, */*" });
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
async function resolveShareLink(shareUrl: string, timeoutMs = 5000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(shareUrl, {
      method: "HEAD",
      headers: { "User-Agent": DEFAULT_UA },
      signal: controller.signal,
      // Do NOT auto-follow — we want the Location header from the first redirect.
      redirect: "manual",
    });
    // 301/302/307/308 all carry a Location header with the real URL.
    const location = res.headers.get("location");
    if (location && location.includes("/comments/")) {
      // Normalise to https://www.reddit.com/...
      const resolved = location.startsWith("/")
        ? `https://www.reddit.com${location}`
        : location;
      logger.info({ shareUrl, resolved }, "Share link resolved");
      return resolved;
    }
    logger.warn({ shareUrl, status: res.status, location }, "Share link redirect did not contain /comments/ path");
    return null;
  } catch (err) {
    logger.warn({ shareUrl, err }, "Share link resolution failed");
    return null;
  } finally {
    clearTimeout(timer);
  }
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
  // Unauthenticated JSON access has been deprecated by Reddit. We now use the
  // authenticated OAuth API (oauth.reddit.com) as the primary source and fall
  // back to RSS when OAuth is not configured or returns an error.
  const rssUrl = parsed.isUserPost
    ? `https://www.reddit.com/user/${parsed.subreddit.slice(2)}/comments/${parsed.postId}/.rss`
    : `https://www.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}/.rss`;

  const oauthUrl = parsed.isUserPost
    ? `https://oauth.reddit.com/user/${parsed.subreddit.slice(2)}/comments/${parsed.postId}.json?limit=500&raw_json=1`
    : `https://oauth.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}.json?limit=500&raw_json=1`;

  const [result, rssBody] = await Promise.all([
    fetchRedditApiUrl(oauthUrl),
    fetchDirectText(rssUrl, 8_000),
  ]);

  let data = result.body;
  let isRss = false;

  if (!result.ok) {
    if (result.status === 404) {
      return {
        passed: false, autoApproved: false, status: "not_found",
        failures: ["Reddit post not found or has been deleted (404)."],
        postLive: false,
        ...meta("not_found"),
      };
    }
    // JSON failed (most likely 403). Fall back to RSS which we already fetched.
    if (rssBody && rssBody.includes("<feed")) {
      isRss = true;
      data = rssBody;
      logger.info({ proofUrl }, "JSON blocked — using RSS + old.reddit HTML path");
    } else {
      logger.warn({ status: result.status, proofUrl }, "Both JSON and RSS failed — manual review");
      return {
        passed: false, autoApproved: false, status: "api_unreachable",
        failures: ["Reddit API unreachable — queued for manual review."],
        ...meta("api_unreachable"),
      };
    }
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

  data = result.body;
  const postListing = Array.isArray(data) ? data[0] : null;
  const postData = postListing?.data?.children?.[0]?.data;

  if (!postData) {
    return {
      passed: false, autoApproved: false, status: "not_found",
      failures: ["Could not retrieve post data from Reddit."],
      ...meta("not_found"),
    };
  }

  const subredditFound = (postData.subreddit ?? "").toLowerCase();
  if (taskSubreddit && subredditFound !== taskSubreddit) {
    failures.push(`Post is in r/${subredditFound} but task requires r/${taskSubreddit}.`);
    return {
      passed: false, autoApproved: false, status: "wrong_subreddit",
      failures, subredditFound, postLive: false,
      ...meta("wrong_subreddit"),
    };
  }

  const upvotes: number = typeof postData.ups === "number" ? postData.ups : (postData.score ?? 0);
  const numComments: number = postData.num_comments ?? 0;
  const ageMinutes = postData.created_utc
    ? Math.floor((Date.now() / 1000 - postData.created_utc) / 60)
    : undefined;

  // Post-level removal/deletion check
  const postState = classifyPost(postData);
  if (postState) {
    const m = STATUS_META[postState];
    failures.push(`Reddit post is **${m.label.toLowerCase()}**.`);
    return {
      passed: false, autoApproved: false, status: postState,
      failures, subredditFound, postLive: false, upvotes, numComments, ageMinutes,
      ...meta(postState),
    };
  }

  if (postData.locked === true) {
    failures.push("Reddit post is locked — comments disabled.");
    return {
      passed: false, autoApproved: false, status: "locked",
      failures, subredditFound, postLive: true, upvotes, numComments, ageMinutes,
      ...meta("locked"),
    };
  }

  let authorFound = "";
  let commentUpvotes: number | undefined;
  let commentAgeMinutes: number | undefined;

  if (parsed.commentId) {
    const commentsListing = Array.isArray(data) ? data[1] : null;
    const allComments: any[] = [];

    function flattenComments(children: any[]) {
      for (const child of children ?? []) {
        if (child.kind === "t1") {
          allComments.push(child.data);
          if (child.data.replies?.data?.children) {
            flattenComments(child.data.replies.data.children);
          }
        }
      }
    }

    flattenComments(commentsListing?.data?.children ?? []);
    const targetComment = allComments.find((c) => c.id === parsed.commentId);

    if (!targetComment) {
      failures.push(`Comment ID "${parsed.commentId}" not found on the post — it was likely removed by Reddit/Automod.`);
      return {
        passed: false, autoApproved: false, status: "comment_missing",
        failures, subredditFound, postLive: true, upvotes, numComments, ageMinutes,
        ...meta("comment_missing"),
      };
    }

    const commentState = classifyComment(targetComment);
    if (commentState) {
      const m = STATUS_META[commentState];
      failures.push(`Your comment is **${m.label.toLowerCase()}**.`);
      const status: SubmissionStatus = commentState === "deleted_by_author" ? "comment_deleted" : commentState;
      return {
        passed: false, autoApproved: false, status,
        failures, subredditFound, postLive: true, upvotes, numComments, ageMinutes,
        ...meta(status),
      };
    }

    authorFound = (targetComment.author ?? "").toLowerCase();
    commentUpvotes = typeof targetComment.ups === "number" ? targetComment.ups : (targetComment.score ?? 0);
    if (targetComment.created_utc) {
      commentAgeMinutes = Math.floor((Date.now() / 1000 - targetComment.created_utc) / 60);
    }

    // ── JSON path: freshness check ────────────────────────────────────────────
    if (options?.taskCreatedAt && targetComment.created_utc) {
      const commentMs = targetComment.created_utc * 1000;
      const earliest = options.taskCreatedAt.getTime() - TASK_GRACE_MS;
      if (commentMs < earliest) {
        failures.push(
          `Your comment was posted before this task was created — recycled old comments are not accepted. ` +
          `Comment date: ${new Date(commentMs).toUTCString()}. Task created: ${options.taskCreatedAt.toUTCString()}.`
        );
        return {
          passed: false, autoApproved: false, status: "stale_proof",
          failures, authorFound, subredditFound, postLive: true, upvotes, numComments, ageMinutes,
          ...meta("stale_proof"),
        };
      }
    }

    // ── JSON path: minimum comment length ────────────────────────────────────
    const minCharsJson = options?.minCommentChars ?? MIN_COMMENT_CHARS;
    if (minCharsJson > 0) {
      const body = (targetComment.body ?? "").replace(/\s+/g, " ").trim();
      if (body.length < minCharsJson) {
        failures.push(
          `Comment is too short (${body.length} characters). ` +
          `This task requires a genuine comment of at least ${minCharsJson} characters.`
        );
        return {
          passed: false, autoApproved: false, status: "comment_too_short",
          failures, authorFound, subredditFound, postLive: true, upvotes, numComments, ageMinutes,
          ...meta("comment_too_short"),
        };
      }
    }
  } else {
    authorFound = (postData.author ?? "").toLowerCase();
  }

  if (authorFound && expectedLowerList.length > 0 && !expectedLowerList.includes(authorFound)) {
    const expectedDisplay = expectedLowerList.length === 1
      ? `u/${expectedLowerList[0]}`
      : expectedLowerList.map((u) => `u/${u}`).join(" or ");
    failures.push(`Author mismatch: found u/${authorFound} but expected ${expectedDisplay}.`);
    return {
      passed: false, autoApproved: false, status: "author_mismatch",
      failures, authorFound, subredditFound, postLive: true, upvotes, numComments, ageMinutes,
      ...meta("author_mismatch"),
    };
  }
  if (!authorFound) {
    failures.push("Could not determine the author of the post/comment.");
    return {
      passed: false, autoApproved: false, status: "author_mismatch",
      failures, subredditFound, postLive: true, upvotes, numComments, ageMinutes,
      ...meta("author_mismatch"),
    };
  }

  return {
    passed: true,
    autoApproved: true,
    status: "live",
    failures: [],
    authorFound,
    subredditFound,
    postLive: true,
    upvotes: parsed.commentId ? commentUpvotes : upvotes,
    numComments,
    ageMinutes: parsed.commentId ? commentAgeMinutes : ageMinutes,
    title: postData?.title ?? undefined,
    createdAt: postData?.created_utc ? new Date(postData.created_utc * 1000).toISOString() : undefined,
    ...meta("live"),
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
  const parsed = parseRedditProofUrl(proofUrl);
  if (!parsed) {
    return { liveStatus: "unknown", detailedStatus: null, statusLabel: "Invalid URL" };
  }

  if (parsed.commentId) {
    const { deepCheckComment } = await import("./deepRedditCommentChecker.js");
    const validation = await deepCheckComment(proofUrl, [], "");
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

  // Unauthenticated JSON access has been deprecated by Reddit. Use OAuth API
  // as the primary source. old.reddit HTML remains a secondary ground-truth
  // source for comment liveness checks.
  const oauthUrl = parsed.isUserPost
    ? `https://oauth.reddit.com/user/${parsed.subreddit.slice(2)}/comments/${parsed.postId}.json?limit=500&raw_json=1`
    : `https://oauth.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}.json?limit=500&raw_json=1`;

  const [result, htmlVisible] = await Promise.all([
    fetchRedditApiUrl(oauthUrl),
    parsed.commentId
      ? isCommentVisibleOnOldReddit(parsed.subreddit, parsed.postId, parsed.commentId, parsed.isUserPost)
      : Promise.resolve<boolean | null>(null),
  ]);

  // ── Comment liveness via old.reddit HTML (most reliable path) ─────────────
  if (parsed.commentId && htmlVisible !== null) {
    if (htmlVisible === false) {
      // HTML says the comment is gone. But before hard-marking as removed, try
      // to corroborate with the JSON response — a proxy returning garbage HTML
      // must not trigger a false positive on its own.
      if (result.ok) {
        // JSON fetched successfully — check if the comment body is present.
        const commentsListing = Array.isArray(result.body) ? result.body[1] : null;
        const allComments: any[] = [];
        function flattenForHtmlCheck(children: any[]) {
          for (const child of children ?? []) {
            if (child.kind === "t1") {
              allComments.push(child.data);
              if (child.data.replies?.data?.children) {
                flattenForHtmlCheck(child.data.replies.data.children);
              }
            }
          }
        }
        flattenForHtmlCheck(commentsListing?.data?.children ?? []);
        const target = allComments.find((c) => c.id === parsed.commentId);
        if (!target) {
          // JSON also can't find the comment — both sources agree it's gone.
          return {
            liveStatus: "removed",
            detailedStatus: "comment_missing",
            statusLabel: "Comment removed",
            reason: "Comment is no longer visible on Reddit (confirmed by both HTML and JSON).",
          };
        }
        // JSON found the comment — HTML was probably a bad proxy response.
        // Check JSON for removal markers instead.
        const cstate = classifyComment(target);
        if (cstate) {
          const m = STATUS_META[cstate];
          const live: LiveStatus = cstate === "deleted_by_author" ? "deleted" : "removed";
          return { liveStatus: live, detailedStatus: cstate, statusLabel: m.label, reason: m.label };
        }
        // JSON says comment is live — trust JSON over HTML proxy result.
        logger.info({ commentId: parsed.commentId }, "HTML said removed but JSON says live — treating as live (proxy false positive)");
        return { liveStatus: "live", detailedStatus: "live", statusLabel: "Live" };
      } else {
        // JSON also failed — can't confirm. Treat as unknown so we retry next tick.
        logger.warn(
          { commentId: parsed.commentId, jsonStatus: result.status },
          "HTML says removed but JSON fetch also failed — treating as unknown to avoid false positive"
        );
        return { liveStatus: "unknown", detailedStatus: "api_unreachable", statusLabel: "Reddit API unreachable" };
      }
    }
    // htmlVisible === true — comment is live. If JSON also succeeded, do a
    // deeper check for removal markers on the comment body.
    if (result.ok) {
      const data = result.body;
      const commentsListing = Array.isArray(data) ? data[1] : null;
      const allComments: any[] = [];
      function flattenComments(children: any[]) {
        for (const child of children ?? []) {
          if (child.kind === "t1") {
            allComments.push(child.data);
            if (child.data.replies?.data?.children) {
              flattenComments(child.data.replies.data.children);
            }
          }
        }
      }
      flattenComments(commentsListing?.data?.children ?? []);
      const target = allComments.find((c) => c.id === parsed.commentId);
      if (target) {
        const cstate = classifyComment(target);
        if (cstate) {
          const m = STATUS_META[cstate];
          const live: LiveStatus = cstate === "deleted_by_author" ? "deleted" : "removed";
          return { liveStatus: live, detailedStatus: cstate, statusLabel: m.label, reason: m.label };
        }
      }
    }
    return { liveStatus: "live", detailedStatus: "live", statusLabel: "Live" };
  }

  // ── Post-only or HTML check inconclusive: use JSON path ───────────────────
  if (!result.ok) {
    if (result.status === 404) {
      return {
        liveStatus: "deleted",
        detailedStatus: "not_found",
        statusLabel: "Post not found (404)",
        reason: "Reddit returned 404 — the post is gone.",
      };
    }
    // Transient — don't flip status, retry next tick.
    return {
      liveStatus: "unknown",
      detailedStatus: "api_unreachable",
      statusLabel: "Reddit API unreachable",
    };
  }

  const data = result.body;
  const postListing = Array.isArray(data) ? data[0] : null;
  const postData = postListing?.data?.children?.[0]?.data;

  if (!postData) {
    return {
      liveStatus: "unknown",
      detailedStatus: null,
      statusLabel: "Empty Reddit response",
    };
  }

  const postState = classifyPost(postData);
  if (postState) {
    const m = STATUS_META[postState];
    const live: LiveStatus = postState === "deleted_by_author" ? "deleted" : "removed";
    return { liveStatus: live, detailedStatus: postState, statusLabel: m.label, reason: m.label };
  }

  if (parsed.commentId) {
    const commentsListing = Array.isArray(data) ? data[1] : null;
    const allComments: any[] = [];
    function flattenComments2(children: any[]) {
      for (const child of children ?? []) {
        if (child.kind === "t1") {
          allComments.push(child.data);
          if (child.data.replies?.data?.children) {
            flattenComments2(child.data.replies.data.children);
          }
        }
      }
    }
    flattenComments2(commentsListing?.data?.children ?? []);
    const target = allComments.find((c) => c.id === parsed.commentId);
    if (!target) {
      return {
        liveStatus: "removed",
        detailedStatus: "comment_missing",
        statusLabel: "Comment missing",
        reason: "Comment was filtered or removed by Reddit/Automod.",
      };
    }
    const cstate = classifyComment(target);
    if (cstate) {
      const m = STATUS_META[cstate];
      const live: LiveStatus = cstate === "deleted_by_author" ? "deleted" : "removed";
      return { liveStatus: live, detailedStatus: cstate, statusLabel: m.label, reason: m.label };
    }
  }

  return { liveStatus: "live", detailedStatus: "live", statusLabel: "Live" };
}
