import { logger } from "../lib/logger.js";
import { proxyFetchJson } from "./proxy.js";
import { fetch as undiciFetch } from "undici";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchDirectText(url: string, timeoutMs = 6000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(url, {
      headers: {
        "User-Agent": DEFAULT_UA,
        "Accept": "application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "Direct XML fetch failed");
      return null;
    }
    const text = await res.text();
    return text;
  } catch (err) {
    logger.warn({ url, err }, "Direct XML fetch unexpected error");
    return null;
  } finally {
    clearTimeout(timer);
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
  | "author_mismatch"
  | "comment_missing"
  | "comment_deleted"
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
}

const STATUS_META: Record<SubmissionStatus, { emoji: string; label: string }> = {
  live: { emoji: "✅", label: "Live" },
  deleted_by_author: { emoji: "🗑️", label: "Deleted by author" },
  removed_by_mod: { emoji: "🛡️", label: "Removed by subreddit mod" },
  removed_by_reddit: { emoji: "🚫", label: "Removed by Reddit (anti-spam / TOS)" },
  removed_by_automod: { emoji: "🤖", label: "Filtered by AutoMod" },
  locked: { emoji: "🔒", label: "Post is locked" },
  not_found: { emoji: "❌", label: "Post not found / 404" },
  wrong_subreddit: { emoji: "🚷", label: "Wrong subreddit" },
  author_mismatch: { emoji: "👤", label: "Author mismatch" },
  comment_missing: { emoji: "❓", label: "Comment not found on post" },
  comment_deleted: { emoji: "🗑️", label: "Comment deleted/removed" },
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
      if (parts[0] === "r" && parts[2] === "s") return "share_link";
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

export async function validateRedditProof(
  proofUrl: string,
  // Backwards compatible: accept a single username (legacy single-account
  // path) OR an array (multi-account: any of the user's verified Reddit
  // accounts is acceptable as the proof author).
  expectedAuthor: string | string[],
  taskRedditLink: string
): Promise<ValidationResult> {
  const failures: string[] = [];

  const expectedLowerList = (Array.isArray(expectedAuthor) ? expectedAuthor : [expectedAuthor])
    .map((u) => {
      let name = (u ?? "").toLowerCase().trim();
      name = name.replace(/^\/?u\//, ""); // Strip leading u/ or /u/
      return name;
    })
    .filter((u) => u.length > 0);

  const parsed = parseRedditProofUrl(proofUrl);
  if (!parsed) {
    return {
      passed: false, autoApproved: false, status: "url_invalid",
      failures: ["Proof URL is not a valid reddit.com post or comment URL."],
      ...meta("url_invalid"),
    };
  }

  // Task link may be a full post URL (for comment/upvote/share/join tasks)
  // OR a subreddit URL / r/name shorthand (for post tasks). Either way we
  // only care about extracting the target subreddit for cross-checking.
  const taskSubreddit = extractTaskSubreddit(taskRedditLink);

  const urls = parsed.isUserPost
    ? [
        `https://www.reddit.com/user/${parsed.subreddit.slice(2)}/comments/${parsed.postId}.json?limit=500&raw_json=1`,
        `https://old.reddit.com/user/${parsed.subreddit.slice(2)}/comments/${parsed.postId}.json?limit=500&raw_json=1`,
      ]
    : [
        `https://www.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}.json?limit=500&raw_json=1`,
        `https://old.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}.json?limit=500&raw_json=1`,
      ];

  let result = await proxyFetchJson(urls, { timeoutMs: 6_000 });
  let data = result.body;
  let isRss = false;

  if (!result.ok && result.status !== 404) {
    logger.info({ proofUrl }, "JSON verification failed — attempting RSS fallback");
    try {
      const rssUrl = parsed.isUserPost
        ? `https://www.reddit.com/user/${parsed.subreddit.slice(2)}/comments/${parsed.postId}/.rss`
        : `https://www.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}/.rss`;
      const rssBody = await fetchDirectText(rssUrl, 6000);
      if (rssBody && rssBody.includes("<feed")) {
        isRss = true;
        data = rssBody;
        logger.info({ proofUrl }, "RSS fallback successful");
      }
    } catch (rssErr) {
      logger.warn({ rssErr, proofUrl }, "RSS fallback failed");
    }
  }

  if (!result.ok && !isRss) {
    if (result.status === 404) {
      return {
        passed: false, autoApproved: false, status: "not_found",
        failures: ["Reddit post not found or has been deleted (404)."],
        postLive: false,
        ...meta("not_found"),
      };
    }
    logger.warn({ status: result.status, proofUrl, via: result.via }, "Reddit proof fetch failed — falling back to manual review");
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

    // 2. Author and Comment Check
    let authorFound = "";
    let targetCommentText = "";
    
    if (parsed.commentId) {
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
      let match;
      while ((match = entryRegex.exec(data)) !== null) {
        const entryContent = match[1];
        if (entryContent.includes(`<id>t1_${parsed.commentId}</id>`) || entryContent.includes(`<id>t1_${parsed.commentId.toLowerCase()}</id>`)) {
          const authMatch = /<author>\s*<name>\/u\/([A-Za-z0-9_-]+)<\/name>/i.exec(entryContent);
          if (authMatch) {
            authorFound = authMatch[1].toLowerCase();
            targetCommentText = entryContent;
            break;
          }
        }
      }

      if (!authorFound) {
        logger.info({ proofUrl }, "Comment not found in Post RSS feed — attempting User RSS feed fallback");
        for (const user of expectedLowerList) {
          try {
            const userRssUrl = `https://www.reddit.com/user/${user}/.rss`;
            const rssBody = await fetchDirectText(userRssUrl, 6000);
            if (rssBody && rssBody.includes("<feed")) {
              const uEntries = rssBody.split("<entry>");
              for (const uEntry of uEntries) {
                if (uEntry.includes(`<id>t1_${parsed.commentId}</id>`) || uEntry.includes(`<id>t1_${parsed.commentId.toLowerCase()}</id>`)) {
                  authorFound = user;
                  targetCommentText = uEntry;
                  logger.info({ user, proofUrl }, "Comment found in User RSS feed!");
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
        failures.push(`Comment ID "${parsed.commentId}" not found on the post — it was likely removed by Reddit/Automod.`);
        return {
          passed: false, autoApproved: false, status: "comment_missing",
          failures, subredditFound, postLive: true,
          ...meta("comment_missing"),
        };
      }
    } else {
      // 1. Try to extract the post author directly from the post's RSS feed (data).
      // The post entry has id matching `t3_${parsed.postId}`.
      const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
      let match;
      while ((match = entryRegex.exec(data)) !== null) {
        const entryContent = match[1];
        if (entryContent.includes(`<id>t3_${parsed.postId}</id>`) || entryContent.includes(`<id>t3_${parsed.postId.toLowerCase()}</id>`)) {
          const authMatch = /<author>\s*<name>\/u\/([A-Za-z0-9_-]+)<\/name>/i.exec(entryContent);
          if (authMatch) {
            authorFound = authMatch[1].toLowerCase();
            break;
          }
        }
      }

      // 2. Fallback to User RSS feed if we couldn't find it in the post feed
      if (!authorFound) {
        for (const user of expectedLowerList) {
          try {
            const userRssUrl = `https://www.reddit.com/user/${user}/.rss`;
            const rssBody = await fetchDirectText(userRssUrl, 6000);
            if (rssBody && rssBody.includes("<feed")) {
              const uEntries = rssBody.split("<entry>");
              for (const uEntry of uEntries) {
                if (uEntry.includes(`<id>t3_${parsed.postId}</id>`) || uEntry.includes(`<id>t3_${parsed.postId.toLowerCase()}</id>`)) {
                  authorFound = user;
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

  const urls = parsed.isUserPost
    ? [
        `https://www.reddit.com/user/${parsed.subreddit.slice(2)}/comments/${parsed.postId}.json?limit=500&raw_json=1`,
        `https://old.reddit.com/user/${parsed.subreddit.slice(2)}/comments/${parsed.postId}.json?limit=500&raw_json=1`,
      ]
    : [
        `https://www.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}.json?limit=500&raw_json=1`,
        `https://old.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}.json?limit=500&raw_json=1`,
      ];

  const result = await proxyFetchJson(urls, { timeoutMs: 6_000 });

  if (!result.ok) {
    if (result.status === 404) {
      return {
        liveStatus: "deleted",
        detailedStatus: "not_found",
        statusLabel: "Post not found (404)",
        reason: "Reddit returned 404 — the post is gone.",
      };
    }
    // Transient — don't flip status, just leave as unknown so we'll retry next tick.
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
    // Reddit returned 200 but no children. Real deletions normally come back
    // either as a 404 (handled above) or with an explicit [deleted]/removed_by_category
    // marker on the post body. An empty listing is more likely a flaky proxy returning
    // junk JSON, so treat it as transient rather than flipping the row to "deleted".
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
