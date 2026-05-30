import { logger } from "../lib/logger.js";
import { proxyFetchJson, proxyFetchText } from "./proxy.js";
import { parseRedditProofUrl, extractTaskSubreddit, extractTaskPostId, SubmissionStatus, ValidationResult } from "./reddit-validator.js";
import { commentValidationCache } from "./cache.js";

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
    
    // Check if collapsed
    const idx = html.indexOf(idAttr);
    const fragmentStart = Math.max(0, idx - 300);
    // Grab 1000 characters after idx to ensure we capture the whole opening tag
    const fragment = html.substring(fragmentStart, idx + 1000);
    const isCollapsed = /class="[^"]*\bcollapsed\b[^"]*"/.test(fragment);
    
    // Extract author
    const authorMatch = fragment.match(/data-author="([^"]+)"/i);
    const author = authorMatch ? authorMatch[1].toLowerCase() : null;
    
    // Extract subreddit
    const subMatch = fragment.match(/data-subreddit="([^"]+)"/i) || html.match(/class="[^"]*r-([A-Za-z0-9_]+)[^"]*"/i);
    const subreddit = subMatch ? subMatch[1].toLowerCase() : null;
    
    // Extract body text
    let body: string | null = null;
    const bodyIdx = html.indexOf('class="usertext-body', idx);
    if (bodyIdx !== -1 && bodyIdx - idx < 3000) {
      const mdIdx = html.indexOf('class="md"', bodyIdx);
      if (mdIdx !== -1) {
        const pStart = html.indexOf('<p>', mdIdx);
        const pEnd = html.indexOf('</p>', pStart);
        if (pStart !== -1 && pEnd !== -1 && pEnd - pStart < 2000) {
          body = html.substring(pStart + 3, pEnd).replace(/<[^>]*>/g, ""); // strip inner tags
        }
      }
    }
    
    const isRemoved = isCollapsed ||
      !author ||
      author === "[deleted]" ||
      author === "[removed]" ||
      /\[\s*removed\s*\]/i.test(body ?? "") ||
      /\[\s*deleted\s*\]/i.test(body ?? "") ||
      /removed\s+by/i.test(body ?? "");
    
    return {
      found: true,
      author,
      subreddit,
      createdAt: null,
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

  // Check if it's a shreddit page but the comment is not found
  const isShredditPage = html.includes("<shreddit-comment-tree") || html.includes("<shreddit-app") || html.includes("shreddit-");
  if (isShredditPage) {
    return {
      found: false,
      author: null,
      subreddit: null,
      createdAt: null,
      isRemoved: true,
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
  const sub = parsed.isUserPost ? `user/${parsed.subreddit.slice(2)}` : `r/${parsed.subreddit}`;
  
  const jsonUrls = [
    `https://www.reddit.com/${sub}/comments/${parsed.postId}/_/${parsed.commentId}.json?context=3&raw_json=1`,
    `https://old.reddit.com/${sub}/comments/${parsed.postId}/_/${parsed.commentId}.json?context=3&raw_json=1`
  ];
  
  const rssUrls = [
    `https://www.reddit.com/${sub}/comments/${parsed.postId}/_/${parsed.commentId}/.rss`,
    `https://old.reddit.com/${sub}/comments/${parsed.postId}/_/${parsed.commentId}/.rss`
  ];

  const htmlUrls = [
    `https://old.reddit.com/${sub}/comments/${parsed.postId}/_/${parsed.commentId}/`,
    `https://old.reddit.com/${sub}/comments/${parsed.postId}/_/${parsed.commentId}/`
  ];

  logger.info({ commentId: parsed.commentId }, "Executing parallel deep comment check");

  // Fetch JSON, RSS, and HTML in parallel
  const [jsonRes, rssHtml, htmlContent] = await Promise.all([
    proxyFetchJson(jsonUrls, { timeoutMs: 8000 }).catch(() => null),
    proxyFetchText(rssUrls, { timeoutMs: 8000 }).catch(() => null),
    proxyFetchText(htmlUrls, { timeoutMs: 8000 }).catch(() => null)
  ]);

  let authorFound: string | null = null;
  let subredditFound: string | null = null;
  let createdAt: string | null = null;
  let bodyText: string | null = null;
  let commentStatus: SubmissionStatus = "live";

  // 1. Evaluate JSON result (if successful)
  if (jsonRes && jsonRes.ok) {
    logger.info({ commentId: parsed.commentId }, "Deep check: JSON fetch succeeded");
    const data = jsonRes.body;
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
    }
  }

  // 2. Evaluate HTML result if JSON did not fully resolve the comment
  if (!authorFound && htmlContent) {
    logger.info({ commentId: parsed.commentId, htmlLength: htmlContent.length }, "Deep check: falling back to HTML parser");
    const parsedHtml = parseHtmlComment(htmlContent, parsed.commentId);
    logger.info({ commentId: parsed.commentId, parsedHtmlFound: parsedHtml.found, parsedHtmlIsRemoved: parsedHtml.isRemoved, parsedHtmlValid: parsedHtml.validPage }, "HTML parse result");
    if (parsedHtml.validPage) {
      if (parsedHtml.found) {
        authorFound = parsedHtml.author;
        subredditFound = parsedHtml.subreddit || subredditFound;
        createdAt = parsedHtml.createdAt || createdAt;
        bodyText = parsedHtml.body || bodyText;
        if (parsedHtml.isRemoved) {
          commentStatus = "comment_deleted";
        }
      } else {
        // Comment not found on a valid page -> deleted/removed
        commentStatus = "comment_deleted";
        // Assign a mock author to satisfy subsequent checks and prevent returning comment_missing
        authorFound = Array.isArray(expectedAuthor) ? expectedAuthor[0] : expectedAuthor;
        if (!authorFound) authorFound = "deleted";
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
          break;
        }
      }
    }
    
    // RSS requires HTML verification since RSS caches deleted comments
    if (authorFound && htmlContent) {
      const parsedHtml = parseHtmlComment(htmlContent, parsed.commentId);
      if (parsedHtml.validPage) {
        if (parsedHtml.found && parsedHtml.isRemoved) {
          commentStatus = "comment_deleted";
        } else if (!parsedHtml.found) {
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
      logger.warn({ commentId: parsed.commentId }, "Deep check: RSS found comment but HTML fetch failed completely");
      return {
        passed: false,
        autoApproved: false,
        status: "api_unreachable",
        failures: ["Relying on RSS but HTML verification fetch failed (network / proxy error)."],
        authorFound,
        subredditFound: subredditFound ?? parsed.subreddit,
        postLive: true,
        ...meta("api_unreachable"),
      };
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
    ...meta("live"),
  };
}
