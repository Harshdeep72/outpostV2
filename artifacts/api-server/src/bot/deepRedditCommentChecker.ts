import { logger } from "../lib/logger.js";
import { proxyFetchText } from "./proxy.js";
import { parseRedditProofUrl, extractTaskSubreddit, extractTaskPostId, SubmissionStatus, ValidationResult } from "./reddit-validator.js";
import { getOAuthToken, invalidateOAuthToken } from "./reddit.js";
import { getRedditSessionCookie, forceRefreshCookie } from "./redditCookieManager.js";

const MIN_COMMENT_CHARS = Number(process.env.MIN_COMMENT_CHARS ?? 0);
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
  const m = STATUS_META[status] ?? { emoji: "❓", label: "Unknown" };
  return { statusEmoji: m.emoji, statusLabel: m.label };
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

// Decodes basic HTML entities commonly found in RSS content.
function decodeRssContent(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, "") // strip tags
    .trim();
}

/**
 * Fetch a comment thread via Reddit's authenticated OAuth API.
 *
 * Uses oauth.reddit.com which:
 *  - Requires REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET env vars (app-only grant).
 *  - Is not subject to datacenter IP blocks — no proxy needed.
 *  - Will continue working after Reddit deprecates unauthenticated JSON access.
 *
 * Returns the raw Reddit JSON body (same shape as .json endpoint) or null if
 * OAuth is not configured, the token cannot be obtained, or the fetch fails.
 */
