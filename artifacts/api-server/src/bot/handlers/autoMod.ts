import {
  type Message,
  type OmitPartialGroupDMChannel,
  PermissionFlagsBits,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { hasAdminRole, hasModRole } from "../util.js";

// #chitchat channel ID where images are disallowed (text & gifs only)
export const CHITCHAT_CHANNEL_ID = "1565314111372394583";
// #media channel ID where messages must be real photos or videos (no GIFs, no plain texting)
export const MEDIA_CHANNEL_ID = "1567226854778208318";
// #tasks channel ID where messages must be posted by staff/bot only
export const TASKS_CHANNEL_ID = "1565661343737192531";
// #payment-proof channel ID where messages must be payment screenshots/proofs only
export const PAYMENT_PROOF_CHANNEL_ID = "1565798973690876044";
// #bot-commands channel ID where messages must be bot commands only
export const BOT_COMMANDS_CHANNEL_ID = "1565663449583980624";

/**
 * Checks whether content or attachments contain non-GIF images or file uploads
 * (used for #chitchat to forbid image files/links while allowing GIFs and text).
 */
export function isForbiddenMediaInChitchat(
  content: string,
  attachments: { contentType?: string | null; name?: string | null }[] = []
): boolean {
  for (const att of attachments) {
    const ct = att.contentType?.toLowerCase() || "";
    const name = att.name?.toLowerCase() || "";
    // Allow gifs
    if (ct === "image/gif" || name.endsWith(".gif")) continue;
    // Block other images or file uploads
    if (ct.startsWith("image/") || /\.(png|jpe?g|webp|bmp|heic|svg)$/i.test(name)) {
      return true;
    }
  }

  // Check URLs in content
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const matches = content.match(urlRegex) || [];
  for (const url of matches) {
    // Known GIF providers
    if (/https?:\/\/(www\.)?(tenor\.com|giphy\.com|klipy\.com|gfycat\.com)\//i.test(url)) {
      continue;
    }
    const cleanUrl = url.split("?")[0]?.toLowerCase() || "";
    if (cleanUrl.endsWith(".gif") || cleanUrl.endsWith(".gifv")) {
      continue;
    }
    // Block direct image links
    if (/\.(png|jpe?g|webp|bmp|heic|svg)$/i.test(cleanUrl)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether message contains valid non-GIF photos, images, or videos.
 * Used for #media where GIFs and pure texting are disallowed.
 */
export function isValidMediaOnly(
  content: string,
  attachments: { contentType?: string | null; name?: string | null }[] = []
): boolean {
  // 1. Check attachments
  let hasValidMediaAttachment = false;
  for (const att of attachments) {
    const ct = att.contentType?.toLowerCase() || "";
    const name = att.name?.toLowerCase() || "";

    // Explicitly reject GIFs
    if (ct === "image/gif" || name.endsWith(".gif") || name.endsWith(".gifv")) {
      return false;
    }

    // Allow non-gif images and videos
    if (
      ct.startsWith("image/") ||
      ct.startsWith("video/") ||
      /\.(png|jpe?g|webp|bmp|heic|mp4|webm|mov|mkv)$/i.test(name)
    ) {
      hasValidMediaAttachment = true;
    }
  }
  if (hasValidMediaAttachment) return true;

  // 2. Check URLs in content
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const matches = content.match(urlRegex) || [];
  if (matches.length === 0) return false; // Pure text with no attachments = disallowed

  let hasValidMediaUrl = false;
  for (const url of matches) {
    // Explicitly reject GIF providers or .gif links
    if (/https?:\/\/(www\.)?(tenor\.com|giphy\.com|klipy\.com|gfycat\.com)\//i.test(url)) {
      return false;
    }
    const cleanUrl = url.split("?")[0]?.toLowerCase() || "";
    if (cleanUrl.endsWith(".gif") || cleanUrl.endsWith(".gifv")) {
      return false;
    }
    // Allow direct image or video URLs
    if (/\.(png|jpe?g|webp|bmp|heic|mp4|webm|mov|mkv)$/i.test(cleanUrl)) {
      hasValidMediaUrl = true;
    }
  }

  return hasValidMediaUrl;
}

function isStaff(message: Message | OmitPartialGroupDMChannel<Message>): boolean {
  const member = message.member ?? (message.guild && message.author ? message.guild.members.cache.get(message.author.id) : null);
  if (member && message.guild) {
    if (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ManageMessages) ||
      hasAdminRole(member as any, message.guild) ||
      hasModRole(member as any, message.guild)
    ) {
      return true;
    }
  }
  return false;
}

interface MessageRecord {
  normalized: string;
  channelId: string;
  timestamp: number;
}

interface SpamTracker {
  recentMessages: MessageRecord[];
  spamWarningCount: number;
  lastSpamActionAt: number;
}

const userSpamTrackers = new Map<string, SpamTracker>();

// Clean up idle trackers periodically to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [userId, tracker] of userSpamTrackers.entries()) {
    tracker.recentMessages = tracker.recentMessages.filter((m) => now - m.timestamp < 120_000);
    if (tracker.recentMessages.length === 0 && now - tracker.lastSpamActionAt > 300_000) {
      userSpamTrackers.delete(userId);
    }
  }
}, 60_000).unref?.();

