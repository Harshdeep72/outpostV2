import {
  type Message,
  type OmitPartialGroupDMChannel,
  PermissionFlagsBits,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { hasAdminRole, hasModRole } from "../util.js";

// #chitchat channel ID where images are disallowed (text & gifs only)
export const CHITCHAT_CHANNEL_ID = "1565314111372394583";
// #media channel ID where messages must contain media (images, videos, gifs)
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
 * Checks whether message contains any media (attachment or media URL).
 * Used for #media to ensure messages contain media (no pure text chatting).
 */
export function hasMedia(
  content: string,
  attachments: { contentType?: string | null; name?: string | null }[] = []
): boolean {
  // Direct attachments (photos, videos, audio, files)
  if (attachments.length > 0) return true;

  // Media link providers or media file extensions in URLs
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const matches = content.match(urlRegex) || [];
  for (const url of matches) {
    if (
      /https?:\/\/(www\.)?(tenor\.com|giphy\.com|klipy\.com|gfycat\.com|imgur\.com|streamable\.com|youtube\.com|youtu\.be|tiktok\.com|instagram\.com\/p|reddit\.com\/r\/[^\/]+\/comments)\//i.test(
        url
      )
    ) {
      return true;
    }
    const cleanUrl = url.split("?")[0]?.toLowerCase() || "";
    if (/\.(png|jpe?g|webp|bmp|heic|svg|gif|gifv|mp4|webm|mov|mkv)$/i.test(cleanUrl)) {
      return true;
    }
  }

  return false;
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

  // 2. #media: Media only (images, videos, GIFs). Pure text chat is disallowed.
  if (message.channelId === MEDIA_CHANNEL_ID) {
    if (!hasMedia(message.content, attachments)) {
      try {
        await message.delete();
        const warning = await message.channel.send({
          content: `⚠️ <@${message.author.id}>, <#${MEDIA_CHANNEL_ID}> is for media only (photos, videos, GIFs). Please keep text chatting and discussions in <#${CHITCHAT_CHANNEL_ID}>!`,
        });
        setTimeout(() => {
          warning.delete().catch(() => {});
        }, 6000).unref?.();
        logger.info(
          { author: message.author.tag, channel: message.channelId },
          "AutoMod removed non-media message from #media"
        );
      } catch (err) {
        logger.warn({ err }, "Failed to auto-moderate media channel message");
      }
    }
    return;
  }
}
