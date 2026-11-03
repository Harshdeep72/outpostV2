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
  if (message.member) {
    if (
      message.member.permissions.has(PermissionFlagsBits.Administrator) ||
      message.member.permissions.has(PermissionFlagsBits.ManageMessages) ||
      hasAdminRole(message.member) ||
      hasModRole(message.member)
    ) {
      return true;
    }
  }
  return false;
}

export async function handleAutoModMessage(
  message: Message | OmitPartialGroupDMChannel<Message>
): Promise<void> {
  if (message.author.bot) return;
  if (isStaff(message)) return;

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
}