/**
 * Checks if a message attempts to tag roles, @everyone/@here, or mass user pings.
 */
export function checkRoleOrMassMention(message: Message | OmitPartialGroupDMChannel<Message>): {
  blocked: boolean;
  reason: string;
} {
  // 1. Explicit Discord role mentions or raw role ping syntax <@&id>
  if (message.mentions.roles.size > 0 || /<@&\d+>/i.test(message.content)) {
    return { blocked: true, reason: "mentioning roles is strictly not allowed in any channel" };
  }

  // 2. Mass mentions: @everyone / @here
  if (message.mentions.everyone || /@(everyone|here)\b/i.test(message.content)) {
    return { blocked: true, reason: "mass pings (@everyone / @here) are strictly not allowed" };
  }

  // 3. Literal text matching any server role name prefixed by @ (case-insensitive)
  if (message.guild && message.content.includes("@")) {
    const content = message.content;
    const roles = message.guild.roles.cache;
    for (const [_, role] of roles) {
      if (role.name === "@everyone") continue;
      const escaped = role.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`(^|\\s|[^a-zA-Z0-9])@${escaped}(\\b|[^a-zA-Z0-9]|$)`, "i");
      if (regex.test(content)) {
        return {
          blocked: true,
          reason: `mentioning roles (@${role.name}) is strictly not allowed in any channel`,
        };
      }
    }
  }

  // 4. Mass user pings (4+ users)
  if (message.mentions.users.size >= 4) {
    return { blocked: true, reason: "tagging multiple members is not allowed" };
  }

  return { blocked: false, reason: "" };
}

/**
 * Checks for repeated / duplicate message spam across single or multiple channels.
 */
export function checkSpam(message: Message | OmitPartialGroupDMChannel<Message>): {
  isSpam: boolean;
  reason: string;
  shouldTimeout: boolean;
} {
  const userId = message.author.id;
  const now = Date.now();
  const normalized = message.content.trim().toLowerCase().replace(/\s+/g, " ");

  let tracker = userSpamTrackers.get(userId);
  if (!tracker) {
    tracker = { recentMessages: [], spamWarningCount: 0, lastSpamActionAt: 0 };
    userSpamTrackers.set(userId, tracker);
  }

  // Retain messages from the last 2 minutes
  tracker.recentMessages = tracker.recentMessages.filter((m) => now - m.timestamp < 120_000);

  // 1. Repeated / Duplicate message checks (ignore empty or single-character messages)
  if (normalized.length >= 3) {
    // Identical message in same channel within 45 seconds
    const duplicatesSameChannel = tracker.recentMessages.filter(
      (m) => m.normalized === normalized && m.channelId === message.channelId && now - m.timestamp < 45_000
    );

    // Identical message in another channel within 60 seconds (cross-channel spam)
    const duplicatesOtherChannel = tracker.recentMessages.filter(
      (m) => m.normalized === normalized && m.channelId !== message.channelId && now - m.timestamp < 60_000
    );

    if (duplicatesSameChannel.length >= 1 || duplicatesOtherChannel.length >= 1) {
      tracker.spamWarningCount++;
      tracker.lastSpamActionAt = now;

      const reason = duplicatesOtherChannel.length >= 1
        ? "cross-posting identical messages across multiple channels is not allowed"
        : "please do not spam the same message repeatedly";

      const shouldTimeout = tracker.spamWarningCount >= 3;
      return { isSpam: true, reason, shouldTimeout };
    }
  }

  // 2. High-speed burst spam (more than 5 messages within 5 seconds)
  const burstCount = tracker.recentMessages.filter((m) => now - m.timestamp < 5_000).length;
  if (burstCount >= 5) {
    tracker.spamWarningCount++;
    tracker.lastSpamActionAt = now;
    return {
      isSpam: true,
      reason: "sending messages too quickly (burst spam)",
      shouldTimeout: tracker.spamWarningCount >= 2,
    };
  }

  // Valid message: record in user history
  tracker.recentMessages.push({
    normalized,
    channelId: message.channelId,
    timestamp: now,
  });

  return { isSpam: false, reason: "", shouldTimeout: false };
}

