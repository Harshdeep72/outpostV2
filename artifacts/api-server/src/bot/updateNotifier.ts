import { type Client, type Guild, EmbedBuilder } from "discord.js";
import { db } from "@workspace/db";
import { serverConfig } from "@workspace/db";
import { eq } from "drizzle-orm";
import { setupGuild } from "./setup.js";
import { COLORS } from "./constants.js";
import { logger } from "../lib/logger.js";
import { SQL } from "drizzle-orm";

import changelogMarkdown from "../../../../CHANGELOG.md";

export interface ChangelogEntry {
  version: string;       // e.g. "1.2.0"
  rawHeading: string;    // e.g. "v1.2.0 — 2026-05-01 — Reddit liveness tracking"
  date: string | null;   // e.g. "2026-05-01"
  title: string | null;  // e.g. "Reddit liveness tracking"
  bodyMarkdown: string;  // everything between this heading and the next "## v…"
}

const VERSION_HEADING_RE = /^##\s+v(\d+\.\d+\.\d+(?:[\w.-]*)?)(?:\s+[—-]\s+(\d{4}-\d{2}-\d{2}))?(?:\s+[—-]\s+(.+))?\s*$/;

/**
 * Parse the bundled CHANGELOG.md into ordered entries (newest first, mirroring file order).
 * Robust to extra whitespace and missing date/title segments.
 */
export function parseChangelog(md: string): ChangelogEntry[] {
  const lines = md.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];
  let current: { version: string; rawHeading: string; date: string | null; title: string | null; body: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    entries.push({
      version: current.version,
      rawHeading: current.rawHeading,
      date: current.date,
      title: current.title,
      bodyMarkdown: current.body.join("\n").trim(),
    });
    current = null;
  };

  for (const line of lines) {
    const m = VERSION_HEADING_RE.exec(line);
    if (m) {
      flush();
      current = {
        version: m[1]!,
        rawHeading: line.replace(/^##\s+/, "").trim(),
        date: m[2] ?? null,
        title: m[3]?.trim() ?? null,
        body: [],
      };
      continue;
    }
    // Stop body collection at horizontal rules so the leading preamble bullets don't bleed in.
    if (current && /^---+\s*$/.test(line)) continue;
    if (current) current.body.push(line);
  }
  flush();
  return entries;
}

/**
 * Compare two semver-ish strings ("1.2.10" vs "1.2.9"). Returns positive if a > b, negative if a < b, 0 if equal.
 * Handles missing third segment and non-numeric suffixes by falling back to natural compare on the suffix.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(/[.-]/);
  const partsB = b.split(/[.-]/);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const sa = partsA[i] ?? "0";
    const sb = partsB[i] ?? "0";
    const na = Number.parseInt(sa, 10);
    const nb = Number.parseInt(sb, 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else {
      const cmp = sa.localeCompare(sb);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/** Truncate a long markdown body to fit within Discord's embed description limit (4096). */
function truncateForEmbed(body: string, max = 3800): string {
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n");
  return (lastBreak > max * 0.6 ? cut.slice(0, lastBreak) : cut) + "\n\n…(truncated, see CHANGELOG.md for the rest)";
}

function buildEmbed(entry: ChangelogEntry): EmbedBuilder {
  const titleParts = [`v${entry.version}`];
  if (entry.title) titleParts.push(entry.title);
  return new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setTitle(`📦 Update — ${titleParts.join(" — ")}`)
    .setDescription(truncateForEmbed(entry.bodyMarkdown || "_(no patch notes provided)_"))
    .setFooter({ text: `Outpost Bot • ${entry.date ?? "Patch notes"}` })
    .setTimestamp();
}

/**
 * For a single guild, post any changelog entries that are newer than what we have on record.
 * Safe to call multiple times — entries already announced for that guild are skipped.
 */
async function notifyGuildOfUpdates(guild: Guild, entries: ChangelogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  // Sort entries oldest-first so the channel reads top-to-bottom in chronological order.
  const oldestFirst = [...entries].sort((a, b) => compareVersions(a.version, b.version));
  const latestVersion = oldestFirst[oldestFirst.length - 1]!.version;

  let existing;
  try {
    existing = await db
      .select()
      .from(serverConfig)
      .where(eq(serverConfig.guildId, guild.id))
      .limit(1);
  } catch (err) {
    logger.warn({ err, guildId: guild.id }, "Update notifier: server_config missing, skipping until schema exists");
    return;
  }
  const lastSeen = existing[0]?.lastChangelogVersion ?? null;

  // First-ever boot for this guild: don't dump full history, just record the latest version
  // so future updates start posting from there.
  if (!lastSeen) {
    if (existing.length === 0) {
      await db.insert(serverConfig).values({ guildId: guild.id, lastChangelogVersion: latestVersion });
    } else {
      await db.update(serverConfig).set({ lastChangelogVersion: latestVersion, updatedAt: new Date() }).where(eq(serverConfig.guildId, guild.id));
    }
    logger.info({ guildId: guild.id, latestVersion }, "Update notifier: baseline recorded for new guild");
    return;
  }

  const newEntries = oldestFirst.filter((e) => compareVersions(e.version, lastSeen) > 0);
  if (newEntries.length === 0) return;

  let setup;
  try {
    setup = await setupGuild(guild);
  } catch (err) {
    logger.warn({ err, guildId: guild.id }, "Update notifier: setupGuild failed, skipping this tick");
    return;
  }

  let postedAny = false;
  for (const entry of newEntries) {
    try {
      // Ping @everyone alongside the embed so members get a notification
      // for new patch notes. allowedMentions is set explicitly so the ping
      // actually fires (Discord requires opt-in for @everyone).
      await setup.updatesChannel.send({
        content: "@everyone",
        embeds: [buildEmbed(entry)],
        allowedMentions: { parse: ["everyone"] },
      });
      postedAny = true;
      // Brief pause to avoid Discord rate limits when several versions land at once.
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      logger.error({ err, guildId: guild.id, version: entry.version }, "Update notifier: failed to post embed");
    }
  }

  if (postedAny) {
    await db
      .update(serverConfig)
      .set({ lastChangelogVersion: latestVersion, updatedAt: new Date() })
      .where(eq(serverConfig.guildId, guild.id));
    logger.info(
      { guildId: guild.id, posted: newEntries.map((e) => e.version), newLatest: latestVersion },
      "Update notifier: posted patch notes"
    );
  }
}

let didRunOnBoot = false;

export async function runUpdateNotifierOnBoot(client: Client): Promise<void> {
  if (didRunOnBoot) return;
  didRunOnBoot = true;

  let entries: ChangelogEntry[];
  try {
    entries = parseChangelog(changelogMarkdown);
  } catch (err) {
    logger.error({ err }, "Update notifier: failed to parse CHANGELOG.md");
    return;
  }

  if (entries.length === 0) {
    logger.warn("Update notifier: CHANGELOG.md parsed to zero entries, nothing to post");
    return;
  }

  logger.info({ count: entries.length, latest: entries[0]?.version }, "Update notifier: changelog loaded");

  for (const guild of client.guilds.cache.values()) {
    try {
      await notifyGuildOfUpdates(guild, entries);
    } catch (err) {
      logger.error({ err, guildId: guild.id }, "Update notifier: per-guild error");
    }
  }
}