async function fetchCommentThreadViaOAuth(
  sub: string,
  postId: string,
  commentId: string
): Promise<{ ok: boolean; body: any } | null> {
  const token = await getOAuthToken();
  if (!token) return null;

  try {
    const { fetch: undiciFetch, Agent } = await import("undici");
    const agent = new Agent({
      connect: { timeout: 5_000 },
      bodyTimeout: 10_000,
      headersTimeout: 10_000,
    });
    const url = `https://oauth.reddit.com/${sub}/comments/${postId}/_/${commentId}.json?context=3&raw_json=1`;
    const res = await undiciFetch(url, {
      dispatcher: agent,
      headers: {
        "User-Agent": "OutpostBot/1.0",
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    });

    if (res.status === 401) {
      // Token may have been revoked externally — drop it so next call re-fetches.
      invalidateOAuthToken();
      logger.warn({ status: res.status, sub, postId, commentId }, "Reddit OAuth token rejected (401) — invalidated");
      return null;
    }
    if (!res.ok) {
      logger.warn({ status: res.status, sub, postId, commentId }, "Reddit OAuth comment thread fetch failed");
      return null;
    }

    let body: any = null;
    try {
      const text = await res.text();
      body = JSON.parse(text);
    } catch {
      logger.warn({ sub, postId, commentId }, "Reddit OAuth response was not valid JSON");
      return null;
    }

    return { ok: true, body };
  } catch (err) {
    logger.warn({ err }, "Reddit OAuth comment thread fetch error");
    return null;
  }
}

/**
 * Primary method: fetch a comment thread directly via undici using the
 * in-memory Reddit session cookie. No subprocess spawn — fast, predictable,
 * and always uses the freshest cookie from getRedditSessionCookie().
 *
 * A clean authenticated GET to the .json permalink is the most faithful
 * representation of what a logged-in browser would see. Unlike the Python
 * curl_cffi path, there is no `visitFirst` HTML pre-fetch that could
 * accumulate conflicting cookies or trigger anti-bot challenges.
 *
 * Returns null if no session cookie is available or the fetch fails.
 */
async function fetchCommentThreadViaDirectJson(
  sub: string,
  postId: string,
  commentId: string
): Promise<{ ok: boolean; body: any } | null> {
  const sessionCookie = getRedditSessionCookie();
  if (!sessionCookie) {
    logger.info({ sub, postId, commentId }, "fetchCommentThreadViaDirectJson: no session cookie — skipping");
    return null;
  }

  try {
    const { fetch: undiciFetch, Agent } = await import("undici");
    const agent = new Agent({
      connect: { timeout: 8_000 },
      bodyTimeout: 15_000,
      headersTimeout: 10_000,
    });

    const url = `https://www.reddit.com/${sub}/comments/${postId}/_/${commentId}.json?context=3&raw_json=1`;

    const res = await undiciFetch(url, {
      dispatcher: agent,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cookie": sessionCookie,
        "Accept": "application/json",
        "Referer": `https://www.reddit.com/${sub}/comments/${postId}/`,
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    // 403 = cookie expired/invalid — trigger a background refresh for next call
    if (res.status === 403 || res.status === 401) {
      logger.warn({ status: res.status, sub, postId, commentId }, "fetchCommentThreadViaDirectJson: auth error — triggering cookie refresh");
      void forceRefreshCookie();
      return null;
    }

    if (!res.ok) {
      logger.warn({ status: res.status, sub, postId, commentId }, "fetchCommentThreadViaDirectJson: non-200 response");
      return null;
    }

    const text = await res.text();

    // Detect HTML/non-JSON responses (login walls, Cloudflare challenges)
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
      logger.warn({ sub, postId, commentId, preview: trimmed.slice(0, 80) }, "fetchCommentThreadViaDirectJson: response is not JSON (HTML/block page)");
      return null;
    }

    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      logger.warn({ sub, postId, commentId }, "fetchCommentThreadViaDirectJson: JSON parse failed");
      return null;
    }

    if (!Array.isArray(body)) {
      logger.warn({ sub, postId, commentId, bodyType: typeof body }, "fetchCommentThreadViaDirectJson: response is not an array — likely a Reddit error object");
      return null;
    }

    logger.info({ sub, postId, commentId }, "fetchCommentThreadViaDirectJson: success");
    return { ok: true, body };
  } catch (err) {
    logger.warn({ err, sub, postId, commentId }, "fetchCommentThreadViaDirectJson failed");
    return null;
  }
}

export interface ParsedHtmlComment {
  found: boolean;
  author: string | null;
  subreddit: string | null;
  createdAt: string | null;
  isRemoved: boolean;
  body: string | null;
  validPage: boolean;
}

export function parseHtmlComment(html: string, commentId: string): ParsedHtmlComment {
  // Check old.reddit
  const isOldReddit = html.includes('class="commentarea"') || html.includes('id="siteTable"') || html.includes('data-subreddit=');
  
  if (isOldReddit) {
    const idAttr = `id="thing_t1_${commentId}"`;
    if (!html.includes(idAttr)) {
      return { found: false, author: null, subreddit: null, createdAt: null, isRemoved: true, body: null, validPage: true };
    }
    
    const idx = html.indexOf(idAttr);
    const fragmentStart = Math.max(0, idx - 300);
    // Grab 1000 characters after idx to ensure we capture the whole opening tag
    const fragment = html.substring(fragmentStart, idx + 1000);

    // Extract author
    const authorMatch = fragment.match(/data-author="([^"]+)"/i);
    const author = authorMatch ? authorMatch[1].toLowerCase() : null;
    
    // Extract subreddit
    const subMatch = fragment.match(/data-subreddit="([^"]+)"/i) || html.match(/class="[^"]*r-([A-Za-z0-9_]+)[^"]*"/i);
    const subreddit = subMatch ? subMatch[1].toLowerCase() : null;

    // Extract creation timestamp — old.reddit puts data-timestamp (ms since epoch)
    // on the comment element. Without this, the stale-proof check silently skips
    // when JSON is unavailable (createdAt stays null → check is bypassed).
    const tsMatch = fragment.match(/data-timestamp="(\d+)"/i);
    const createdAt = tsMatch ? new Date(parseInt(tsMatch[1], 10)).toISOString() : null;

    // Extract body text.
    // Search range is 6000 chars (up from 3000) — context permalink pages can
    // include parent comments before the target, pushing usertext-body further.
    let body: string | null = null;
    const bodyIdx = html.indexOf('class="usertext-body', idx);
    if (bodyIdx !== -1 && bodyIdx - idx < 6000) {
      const mdIdx = html.indexOf('class="md"', bodyIdx);
      if (mdIdx !== -1) {
        const pStart = html.indexOf('<p>', mdIdx);
        const pEnd = html.indexOf('</p>', pStart);
        if (pStart !== -1 && pEnd !== -1 && pEnd - pStart < 2000) {
          body = html.substring(pStart + 3, pEnd).replace(/<[^>]*>/g, ""); // strip inner tags
        }
      }
    }

    // Check the thing div's own class attribute for removal markers.
    // Old.reddit adds 'deleted' to the class of the thing div for author-deleted
    // comments even when data-author fails to parse as "[deleted]". This catches
    // cases where body extraction fails AND the author attribute is absent/blank.
    //
    // Match the class that appears on the same div as our id attribute.
    // The fragment starts 300 chars before idx, so the opening tag is in range.
    const thingClassMatch =
      fragment.match(/class="([^"]*)"\s[^>]*id="thing_t1_/i) ||
      fragment.match(/class="([^"]*)"/);
    const thingClass = thingClassMatch ? thingClassMatch[1] : "";
    const isDeletedByClass = /\bdeleted\b/.test(thingClass) || /\bspam\b/.test(thingClass);

    // Check for data-deleted attribute (set by old.reddit for author-deleted).
    const hasDataDeleted = /\bdata-deleted="true"/i.test(fragment);

    // Note: we deliberately exclude `!author` here. A missing data-author
    // attribute means we couldn't parse the author — it does NOT mean the
    // comment was removed. Treating it as removed caused false positives where
    // live comments with un-parseable author attributes triggered payout reversals.
    //
    // We also deliberately exclude `isCollapsed`. Reddit auto-collapses low-karma
    // or controversial comments — a collapsed comment is still live. Using
    // isCollapsed as a removal signal caused false positives for valid low-karma
    // comments.
    //
    // Body checks use exact-match (trimmed) rather than substring/regex so a
    // user comment that happens to mention "[removed]" or "removed by" in its
    // text is not misidentified as removed. Reddit replaces the ENTIRE body
    // with "[removed]" or "[deleted]" — partial matches are not reliable.
    const bodyTrimmed = (body ?? "").trim();
    // Reddit uses several removal sentinels depending on who/what removed it:
    //   old.reddit / classic: "[removed]" / "[deleted]"
    //   modern Reddit UI:     "[ Removed by Reddit ]" / "[ Deleted by user ]"
    // We normalise to lowercase-no-spaces for comparison so all variants match.
    const bodyNorm = bodyTrimmed.toLowerCase().replace(/\s+/g, "");
    const isRemovedBody =
      bodyTrimmed === "[removed]" ||
      bodyTrimmed === "[deleted]" ||
      bodyNorm === "[removedbyreddit]" ||
      bodyNorm === "[deletedbyuser]" ||
      // Catch any bracket-enclosed removal notice: [ Removed by X ], [removed by mod], etc.
      /^\[[\s\w]*(?:removed|deleted)[\s\w]*\]$/i.test(bodyTrimmed);
    const isRemoved =
      author === "[deleted]" ||
      author === "[removed]" ||
      isRemovedBody ||
      isDeletedByClass ||
      hasDataDeleted;
    
    return {
      found: true,
      author,
      subreddit,
      createdAt,
      isRemoved,
      body,
      validPage: true
    };
  }
  
  // Check shreddit (modern Reddit)
  const shredditTagRegex = new RegExp(`<shreddit-comment[^>]+thingId="t1_${commentId}"[^>]*>`, "i");
  const shredditTagRegex2 = new RegExp(`<shreddit-comment[^>]+thingid="t1_${commentId}"[^>]*>`, "i");
  const tagMatch = html.match(shredditTagRegex) || html.match(shredditTagRegex2);
  
  if (tagMatch) {
    const tag = tagMatch[0];
    
    const authorMatch = tag.match(/author="([^"]+)"/i);
    const author = authorMatch ? authorMatch[1].toLowerCase() : null;
    
    const createdMatch = tag.match(/created="([^"]+)"/i);
    const createdAt = createdMatch ? createdMatch[1] : null;
    
    // Extract subreddit from reload-url or parent elements
    const reloadUrlMatch = tag.match(/reload-url="([^"]+)"/i);
    let subreddit: string | null = null;
    if (reloadUrlMatch) {
      const decoded = reloadUrlMatch[1].replace(/&amp;/g, "&");
      try {
        const urlParams = new URLSearchParams(decoded.split("?")[1]);
        subreddit = urlParams.get("subredditName")?.toLowerCase() ?? null;
      } catch {}
    }
    
    if (!subreddit) {
      const subMatch = html.match(/subreddit-prefixed-name="r\/([^"]+)"/i) || html.match(/&quot;subredditName&quot;:&quot;([^&]+)&quot;/i);
      subreddit = subMatch ? subMatch[1].toLowerCase() : null;
    }
    
    const isRemoved = author === "[deleted]" || author === "[removed]" || tag.includes('removed="true"') || tag.includes('deleted="true"');
    
    let body: string | null = null;
    const tagIdx = html.indexOf(tag);
    const bodyStartIdx = html.indexOf('<div slot="comment"', tagIdx);
    if (bodyStartIdx !== -1 && bodyStartIdx - tagIdx < 1000) {
      const bodyEndIdx = html.indexOf('</div>', bodyStartIdx);
      if (bodyEndIdx !== -1) {
        body = html.substring(bodyStartIdx, bodyEndIdx).replace(/<[^>]*>/g, "").trim();
      }
    }
    
    return {
      found: true,
      author,
      subreddit,
      createdAt,
      isRemoved,
      body,
      validPage: true
    };
  }

  // Check if it's a shreddit page but the comment is not found.
  // Shreddit (new Reddit) lazy-loads comments via JS — the specific comment
  // being absent from the initial HTML does NOT mean it was removed.
  // We return isRemoved: false here so callers know this result is inconclusive
  // and should defer to RSS rather than locking in a "deleted" verdict.
  const isShredditPage = html.includes("<shreddit-comment-tree") || html.includes("<shreddit-app") || html.includes("shreddit-");
  if (isShredditPage) {
    return {
      found: false,
      author: null,
      subreddit: null,
      createdAt: null,
      isRemoved: false,
      body: null,
      validPage: true
    };
  }
  
  return { found: false, author: null, subreddit: null, createdAt: null, isRemoved: false, body: null, validPage: false };
}