export async function handleAutoModMessage(
  message: Message | OmitPartialGroupDMChannel<Message>
): Promise<void> {
  if (message.author.bot) return;
  if (isStaff(message)) return;
  if (!message.inGuild() || !("send" in message.channel)) return;

  // 0. Anti-role-mention & Anti-mass-ping across ALL guild channels:
  // Non-staff members are strictly forbidden from tagging roles, @everyone/@here, or mass-pinging.
  const mentionCheck = checkRoleOrMassMention(message);
  if (mentionCheck.blocked) {
    try {
      await message.delete();
      const warning = await message.channel.send({
        content: `⚠️ <@${message.author.id}>, ${mentionCheck.reason}!`,
      });
      setTimeout(() => {
        warning.delete().catch(() => {});
      }, 5000).unref?.();
      logger.info(
        { author: message.author.tag, channel: message.channelId, content: message.content },
        "AutoMod deleted role/mass mention"
      );
    } catch (err) {
      logger.warn({ err }, "Failed to auto-moderate role mention");
    }
    return;
  }

  // 0.5. Anti-spam & Repeated message prevention across ALL guild channels:
  // Prevents members from spamming the same message repeatedly or flooding channels.
  const spamCheck = checkSpam(message);
  if (spamCheck.isSpam) {
    try {
      await message.delete();
      if (spamCheck.shouldTimeout && message.member && typeof (message.member as any).timeout === "function") {
        await (message.member as any).timeout(5 * 60 * 1000, "Automated anti-spam: repeated message spam").catch(() => {});
        const timeoutNotice = await message.channel.send({
          content: `🔇 <@${message.author.id}> has been timed out for 5 minutes due to repeated message spam.`,
        });
        setTimeout(() => {
          timeoutNotice.delete().catch(() => {});
        }, 8000).unref?.();
      } else {
        const warning = await message.channel.send({
          content: `⚠️ <@${message.author.id}>, ${spamCheck.reason}!`,
        });
        setTimeout(() => {
          warning.delete().catch(() => {});
        }, 5000).unref?.();
      }
      logger.info(
        { author: message.author.tag, channel: message.channelId, content: message.content },
        "AutoMod deleted spam message"
      );
    } catch (err) {
      logger.warn({ err }, "Failed to auto-moderate spam message");
    }
    return;
  }

  const attachments = Array.from(message.attachments.values());

  // 1. #chitchat: Only text and GIFs allowed (no image uploads or image links)
  if (message.channelId === CHITCHAT_CHANNEL_ID) {
    if (isForbiddenMediaInChitchat(message.content, attachments)) {
      try {
        await message.delete();
        const warning = await message.channel.send({
          content: `⚠️ <@${message.author.id}>, only text and GIFs are allowed in <#${CHITCHAT_CHANNEL_ID}>. Please share photos and images in <#${MEDIA_CHANNEL_ID}>!`,
        });
        setTimeout(() => {
          warning.delete().catch(() => {});
        }, 6000).unref?.();
        logger.info(
          { author: message.author.tag, channel: message.channelId },
          "AutoMod removed image from chitchat"
        );
      } catch (err) {
        logger.warn({ err }, "Failed to auto-moderate chitchat message");
      }
    }
    return;
  }

  // 2. #media: Photos & videos ONLY. GIFs and pure texting are disallowed.
  if (message.channelId === MEDIA_CHANNEL_ID) {
    if (!isValidMediaOnly(message.content, attachments)) {
      try {
        await message.delete();
        const warning = await message.channel.send({
          content: `⚠️ <@${message.author.id}>, <#${MEDIA_CHANNEL_ID}> is strictly for photos and videos (no GIFs or plain text). Please chat and share GIFs in <#${CHITCHAT_CHANNEL_ID}>!`,
        });
        setTimeout(() => {
          warning.delete().catch(() => {});
        }, 6000).unref?.();
        logger.info(
          { author: message.author.tag, channel: message.channelId },
          "AutoMod removed non-media or GIF message from #media"
        );
      } catch (err) {
        logger.warn({ err }, "Failed to auto-moderate media channel message");
      }
    }
    return;
  }

  // 3. #tasks: Read-only for regular members. Only bot and staff can post tasks.
  if (message.channelId === TASKS_CHANNEL_ID) {
    try {
      await message.delete();
      logger.info(
        { author: message.author.tag, channel: message.channelId },
        "AutoMod deleted non-staff message from #tasks"
      );
    } catch (err) {
      logger.warn({ err }, "Failed to auto-moderate tasks channel message");
    }
    return;
  }

  // 4. #payment-proof: Strictly payment screenshots / proofs only. Pure text chatting is disallowed.
  if (message.channelId === PAYMENT_PROOF_CHANNEL_ID) {
    if (!isValidMediaOnly(message.content, attachments)) {
      try {
        await message.delete();
        const warning = await message.channel.send({
          content: `⚠️ <@${message.author.id}>, <#${PAYMENT_PROOF_CHANNEL_ID}> is strictly for payment screenshots/proofs only. Please chat and discuss in <#${CHITCHAT_CHANNEL_ID}>!`,
        });
        setTimeout(() => {
          warning.delete().catch(() => {});
        }, 6000).unref?.();
        logger.info(
          { author: message.author.tag, channel: message.channelId },
          "AutoMod removed non-media chat message from #payment-proof"
        );
      } catch (err) {
        logger.warn({ err }, "Failed to auto-moderate payment-proof channel message");
      }
    }
    return;
  }

  // 5. #bot-commands: Strictly bot commands only. No conversational chatter, memes, or casual messages.
  if (message.channelId === BOT_COMMANDS_CHANNEL_ID) {
    const content = message.content.trim();

    // Recognized prefix commands for bots in the server (e.g. MEE6 !rank, FlaviBot .p / .play)
    const isPrefixCommand = /^[!.]\w+/i.test(content);
    if (isPrefixCommand) {
      return;
    }

    // Check if user typed our slash commands as plain text (e.g. /wallet, /drops, /myhold)
    const slashMatch = content.match(/^\/([a-zA-Z0-9_-]+)/i);
    const validSlashCommands = new Set([
      "wallet",
      "myhold",
      "mystatus",
      "mypayment",
      "paymentmethod",
      "drops",
      "payouthistory",
      "setupi",
      "setgcash",
      "setpaypal",
      "setwallet",
      "profile",
      "flair",
      "referral",
      "referraluse",
      "digest",
      "stats",
      "ping",
      "help",
    ]);

    try {
      await message.delete();
      if (slashMatch && validSlashCommands.has(slashMatch[1].toLowerCase())) {
        const cmdName = slashMatch[1].toLowerCase();
        const tip = await message.channel.send({
          content: `💡 <@${message.author.id}>, to run **/${cmdName}**, please select it from Discord's slash command popup (\`/\`) so the bot can process it!`,
        });
        setTimeout(() => {
          tip.delete().catch(() => {});
        }, 6000).unref?.();
      } else {
        const warning = await message.channel.send({
          content: `⚠️ <@${message.author.id}>, <#${BOT_COMMANDS_CHANNEL_ID}> is strictly for bot commands only! Please take all casual chatting, questions, and memes to <#${CHITCHAT_CHANNEL_ID}>.`,
        });
        setTimeout(() => {
          warning.delete().catch(() => {});
        }, 5000).unref?.();
      }
      logger.info(
        { author: message.author.tag, channel: message.channelId, content: message.content },
        "AutoMod deleted non-command chatter from #bot-commands"
      );
    } catch (err) {
      logger.warn({ err }, "Failed to auto-moderate bot-commands message");
    }
    return;
  }
}
