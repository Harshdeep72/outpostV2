import { logger } from "../lib/logger.js";
import { proxyFetchText } from "./proxy.js";
import { parseRedditProofUrl, extractTaskSubreddit, extractTaskPostId, SubmissionStatus, ValidationResult } from "./reddit-validator.js";
import { commentValidationCache } from "./cache.js";
import { getOAuthToken, invalidateOAuthToken } from "./reddit.js";
import { executePythonRedditClient } from "./pythonClient.js";

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

async function fetchCommentThreadViaPythonClient(
  sub: string,
  postId: string,
  commentId: string
): Promise<{ ok: boolean; body: any } | null> {
  try {
    const url = `https://www.reddit.com/${sub}/comments/${postId}/_/${commentId}.json?context=3&raw_json=1`;
    const visitFirst = `https://www.reddit.com/${sub}/comments/${postId}/_/${commentId}/`;

    const result = await executePythonRedditClient({
      url,
      visitFirst,
      isJson: true,
      useProxy: true,
    });

    if (result.ok && result.body) {
      return { ok: true, body: result.body };
    }
  } catch (err) {
    logger.warn({ err, sub, postId, commentId }, "fetchCommentThreadViaPythonClient failed");
  }
  return null;
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

/**
 * Deep check for a specific Reddit comment.
 * Performs validation of the comment link using parallel JSON, RSS, and HTML fetches.
 * Highly robust against IP rate limits, API blocks, and cached RSS feeds.
 */
export async function deepCheckComment(
  proofUrl: string,
  expectedAuthor: string | string[],
  taskRedditLink: string,
  options?: { minCommentChars?: number; taskCreatedAt?: Date }
): Promise<ValidationResult> {
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

  const cacheKey = `${parsed.commentId}:${expectedLowerList.sort().join(",")}:${taskRedditLink}:${options?.minCommentChars ?? 0}`;
  const cached = commentValidationCache.get(cacheKey);
  if (cached) {
    logger.info({ commentId: parsed.commentId }, "Deep check: cache hit");
    return cached;
  }

  const result = await runDeepCheck(proofUrl, expectedAuthor, taskRedditLink, options);
  
  if (result.status !== "api_unreachable") {
    commentValidationCache.set(cacheKey, result);
  }
  return result;
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

  // ── Parallel fetch URLs targeting the comment specifically ──────────────────
  // Unauthenticated JSON access has been deprecated by Reddit. OAuth is now the
  // sole JSON source; RSS and old.reddit HTML remain as secondary fallbacks.
  const sub = parsed.isUserPost ? `user/${parsed.subreddit.slice(2)}` : `r/${parsed.subreddit}`;

  const rssUrls = [
    `https://www.reddit.com/${sub}/comments/${parsed.postId}/_/${parsed.commentId}/.rss`,
    `https://old.reddit.com/${sub}/comments/${parsed.postId}/_/${parsed.commentId}/.rss`
  ];

  const htmlUrls = [
    `https://old.reddit.com/${sub}/comments/${parsed.postId}/_/${parsed.commentId}/`,
    `https://www.reddit.com/${sub}/comments/${parsed.postId}/_/${parsed.commentId}/`
  ];

  logger.info({ commentId: parsed.commentId }, "Executing parallel deep comment check");

  // ── Phase 1: fire all sources in parallel ─────────────────────────────────
  // Python JSON runs alongside OAuth so there is no extra serial hop when
  // OAuth is not configured (the common case). Proxy HTML+RSS also run at
  // the same time so every network source starts at t=0.
  let [rssHtml, htmlContent, oauthRes, pythonJsonRes] = await Promise.all([
    proxyFetchText(rssUrls, { timeoutMs: 8000 }).catch(() => null),
    proxyFetchText(htmlUrls, { timeoutMs: 8000 }).catch(() => null),
    fetchCommentThreadViaOAuth(sub, parsed.postId, parsed.commentId).catch(() => null),
    fetchCommentThreadViaPythonClient(sub, parsed.postId, parsed.commentId).catch(() => null),
  ]);

  // Pick the best JSON result: Python is PRIMARY — curl_cffi browser TLS
  // impersonation is more reliable from datacenter IPs than OAuth (which
  // still hits Reddit's CDN and can be blocked). OAuth is the fallback for
  // environments where curl_cffi is unavailable or the Python process fails.
  const pythonRes = pythonJsonRes;
  const effectiveJsonRes = pythonRes?.ok ? pythonRes : oauthRes;
  const jsonSource = pythonRes?.ok ? ("json_proxy" as const) : ("oauth" as const);

  if (pythonRes?.ok) {
    logger.info({ commentId: parsed.commentId }, "Deep check: Python curl_cffi JSON succeeded (primary source)");
  } else if (oauthRes?.ok) {
    logger.info({ commentId: parsed.commentId }, "Deep check: OAuth JSON succeeded (Python unavailable/failed — fallback)");
  } else {
    logger.info({ commentId: parsed.commentId }, "Deep check: both Python and OAuth JSON failed — falling back to HTML+RSS");
  }

  // ── Phase 2: parallel Python fallbacks for any source that proxy missed ───
  // Both fallbacks fire simultaneously — only one round of Python latency
  // regardless of how many sources need it.
  // Proxy may return a Cloudflare challenge page or login wall instead of null.
  // Trigger Python curl_cffi fallback whenever the returned content doesn't
  // look like a real Reddit page, not just when the proxy returned null.
  const htmlLooksValid =
    !!htmlContent &&
    (htmlContent.includes('class="commentarea"') ||
     htmlContent.includes('id="siteTable"') ||
     htmlContent.includes('data-subreddit=') ||
     htmlContent.includes('<shreddit-comment-tree') ||
     htmlContent.includes('<shreddit-app') ||
     htmlContent.includes('shreddit-'));
  const rssLooksValid = !!rssHtml && rssHtml.includes('<feed');
  const needPyHtml = !htmlLooksValid;
  const needPyRss  = !rssLooksValid;

  if (needPyHtml || needPyRss) {
    logger.info(
      { commentId: parsed.commentId, needPyHtml, needPyRss },
      "Deep check: proxy missed sources — running Python curl_cffi fallbacks in parallel"
    );
    const [pyHtmlRes, pyRssRes] = await Promise.all([
      needPyHtml
        ? executePythonRedditClient({ url: htmlUrls[0]!, isJson: false, useProxy: true, timeout: 8 }).catch(() => null)
        : Promise.resolve(null),
      needPyRss
        ? executePythonRedditClient({ url: rssUrls[0]!, isJson: false, useProxy: true, timeout: 8 }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (needPyHtml && pyHtmlRes?.ok && typeof pyHtmlRes.body === "string") {
      htmlContent = pyHtmlRes.body;
      logger.info({ commentId: parsed.commentId }, "Deep check: Python client supplied HTML");
    }
    if (needPyRss && pyRssRes?.ok && typeof pyRssRes.body === "string") {
      rssHtml = pyRssRes.body;
      logger.info({ commentId: parsed.commentId }, "Deep check: Python client supplied RSS");
    }
  }

  let authorFound: string | null = null;
  let subredditFound: string | null = null;
  let createdAt: string | null = null;
  let bodyText: string | null = null;
  let commentStatus: SubmissionStatus = "live";
  // Which source ultimately confirmed the comment's state (for proofVerifiedVia).
  let verifiedVia: ValidationResult["verifiedVia"] = undefined;
  // Track whether the JSON fetch itself succeeded so HTML-only "not found"
  // results can be treated as inconclusive rather than confirmed-removed.
  let jsonSucceeded = false;

  // 1. Evaluate JSON result (OAuth preferred, proxy JSON fallback)
  if (effectiveJsonRes && effectiveJsonRes.ok) {
    logger.info({ commentId: parsed.commentId, source: jsonSource }, "Deep check: JSON fetch succeeded");
    jsonSucceeded = true;
    const data = effectiveJsonRes.body;
    const postListing = Array.isArray(data) ? data[0] : null;
    const postData = postListing?.data?.children?.[0]?.data;
    if (postData) {
      subredditFound = (postData.subreddit ?? "").toLowerCase();
    }

    const commentsListing = Array.isArray(data) ? data[1] : null;
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
    flatten(commentsListing?.data?.children ?? []);
    const target = allComments.find((c) => c.id === parsed.commentId);
    
    if (target) {
      authorFound = (target.author ?? "").toLowerCase();
      bodyText = target.body ?? "";
      createdAt = target.created_utc ? new Date(target.created_utc * 1000).toISOString() : null;
      const cstate = classifyComment(target);
      if (cstate) {
        commentStatus = cstate;
      }
      verifiedVia = jsonSource;
    }
  }

  // 2. Evaluate HTML result if JSON did not fully resolve the comment
  if (!authorFound && htmlContent) {
    logger.info({ commentId: parsed.commentId, htmlLength: htmlContent.length }, "Deep check: falling back to HTML parser");
    const parsedHtml = parseHtmlComment(htmlContent, parsed.commentId);
    logger.info({ commentId: parsed.commentId, parsedHtmlFound: parsedHtml.found, parsedHtmlIsRemoved: parsedHtml.isRemoved, parsedHtmlValid: parsedHtml.validPage }, "HTML parse result");
    if (parsedHtml.validPage) {
      if (parsedHtml.found) {
        subredditFound = parsedHtml.subreddit || subredditFound;
        createdAt = parsedHtml.createdAt || createdAt;
        bodyText = parsedHtml.body || bodyText;
        verifiedVia = "html";
        if (parsedHtml.isRemoved) {
          commentStatus = "comment_deleted";
          // Use a sentinel so the flow reaches the liveness check instead of
          // falling through to RSS and returning comment_missing.
          authorFound = parsedHtml.author ?? (expectedLowerList.length === 0 ? "__removed__" : null);
        } else {
          // Comment is visible on old.reddit HTML.
          // If we can read the author from HTML, use it; otherwise in liveness-only
          // mode (expectedLowerList empty) use a sentinel so we don't fall through
          // to RSS and risk returning comment_missing for a live comment.
          authorFound = parsedHtml.author ?? (expectedLowerList.length === 0 ? "__live__" : null);
        }
      } else {
        // Comment not found on a valid Reddit page.
        //
        // Only old.reddit is fully server-rendered, so only old.reddit's
        // "not found" is a reliable removal signal (parsedHtml.isRemoved: true).
        // Shreddit lazy-loads comments via JS — absence in initial HTML is
        // inconclusive, so we fall through to RSS instead of locking in "deleted".
        if (!parsedHtml.isRemoved) {
          logger.info(
            { commentId: parsed.commentId },
            "Deep check: shreddit page didn't include comment (lazy-loaded?) — deferring to RSS"
          );
          // Leave authorFound null so execution falls through to the RSS step.
        } else {
          // old.reddit confirmed the comment is not present — treat as removed.
          // In liveness-only mode still require JSON corroboration to avoid
          // false reversals from a bad/intercepted proxy page.
          if (expectedLowerList.length === 0 && !jsonSucceeded) {
            logger.warn(
              { commentId: parsed.commentId },
              "Deep check: old.reddit HTML says not found but JSON was unavailable — treating as inconclusive (liveness mode)"
            );
            return {
              passed: false,
              autoApproved: false,
              status: "api_unreachable",
              failures: ["Comment not found in HTML verification — treating as inconclusive pending manual review."],
              subredditFound: subredditFound ?? parsed.subreddit,
              postLive: true,
              ...meta("api_unreachable"),
            };
          }
          commentStatus = "comment_deleted";
          authorFound = Array.isArray(expectedAuthor) ? expectedAuthor[0] : expectedAuthor;
          if (!authorFound) authorFound = "__deleted__";
        }
      }
    }
  }

  // 3. Evaluate RSS result if still not resolved
  if (!authorFound && rssHtml && rssHtml.includes("<feed")) {
    logger.info({ commentId: parsed.commentId, rssLength: rssHtml.length }, "Deep check: falling back to RSS parser");
    const catMatch = /<category\s+[^>]*term="([^"]+)"/i.exec(rssHtml);
    subredditFound = catMatch ? catMatch[1].toLowerCase() : subredditFound;

    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;
    while ((match = entryRegex.exec(rssHtml)) !== null) {
      const entryContent = match[1];
      if (entryContent.includes(`<id>t1_${parsed.commentId}</id>`) || entryContent.includes(`<id>t1_${parsed.commentId.toLowerCase()}</id>`)) {
        const authMatch = /<author>\s*<name>\/u\/([A-Za-z0-9_-]+)<\/name>/i.exec(entryContent);
        if (authMatch) {
          authorFound = authMatch[1].toLowerCase();
          bodyText = entryContent; // Contains raw XML, but we only need it for length/date checks
          const pubMatch = /<(?:published|updated)>([\s\S]*?)<\/(?:published|updated)>/i.exec(entryContent);
          createdAt = pubMatch ? pubMatch[1].trim() : null;
          verifiedVia = "rss";
          break;
        }
      }
    }
    
    // RSS requires HTML cross-check since RSS caches deleted comments.
    // However, only old.reddit is authoritative — shreddit lazy-loads comments
    // so "not found in shreddit HTML" is inconclusive and we trust RSS instead.
    if (authorFound && htmlContent) {
      const parsedHtml = parseHtmlComment(htmlContent, parsed.commentId);
      if (parsedHtml.validPage) {
        // parsedHtml.isRemoved is true ONLY for old.reddit confirmed removal.
        // For shreddit not-found it is false — in that case trust RSS.
        if (parsedHtml.isRemoved) {
          commentStatus = "comment_deleted";
        }
      } else {
        logger.warn({ commentId: parsed.commentId }, "Deep check: RSS found comment but HTML verification page was invalid/blocked");
        return {
          passed: false,
          autoApproved: false,
          status: "api_unreachable",
          failures: ["Relying on RSS but HTML verification page returned a login wall or rate limit."],
          authorFound,
          subredditFound: subredditFound ?? parsed.subreddit,
          postLive: true,
          ...meta("api_unreachable"),
        };
      }
    } else if (authorFound && !htmlContent) {
      // HTML is blocked (server IP rate-limited / 403 from Reddit).
      // The permalink-specific RSS already confirmed the comment exists — trust it
      // and continue so the comment can be approved instead of always blocking.
      logger.info({ commentId: parsed.commentId }, "Deep check: RSS found comment, HTML unavailable (IP blocked) — trusting RSS");
    }
  }

  // If no source could resolve the comment details
  if (!authorFound) {
    logger.warn({ commentId: parsed.commentId }, "Deep check: comment not found in any source");
    failures.push(`Comment ID "${parsed.commentId}" not found on the post — it was likely removed by Reddit/Automod.`);
    return {
      passed: false, autoApproved: false, status: "comment_missing",
      failures, subredditFound: subredditFound ?? parsed.subreddit, postLive: true,
      ...meta("comment_missing"),
    };
  }

  // ── Subreddit Check ────────────────────────────────────────────────────────
  subredditFound = subredditFound ?? parsed.subreddit;
  if (taskSubreddit && subredditFound !== taskSubreddit) {
    failures.push(`Post is in r/${subredditFound} but task requires r/${taskSubreddit}.`);
    return {
      passed: false, autoApproved: false, status: "wrong_subreddit",
      failures, subredditFound, postLive: false,
      ...meta("wrong_subreddit"),
    };
  }

  // ── Author Check ───────────────────────────────────────────────────────────
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

  // ── Liveness Check ─────────────────────────────────────────────────────────
  if (commentStatus !== "live") {
    const reasonText = STATUS_META[commentStatus]?.label.toLowerCase() ?? "removed";
    failures.push(`Comment is **${reasonText}**.`);
    return {
      passed: false, autoApproved: false, status: commentStatus,
      failures, authorFound, subredditFound, postLive: true,
      ...meta(commentStatus),
    };
  }

  // ── Freshness Check ────────────────────────────────────────────────────────
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

  // ── Character Length Check ──────────────────────────────────────────────────
  const minChars = options?.minCommentChars ?? MIN_COMMENT_CHARS;
  if (minChars > 0 && bodyText) {
    const plain = bodyText.includes("<") && bodyText.includes(">") ? decodeRssContent(bodyText) : bodyText.trim();
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
    verifiedVia,
    bodyText: bodyText ?? undefined,
    ...meta("live"),
  };
}
