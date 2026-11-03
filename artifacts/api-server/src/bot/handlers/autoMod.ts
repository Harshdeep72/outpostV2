import {
  type Message,
  type OmitPartialGroupDMChannel,
  PermissionFlagsBits,
} from "discord.js";
import { logger } from "../../lib/logger.js";
import { hasAdminRole, hasModRole } from "../util.js";

// #chitchat channel ID where media/images are disallowed
export const CHITCHAT_CHANNEL_ID = "1565314111372394583";
// #media channel ID where users should post photos/media
export const MEDIA_CHANNEL_ID = "1567226854778208318";

export function isForbiddenMedia(
  content: string,
  attachments: { contentType?: string | null; name?: string | null }[] = []
): boolean {
  // Check attachments
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
    // If it's a known GIF provider, allow it
    if (/https?:\/\/(www\.)?(tenor\.com|giphy\.com|klipy\.com|gfycat\.com)\//i.test(url)) {
      continue;
    }
    // If it ends with .gif or .gifv, allow it
    const cleanUrl = url.split("?")[0]?.toLowerCase() || "";
    if (cleanUrl.endsWith(".gif") || cleanUrl.endsWith(".gifv")) {
      continue;
    }
    // If it points to an image extension, forbid it
    if (/\.(png|jpe?g|webp|bmp|heic|svg)$/i.test(cleanUrl)) {
      return true;
    }
  }
  return false;
}

export async function handleAutoModMessage(
  message: Message | OmitPartialGroupDMChannel<Message>
): Promise<void> {
  if (message.channelId !== CHITCHAT_CHANNEL_ID) return;
  if (message.author.bot) return;

  // Bypass for server administrators and moderators
  if (message.member) {
    if (
      message.member.permissions.has(PermissionFlagsBits.Administrator) ||
      message.member.permissions.has(PermissionFlagsBits.ManageMessages) ||
      hasAdminRole(message.member) ||
      hasModRole(message.member)
    ) {
      return;
    }
  }

  const attachments = Array.from(message.attachments.values());
  if (isForbiddenMedia(message.content, attachments)) {
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
}