async function fetchCommentViaRedditOsint(url: string): Promise<any> {
  try {
    const osintUrl = process.env.REDDIT_OSINT_URL;
    if (!osintUrl) return null;

    const { fetch: undiciFetch } = await import("undici");
    const res = await undiciFetch(`${osintUrl}/api/external/check/comment?url=${encodeURIComponent(url)}`, {
      headers: { "Accept": "application/json" }
    });
    const json = await res.json().catch(() => null) as any;
    
    if (!res.ok) {
      if (res.status === 404 || (json && json.message?.includes("not found"))) {
        return { liveness: "not_found", author: "", subreddit: "", body_snippet: "" };
      }
      return null;
    }
    
    if (!json || json.success === false || !json.data) return null;
    return json.data;
  } catch (err: any) {
    logger.warn({ err, url }, "fetchCommentViaRedditOsint failed");
    return null;
  }
}

export async function deepCheckComment(
  proofUrl: string,
  expectedAuthor: string | string[],
  taskRedditLink: string,
  options?: { minCommentChars?: number; taskCreatedAt?: Date }
): Promise<ValidationResult> {
  return runDeepCheck(proofUrl, expectedAuthor, taskRedditLink, options);
}

async function runDeepCheck(
  proofUrl: string,
  expectedAuthor: string | string[],
  taskRedditLink: string,
  options?: { minCommentChars?: number; taskCreatedAt?: Date }
): Promise<ValidationResult> {
  const failures: string[] = [];
  
  const parsed = parseRedditProofUrl(proofUrl);
  if (!parsed || !parsed.commentId) {
    return {
      passed: false, autoApproved: false, status: "url_invalid",
      failures: ["Proof URL is not a valid reddit.com comment URL."],
      ...meta("url_invalid"),
    };
  }

  const expectedLowerList = (Array.isArray(expectedAuthor) ? expectedAuthor : [expectedAuthor])
    .map((u) => {
      let name = (u ?? "").toLowerCase().trim();
      name = name.replace(/^\/?u\//, "");
      return name;
    })
    .filter((u) => u.length > 0);

  const taskSubreddit = extractTaskSubreddit(taskRedditLink);
  const taskPostId = extractTaskPostId(taskRedditLink);

  // ── Post ID check (pure URL — no network needed) ───────────────────────────
  if (taskPostId && parsed.postId.toLowerCase() !== taskPostId.toLowerCase()) {
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

  // ── 0. redditOSITN (PRIMARY) ──────────────────────────────────────────────
  const osintData = await fetchCommentViaRedditOsint(proofUrl);
  if (osintData) {
    logger.info({ proofUrl }, "Comment check: using redditOSITN data");
    
    let cstate: SubmissionStatus | null = null;
    if (osintData.liveness === "removed" || osintData.liveness === "deleted" || osintData.liveness === "not_found") {
      cstate = "comment_deleted";
    }

    let subredditFound = (osintData.subreddit || "").toLowerCase();
    let authorFound = (osintData.author || "").toLowerCase();
    let bodyText = osintData.body_snippet || "";
    let createdAt = osintData.createdAt ? new Date(osintData.createdAt * 1000).toISOString() : null;

    if (cstate) {
      const reasonText = STATUS_META[cstate]?.label || "Removed";
      failures.push(`**${reasonText}**.`);
      return { passed: false, autoApproved: false, status: cstate, failures, authorFound, subredditFound, postLive: true, ...meta(cstate) };
    }

    if (taskSubreddit && subredditFound !== taskSubreddit) {
      failures.push(`Post is in r/${subredditFound} but task requires r/${taskSubreddit}.`);
      return { passed: false, autoApproved: false, status: "wrong_subreddit", failures, subredditFound, postLive: false, ...meta("wrong_subreddit") };
    }

    if (expectedLowerList.length > 0 && !expectedLowerList.includes(authorFound)) {
      const expectedDisplay = expectedLowerList.length === 1 ? `u/${expectedLowerList[0]}` : expectedLowerList.map((u) => `u/${u}`).join(" or ");
      failures.push(`Author mismatch: found u/${authorFound} but expected ${expectedDisplay}.`);
      return { passed: false, autoApproved: false, status: "author_mismatch", failures, authorFound, subredditFound, postLive: true, ...meta("author_mismatch") };
    }

    if (options?.taskCreatedAt && createdAt) {
      const commentDate = new Date(createdAt);
      if (isFinite(commentDate.getTime())) {
        const earliest = options.taskCreatedAt.getTime() - TASK_GRACE_MS;
        if (commentDate.getTime() < earliest) {
          failures.push(`Your comment was posted before this task was created — recycled old comments are not accepted. Comment date: ${commentDate.toUTCString()}. Task created: ${options.taskCreatedAt.toUTCString()}.`);
          return { passed: false, autoApproved: false, status: "stale_proof", failures, authorFound, subredditFound, postLive: true, ...meta("stale_proof") };
        }
      }
    }

    const minChars = options?.minCommentChars ?? MIN_COMMENT_CHARS;
    if (minChars > 0 && bodyText) {
      const plain = bodyText.trim();
      if (plain.length < minChars) {
        failures.push(`Comment is too short (${plain.length} characters). This task requires a genuine comment of at least ${minChars} characters.`);
        return { passed: false, autoApproved: false, status: "comment_too_short", failures, authorFound, subredditFound, postLive: true, ...meta("comment_too_short") };
      }
    }

    let ageMinutes: number | undefined;
    if (typeof osintData.createdAt === "number") {
      ageMinutes = Math.floor((Date.now() - osintData.createdAt * 1000) / 60000);
    }

    return {
      passed: true, autoApproved: true, status: "live", failures: [],
      authorFound, subredditFound, postLive: true,
      createdAt: createdAt ?? undefined,
      upvotes: osintData.upvotes,
      ageMinutes: ageMinutes,
      verifiedVia: "json_proxy",
      bodyText: bodyText || undefined,
      ...meta("live"),
    };
  }

  // ── JSON via session cookie (primary: direct undici → fallback: Python curl_cffi) ──
  //
  // Strategy:
  //   1. Direct undici fetch with the in-memory session cookie (fastest, no subprocess,
  //      always uses the freshest cookie from the cookie manager). This is the true
  //      primary path — a clean authenticated GET to the comment permalink JSON endpoint.
  //   2. Python curl_cffi fallback — browser TLS impersonation for cases where
  //      Reddit's Cloudflare/CDN blocks the datacenter IP on unauthenticated or
  //      standard TLS fingerprints.
  //   3. OAuth API — if REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET are configured.
  //
  // For a comment permalink with context=3, Reddit always returns the focused comment
  // in the response if it exists. Absence = gone. Failure to fetch = api_unreachable.
  const sub = parsed.isUserPost ? `user/${parsed.subreddit.slice(2)}` : `r/${parsed.subreddit}`;

  logger.info({ commentId: parsed.commentId, sub }, "Deep check: fetching via direct JSON (session cookie) + Python fallback");

  // ── 1. Direct JSON with session cookie (primary) ──────────────────────────
  let apiRes = await fetchCommentThreadViaDirectJson(sub, parsed.postId, parsed.commentId).catch(() => null);

  // ── 3. OAuth API last resort ───────────────────────────────────────────────
  if (!apiRes?.ok) {
    logger.info({ commentId: parsed.commentId }, "Deep check: Python failed — trying OAuth API");
    const oauthRes = await fetchCommentThreadViaOAuth(sub, parsed.postId, parsed.commentId).catch(() => null);
    if (oauthRes?.ok) apiRes = oauthRes;
  }

  if (!apiRes?.ok || !Array.isArray(apiRes.body)) {
    logger.warn(
      { commentId: parsed.commentId, ok: apiRes?.ok },
      "Deep check: all JSON sources failed — api_unreachable"
    );
    failures.push("Could not reach Reddit API to verify this comment. Please try again shortly.");
    return {
      passed: false, autoApproved: false, status: "api_unreachable",
      failures, subredditFound: parsed.subreddit, postLive: true,
      ...meta("api_unreachable"),
    };
  }

  // ── Parse the JSON response ───────────────────────────────────────────────
  const data = apiRes.body;
  const postData = (data[0] as any)?.data?.children?.[0]?.data;
  let subredditFound: string = ((postData?.subreddit as string | undefined) ?? parsed.subreddit).toLowerCase();

  const allComments: any[] = [];
  function flatten(children: any[]) {
    for (const child of children ?? []) {
      if (child.kind === "t1") {
        allComments.push(child.data);
        if (child.data.replies?.data?.children) {
          flatten(child.data.replies.data.children);
        }
      }
    }
  }
  flatten((data[1] as any)?.data?.children ?? []);

  const target = allComments.find((c) => c.id === parsed.commentId);

  if (!target) {
    // JSON succeeded but the comment is not in the focused thread.
    // For a comment permalink this is definitive — the comment no longer exists.
    logger.warn(
      { commentId: parsed.commentId },
      "Deep check: Python JSON succeeded but comment absent from thread — comment_missing"
    );
    failures.push(`Comment ID "${parsed.commentId}" was not found on the post — it may have been deleted or removed.`);
    return {
      passed: false, autoApproved: false, status: "comment_missing",
      failures, subredditFound, postLive: true,
      ...meta("comment_missing"),
    };
  }

  // ── Extract comment fields ────────────────────────────────────────────────
  const authorFound = (target.author ?? "").toLowerCase();
  const bodyText: string = target.body ?? "";
  const createdAt: string | null = target.created_utc
    ? new Date((target.created_utc as number) * 1000).toISOString()
    : null;

  // ── Liveness / removal classification ────────────────────────────────────
  const cstate = classifyComment(target);
  if (cstate) {
    const reasonText = STATUS_META[cstate]?.label || "Removed";
    failures.push(`**${reasonText}**.`);
    return {
      passed: false, autoApproved: false, status: cstate,
      failures, authorFound, subredditFound, postLive: true,
      ...meta(cstate),
    };
  }

  // ── Subreddit check ───────────────────────────────────────────────────────
  if (taskSubreddit && subredditFound !== taskSubreddit) {
    failures.push(`Post is in r/${subredditFound} but task requires r/${taskSubreddit}.`);
    return {
      passed: false, autoApproved: false, status: "wrong_subreddit",
      failures, subredditFound, postLive: false,
      ...meta("wrong_subreddit"),
    };
  }

  // ── Author check ──────────────────────────────────────────────────────────
  if (expectedLowerList.length > 0 && !expectedLowerList.includes(authorFound)) {
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

  // ── Freshness check ───────────────────────────────────────────────────────
  if (options?.taskCreatedAt && createdAt) {
    const commentDate = new Date(createdAt);
    if (isFinite(commentDate.getTime())) {
      const earliest = options.taskCreatedAt.getTime() - TASK_GRACE_MS;
      if (commentDate.getTime() < earliest) {
        failures.push(
          `Your comment was posted before this task was created — recycled old comments are not accepted. ` +
          `Comment date: ${commentDate.toUTCString()}. Task created: ${options.taskCreatedAt.toUTCString()}.`
        );
        return {
          passed: false, autoApproved: false, status: "stale_proof",
          failures, authorFound, subredditFound, postLive: true,
          ...meta("stale_proof"),
        };
      }
    }
  }

  // ── Character length check ────────────────────────────────────────────────
  const minChars = options?.minCommentChars ?? MIN_COMMENT_CHARS;
  if (minChars > 0 && bodyText) {
    const plain = bodyText.trim();
    if (plain.length < minChars) {
      failures.push(
        `Comment is too short (${plain.length} characters). ` +
        `This task requires a genuine comment of at least ${minChars} characters.`
      );
      return {
        passed: false, autoApproved: false, status: "comment_too_short",
        failures, authorFound, subredditFound, postLive: true,
        ...meta("comment_too_short"),
      };
    }
  }

  // All checks passed!
  return {
    passed: true,
    autoApproved: true,
    status: "live",
    failures: [],
    authorFound,
    subredditFound,
    postLive: true,
    createdAt: createdAt ?? undefined,
    verifiedVia: "json_proxy",
    bodyText: bodyText || undefined,
    ...meta("live"),
  };
}
