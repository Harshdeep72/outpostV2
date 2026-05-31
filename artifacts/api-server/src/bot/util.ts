import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Guild,
} from "discord.js";
import { COLORS, PAYOUT_DAY_UTC, ROLES } from "./constants.js";

export const SMOKY_TAG = "⚡ coded by SKYY";

export function formatMoney(val: string | number | null | undefined): string {
  const n = typeof val === "string" ? parseFloat(val) : (val ?? 0);
  return `$${(n || 0).toFixed(2)}`;
}

export function makeEmbed(color: number = COLORS.PRIMARY): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: SMOKY_TAG });
}

export function smokyFooterText(extra?: string): string {
  if (!extra) return SMOKY_TAG;
  return `${extra} • ${SMOKY_TAG}`;
}

export function ephemeralError(msg: string): Parameters<ChatInputCommandInteraction["reply"]>[0] {
  return { embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ ${msg}`)], flags: 64 };
}

export function ephemeralSuccess(msg: string): Parameters<ChatInputCommandInteraction["reply"]>[0] {
  return { embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ ${msg}`)], flags: 64 };
}

export function getISOWeekStart(d: Date = new Date()): Date {
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  return monday;
}

export function nextPayoutDate(now: Date = new Date()): Date {
  const day = now.getUTCDay();
  if (day === PAYOUT_DAY_UTC) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const daysUntil = (PAYOUT_DAY_UTC - day + 7) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntil));
}

export function hasModRole(member: GuildMember, guild: Guild): boolean {
  const modRole = guild.roles.cache.find((r) => r.name === ROLES.MOD);
  const adminRole = guild.roles.cache.find((r) => r.name === ROLES.ADMIN);
  return !!(
    (modRole && member.roles.cache.has(modRole.id)) ||
    (adminRole && member.roles.cache.has(adminRole.id)) ||
    member.permissions.has("Administrator")
  );
}

export function hasAdminRole(member: GuildMember, guild: Guild): boolean {
  const adminRole = guild.roles.cache.find((r) => r.name === ROLES.ADMIN);
  return !!(
    (adminRole && member.roles.cache.has(adminRole.id)) ||
    member.permissions.has("Administrator")
  );
}

export function hasVerifiedRole(member: GuildMember, guild: Guild): boolean {
  const verifiedRole = guild.roles.cache.find((r) => r.name === ROLES.VERIFIED);
  return !!(verifiedRole && member.roles.cache.has(verifiedRole.id));
}

export function trustBadge(score: number): string {
  if (score >= 150) return "🏆 Elite";
  if (score >= 100) return "✨ Trusted";
  if (score >= 60) return "👍 Reliable";
  if (score >= 30) return "⚠️ Caution";
  return "🚫 Low Trust";
}

export function sanitizeUsername(username: string): string {
  return username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

export function medalFor(pos: number): string {
  if (pos === 1) return "🥇";
  if (pos === 2) return "🥈";
  if (pos === 3) return "🥉";
  return `\`#${String(pos).padStart(2, "0")}\``;
}

export function stripIconImgQuery(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}
