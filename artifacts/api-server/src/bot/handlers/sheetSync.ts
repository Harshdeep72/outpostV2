import {
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  type Guild,
  type TextChannel,
} from "discord.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, campaigns, serverConfig, tasks } from "@workspace/db";
import { setupGuild } from "../setup.js";
import { makeEmbed, formatMoney, hasModRole } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";
import { createBulkTasksFromCsv } from "../task-creation.js";
import { parseIstScheduleTime, formatIstDate } from "./bulktask.js";

export const DEFAULT_MASTER_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1-xyVOJH3jPOXMdpEWPeExuelSpgvG23KLaatc9oyCNw/edit?usp=sharing";

export interface ParsedSheetTask {
  type: string;
  task_link: string;
  prewritten_comment: string;
  reward: number;
  slots: number;
  hold_hours: number;
}

export interface ParsedSheetDateSection {
  date: string;
  tasks: ParsedSheetTask[];
  budget: number;
  totalSlots: number;
  gid: string;
  csvText: string;
}

/**
 * Resolve master Google Sheet URL from DB or fallback constant.
 */
export async function getMasterSheetUrl(guildId?: string): Promise<string> {
  if (guildId) {
    try {
      const rows = await db
        .select({ masterSheetUrl: serverConfig.masterSheetUrl })
        .from(serverConfig)
        .where(eq(serverConfig.guildId, guildId))
        .limit(1);
      if (rows[0]?.masterSheetUrl?.trim()) {
        return rows[0].masterSheetUrl.trim();
      }
    } catch (err) {
      logger.debug({ err, guildId }, "Could not load masterSheetUrl from server_config");
    }
  }
  return process.env.MASTER_SHEET_URL?.trim() || DEFAULT_MASTER_SHEET_URL;
}

/**
 * Extract sheet ID and optional GID from Google Sheets URL.
 */
export function extractGoogleSheetId(url: string): { sheetId: string; gid: string } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("google.com")) return null;
    const match = u.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return null;
    const sheetId = match[1]!;
    const gid = u.hash.match(/gid=(\d+)/)?.[1] ?? u.searchParams.get("gid") ?? "0";
    return { sheetId, gid };
  } catch {
    return null;
  }
}

/**
 * Fetch and discover all tab GIDs and parsed daily date sections from master Google Sheet.
 */
export async function fetchAndParseMasterSheet(sheetUrl: string): Promise<ParsedSheetDateSection[]> {
  const parsedUrl = extractGoogleSheetId(sheetUrl);
  if (!parsedUrl) {
    throw new Error("Invalid Google Sheets link. Please provide a valid docs.google.com/spreadsheets/d/... URL.");
  }

  const { sheetId, gid: initialGid } = parsedUrl;

  // 1. Fetch htmlview to find all tab GIDs in order
  let discoveredGids: string[] = [];
  try {
    const htmlRes = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RedditMicrotasksBot/1.0" },
      signal: AbortSignal.timeout(8_000),
    });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const matches = [...html.matchAll(/gid=([0-9]+)/g)].map((m) => m[1]!);
      discoveredGids = [...new Set(matches)];
    }
  } catch (err) {
    logger.debug({ err, sheetId }, "Could not inspect htmlview for gids, using initialGid");
  }

  if (discoveredGids.length === 0) {
    discoveredGids = [initialGid];
  } else if (!discoveredGids.includes(initialGid)) {
    discoveredGids.unshift(initialGid);
  }

  const dateBannerRegex = /(?:Date\s+)?(\d{1,2}[\.\-\/]\d{1,2}[\.\-\/]\d{2,4})/i;
  const redditUrlRegex = /https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/[^\s"]+/i;

  const dateSectionMap = new Map<string, { tasks: ParsedSheetTask[]; gid: string }>();

  // Fetch from newest tab (last in discoveredGids) to oldest
  const gidsToFetch = [...discoveredGids].reverse();

  for (const gid of gidsToFetch) {
    const candidateUrls = [
      `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
      `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
    ];

    let csvText: string | null = null;
    for (const cUrl of candidateUrls) {
      try {
        const res = await fetch(cUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RedditMicrotasksBot/1.0" },
          signal: AbortSignal.timeout(12_000),
        });
        if (res.ok) {
          const t = await res.text();
          if (t && !t.trim().startsWith("<!DOCTYPE") && !t.trim().startsWith("<html")) {
            csvText = t;
            break;
          }
        }
      } catch {
        // try next candidate
      }
    }

    if (!csvText) continue;

    // Parse CSV rows into lines
    const lines = parseDelimitedLines(csvText);
    let curDate: string | null = null;

    for (const row of lines) {
      // Check for date banner in cells
      let rowDate: string | null = null;
      for (const cell of row) {
        const m = cell.match(/(?:Date\s+)(\d{1,2}[\.\-\/]\d{1,2}[\.\-\/]\d{2,4})/i) ||
          (!redditUrlRegex.test(cell) ? cell.match(dateBannerRegex) : null);
        if (m) {
          rowDate = m[1]!;
          break;
        }
      }

      if (rowDate) {
        curDate = rowDate;
        if (!dateSectionMap.has(curDate)) {
          dateSectionMap.set(curDate, { tasks: [], gid });
        }
      }

      // Find Reddit task link in row
      let link = "";
      let linkIdx = -1;
      for (let i = 0; i < row.length; i++) {
        const m = row[i]?.match(redditUrlRegex);
        if (m) {
          link = m[0];
          linkIdx = i;
          break;
        }
      }

      if (!link) continue;

      let comment = "";
      if (linkIdx !== -1 && linkIdx + 1 < row.length && !redditUrlRegex.test(row[linkIdx + 1] ?? "")) {
        comment = (row[linkIdx + 1] ?? "").trim();
      } else if (row[2] && !redditUrlRegex.test(row[2])) {
        comment = row[2].trim();
      }

      // Strip wrapping quotes if any
      if (comment.startsWith('"') && comment.endsWith('"') && comment.length >= 2) {
        comment = comment.slice(1, -1).trim();
      }

      const targetDate = curDate ?? "General";
      if (!dateSectionMap.has(targetDate)) {
        dateSectionMap.set(targetDate, { tasks: [], gid });
      }

      // Avoid adding duplicate links within the same date section
      const sec = dateSectionMap.get(targetDate)!;
      if (!sec.tasks.some((t) => t.task_link.toLowerCase() === link.toLowerCase())) {
        sec.tasks.push({
          type: "comment",
          task_link: link,
          prewritten_comment: comment,
          reward: 1.0,
          slots: 1,
          hold_hours: 24,
        });
      }
    }
  }

  // Parse DD.MM.YYYY dates for chronological sorting
  function parseDateToTime(dStr: string): number {
    const parts = dStr.split(/[\.\-\/]/);
    if (parts.length === 3) {
      const day = parseInt(parts[0]!, 10);
      const month = parseInt(parts[1]!, 10) - 1;
      let year = parseInt(parts[2]!, 10);
      if (year < 100) year += 2000;
      return new Date(year, month, day).getTime();
    }
    return 0;
  }

  const results: ParsedSheetDateSection[] = [];
  for (const [date, val] of dateSectionMap.entries()) {
    if (val.tasks.length === 0) continue;

    const totalSlots = val.tasks.reduce((sum, t) => sum + t.slots, 0);
    const budget = val.tasks.reduce((sum, t) => sum + t.reward * t.slots, 0);

    // Build standard CSV representation for task creation
    const escapeCsv = (str: string) => {
      if (!str) return '""';
      if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    const header = "type,task_link,prewritten_comment,reward,slots,hold_hours";
    const csvRows = [header];
    for (const t of val.tasks) {
      csvRows.push(`${t.type},${t.task_link},${escapeCsv(t.prewritten_comment)},${t.reward.toFixed(2)},${t.slots},${t.hold_hours}`);
    }

    results.push({
      date,
      tasks: val.tasks,
      budget,
      totalSlots,
      gid: val.gid,
      csvText: csvRows.join("\n"),
    });
  }

  // Sort chronologically ascending (oldest first, newest last)
  results.sort((a, b) => parseDateToTime(a.date) - parseDateToTime(b.date));

  return results;
}

/**
 * Robust CSV/TSV parser handling escaped quotes and newlines.
 */
function parseDelimitedLines(text: string): string[][] {
  const lines: string[][] = [];
  let curRow: string[] = [];
  let curCell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        curCell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      curRow.push(curCell.trim());
      curCell = "";
    } else if ((char === "\r" || char === "\n") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i++;
      curRow.push(curCell.trim());
      if (curRow.some((c) => c.length > 0)) {
        lines.push(curRow);
      }
      curRow = [];
      curCell = "";
    } else {
      curCell += char;
    }
  }

  if (curCell.length > 0 || curRow.length > 0) {
    curRow.push(curCell.trim());
    if (curRow.some((c) => c.length > 0)) {
      lines.push(curRow);
    }
  }

  return lines;
}

/**
 * Check if tasks for this date have already been posted into campaigns or tasks table.
 */
export async function checkDateCampaignStatus(
  date: string,
  taskLinks: string[]
): Promise<{ isPosted: boolean; campaignId?: number; campaignTitle?: string; tasksCount?: number }> {
  try {
    // 1. Check campaigns title match
    const campMatch = await db.execute<{ id: number; title: string; total_tasks: number }>(
      sql`SELECT id, title, total_tasks FROM campaigns
          WHERE title ILIKE ${`%${date}%`}
          ORDER BY id DESC LIMIT 1`
    );
    if (campMatch.rows.length > 0 && campMatch.rows[0]) {
      return {
        isPosted: true,
        campaignId: campMatch.rows[0].id,
        campaignTitle: campMatch.rows[0].title,
        tasksCount: Number(campMatch.rows[0].total_tasks || 0),
      };
    }

    // 2. Cross check task links in tasks table if any
    if (taskLinks.length > 0) {
      const topLinks = taskLinks.slice(0, 10);
      const linkMatch = await db.execute<{ count: string; campaign_id: number | null }>(
        sql`SELECT COUNT(*) as count, MAX(campaign_id) as campaign_id
            FROM tasks
            WHERE task_link = ANY(${topLinks}::text[])`
      );
      const count = Number(linkMatch.rows[0]?.count || 0);
      if (count >= 3) {
        return {
          isPosted: true,
          campaignId: linkMatch.rows[0]?.campaign_id ?? undefined,
          campaignTitle: `Campaign #${linkMatch.rows[0]?.campaign_id ?? "unknown"}`,
          tasksCount: count,
        };
      }
    }
  } catch (err) {
    logger.debug({ err, date }, "Error checking date campaign status");
  }

  return { isPosted: false };
}

/**
 * Build rich Discord embed and components for /syncsheet preview.
 */
export async function buildSheetSyncEmbed(
  selectedSection: ParsedSheetDateSection,
  allSections: ParsedSheetDateSection[],
  sheetUrl: string,
  status: { isPosted: boolean; campaignId?: number; campaignTitle?: string },
  opts?: { intervalMinutes?: number; maxClaimsPerUser?: number }
): Promise<{ embed: EmbedBuilder; components: ActionRowBuilder<any>[] }> {
  const isLatest = selectedSection.date === allSections[allSections.length - 1]?.date;
  const intervalMinutes = opts?.intervalMinutes ?? 0;
  const maxClaims = opts?.maxClaimsPerUser ?? 3;

  const embed = makeEmbed(status.isPosted ? COLORS.MUTED : COLORS.PRIMARY)
    .setTitle(`⚡ Master Sheet Sync — ${selectedSection.date}${isLatest ? " [Latest]" : ""}`)
    .setDescription(
      `Auto-ingested daily task batch directly from master sheet:\n` +
      `[**Open Master Spreadsheet**](${sheetUrl})\n\n` +
      (status.isPosted
        ? `⚠️ **Already Posted:** This date appears to have already been posted (${status.campaignTitle || `Campaign #${status.campaignId}`}).`
        : `🟢 **Ready to Drop:** Click **🚀 Post Tasks Now** or **⏰ Schedule Drop** below.`)
    )
    .addFields(
      {
        name: "📅 Target Date",
        value: `\`${selectedSection.date}\`${isLatest ? " ⭐ **(Latest in Sheet)**" : ""}`,
        inline: true,
      },
      {
        name: "📋 Tasks Found",
        value: `**${selectedSection.tasks.length}** Reddit tasks`,
        inline: true,
      },
      {
        name: "💰 Campaign Budget",
        value: `**${formatMoney(selectedSection.budget)}** ($1.00 · 1 slot · 24h)`,
        inline: true,
      },
      {
        name: "⚙️ Drop Settings",
        value: `• Drip Interval: **${intervalMinutes === 0 ? "Instant (all at once)" : `${intervalMinutes}m between tasks`}**\n` +
               `• Max Claims / Worker: **${maxClaims} tasks** (scales with linked accounts)\n` +
               `• Hold Verification: **24 hours**`,
        inline: false,
      }
    );

  // List recent dates in sheet
  const recentSections = [...allSections].reverse().slice(0, 6);
  const dateListLines = recentSections.map((s) => {
    const isThis = s.date === selectedSection.date;
    return `${isThis ? "👉 " : "• "}\`${s.date}\`: **${s.tasks.length}** tasks${s.date === allSections[allSections.length - 1]?.date ? " *(latest)*" : ""}`;
  });

  embed.addFields({
    name: `📑 Available Dates in Sheet (${allSections.length})`,
    value: dateListLines.join("\n"),
    inline: false,
  });

  embed.setFooter({ text: `Tab GID: ${selectedSection.gid} • Reddit Microtasks Flash Edition` });

  // Buttons Row
  const buttonsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`sheetsync:post:${selectedSection.date}`)
      .setLabel(status.isPosted ? "Repost Tasks Now" : "🚀 Post Tasks Now")
      .setStyle(status.isPosted ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`sheetsync:schedule:${selectedSection.date}`)
      .setLabel("⏰ Schedule Drop (IST)")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`sheetsync:preview:${selectedSection.date}`)
      .setLabel("🔍 View Task List")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sheetsync:refresh:${selectedSection.date}`)
      .setLabel("🔄 Refresh")
      .setStyle(ButtonStyle.Secondary)
  );

  const components: ActionRowBuilder<any>[] = [buttonsRow];

  // If there are multiple dates, add a Date StringSelectMenu
  if (allSections.length > 1) {
    const options = recentSections.map((s) => ({
      label: `Date ${s.date} (${s.tasks.length} tasks)`,
      description: s.date === allSections[allSections.length - 1]?.date ? "Latest date added in sheet" : `Tab GID ${s.gid}`,
      value: s.date,
      default: s.date === selectedSection.date,
    }));

    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("sheetsync:select")
        .setPlaceholder(`Switch date section (currently ${selectedSection.date})`)
        .addOptions(options)
    );
    components.push(selectRow);
  }

  return { embed, components };
}

/**
 * Handle /syncsheet and /dropsheet commands.
 */
export async function handleSyncSheetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const member = interaction.member;
  if (!member || typeof member === "string" || !("roles" in member) || !hasModRole(member as any, guild)) {
    await interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can sync or drop sheet tasks.")],
      flags: 64,
    });
    return;
  }

  await interaction.deferReply({ flags: 64 });

  const customUrl = interaction.options.getString("sheet_url")?.trim();
  const targetDateInput = interaction.options.getString("date")?.trim();
  const action = interaction.options.getString("action") ?? "preview";
  const scheduleTimeRaw = (
    interaction.options.getString("schedule_time_ist") ?? interaction.options.getString("time_ist")
  )?.trim();
  const intervalMinutes = interaction.options.getInteger("interval_minutes") ?? 0;
  const maxClaimsPerUser = interaction.options.getInteger("max_claims_per_user") ?? 3;

  const sheetUrl = customUrl || (await getMasterSheetUrl(guild.id));

  let sections: ParsedSheetDateSection[];
  try {
    sections = await fetchAndParseMasterSheet(sheetUrl);
  } catch (err: any) {
    await interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Failed fetching Google Sheet:\n${err.message}`)],
    });
    return;
  }

  if (sections.length === 0) {
    await interaction.editReply({
      embeds: [
        makeEmbed(COLORS.WARNING).setDescription(
          `⚠️ No Reddit tasks found in [Google Sheet](${sheetUrl}).\n\nEnsure rows contain Reddit post URLs and the sheet is public (Anyone with link → Viewer).`
        ),
      ],
    });
    return;
  }

  // Find target section or pick latest
  let selected = sections[sections.length - 1]!;
  if (targetDateInput) {
    const norm = targetDateInput.toLowerCase().replace(/[\-\/]/g, ".");
    const found = sections.find((s) => s.date.toLowerCase().replace(/[\-\/]/g, ".") === norm);
    if (!found) {
      await interaction.editReply({
        embeds: [
          makeEmbed(COLORS.DANGER).setDescription(
            `❌ Date \`${targetDateInput}\` not found in sheet.\n\n**Available Dates:**\n${sections.map((s) => `• \`${s.date}\``).join("\n")}`
          ),
        ],
      });
      return;
    }
    selected = found;
  }

  const links = selected.tasks.map((t) => t.task_link);
  const status = await checkDateCampaignStatus(selected.date, links);

  // If user requested direct post_now
  if (action === "post_now") {
    await executeSheetDropPost({
      interaction,
      guild,
      section: selected,
      sheetUrl,
      intervalMinutes,
      maxClaimsPerUser,
      scheduledStartAt: null,
      formattedIst: null,
    });
    return;
  }

  // If user requested direct schedule
  if (action === "schedule" && scheduleTimeRaw) {
    const parsedIst = parseIstScheduleTime(scheduleTimeRaw);
    if (!parsedIst || parsedIst.date.getTime() <= Date.now()) {
      await interaction.editReply({
        embeds: [
          makeEmbed(COLORS.DANGER).setDescription(
            `❌ Invalid or past IST schedule time: **\`${scheduleTimeRaw}\`**.\n\nExamples: \`19:30\`, \`7:30 PM\`, \`tomorrow 14:00\`, \`in 2h\`.`
          ),
        ],
      });
      return;
    }

    await executeSheetDropPost({
      interaction,
      guild,
      section: selected,
      sheetUrl,
      intervalMinutes,
      maxClaimsPerUser,
      scheduledStartAt: parsedIst.date,
      formattedIst: parsedIst.formattedIst,
    });
    return;
  }

  const { embed, components } = await buildSheetSyncEmbed(selected, sections, sheetUrl, status, {
    intervalMinutes,
    maxClaimsPerUser,
  });

  await interaction.editReply({ embeds: [embed], components });
}

/**
 * Handle button interactions for sheet sync (sheetsync:post:*, sheetsync:schedule:*, etc.).
 */
export async function handleSheetSyncButton(interaction: ButtonInteraction, action: string, date: string): Promise<void> {
  const guild = interaction.guild!;
  const member = interaction.member;
  if (!member || typeof member === "string" || !("roles" in member) || !hasModRole(member as any, guild)) {
    await interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can trigger sheet drops.")],
      flags: 64,
    });
    return;
  }

  const sheetUrl = await getMasterSheetUrl(guild.id);

  if (action === "preview") {
    await interaction.deferReply({ flags: 64 });
    const sections = await fetchAndParseMasterSheet(sheetUrl).catch(() => []);
    const section = sections.find((s) => s.date === date);
    if (!section) {
      await interaction.editReply({ content: `❌ Could not find tasks for date \`${date}\` in sheet.` });
      return;
    }

    const previewLines = section.tasks.slice(0, 15).map((t, i) => {
      const commentSnippet = t.prewritten_comment ? `\n> *"${t.prewritten_comment.slice(0, 80)}..."*` : "";
      return `**${i + 1}.** [${t.task_link.split("/comments/")[1]?.split("/")[0] ?? "Reddit Post"}](${t.task_link})${commentSnippet}`;
    });

    const embed = makeEmbed(COLORS.PRIMARY)
      .setTitle(`📋 Task Preview — Date ${section.date} (${section.tasks.length} Total Tasks)`)
      .setDescription(previewLines.join("\n\n") + (section.tasks.length > 15 ? `\n\n*...and ${section.tasks.length - 15} more tasks.*` : ""))
      .setFooter({ text: "All tasks are verified comments with $1.00 reward and 24h hold." });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (action === "schedule") {
    const modal = new ModalBuilder()
      .setCustomId(`sheetsync:schedmodal:${date}`)
      .setTitle(`Schedule Drop — ${date}`);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("time_ist")
          .setLabel("Drop Time (in IST, UTC+05:30)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. 19:30, 7:30 PM, tomorrow 14:00, in 2h")
          .setMaxLength(50)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("interval_minutes")
          .setLabel("Drip Interval (minutes, 0 = all at once)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue("0")
          .setMaxLength(5)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("max_claims")
          .setLabel("Max Claims Per Worker")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue("3")
          .setMaxLength(3)
      )
    );

    await interaction.showModal(modal);
    return;
  }

  if (action === "refresh") {
    await interaction.deferUpdate();
    const sections = await fetchAndParseMasterSheet(sheetUrl).catch(() => []);
    const section = sections.find((s) => s.date === date) || sections[sections.length - 1];
    if (section) {
      const status = await checkDateCampaignStatus(section.date, section.tasks.map((t) => t.task_link));
      const { embed, components } = await buildSheetSyncEmbed(section, sections, sheetUrl, status);
      await interaction.editReply({ embeds: [embed], components });
    }
    return;
  }

  if (action === "post") {
    await interaction.deferUpdate();
    const sections = await fetchAndParseMasterSheet(sheetUrl).catch(() => []);
    const section = sections.find((s) => s.date === date);
    if (!section) {
      await interaction.followUp({ content: `❌ Date \`${date}\` not found in sheet.`, flags: 64 });
      return;
    }

    await executeSheetDropPost({
      interaction,
      guild,
      section,
      sheetUrl,
      intervalMinutes: 0,
      maxClaimsPerUser: 3,
      scheduledStartAt: null,
      formattedIst: null,
    });
  }
}

/**
 * Handle date switch via StringSelectMenu.
 */
export async function handleSheetSyncSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const date = interaction.values[0]!;
  await interaction.deferUpdate();

  const sheetUrl = await getMasterSheetUrl(interaction.guildId ?? undefined);
  const sections = await fetchAndParseMasterSheet(sheetUrl).catch(() => []);
  const section = sections.find((s) => s.date === date);
  if (!section) return;

  const status = await checkDateCampaignStatus(section.date, section.tasks.map((t) => t.task_link));
  const { embed, components } = await buildSheetSyncEmbed(section, sections, sheetUrl, status);
  await interaction.editReply({ embeds: [embed], components });
}

/**
 * Handle scheduling modal submit.
 */
export async function handleSheetSyncScheduleModal(interaction: ModalSubmitInteraction, date: string): Promise<void> {
  const guild = interaction.guild!;
  await interaction.deferReply({ flags: 64 });

  const timeIstRaw = interaction.fields.getTextInputValue("time_ist").trim();
  const intervalStr = interaction.fields.getTextInputValue("interval_minutes")?.trim() || "0";
  const maxClaimsStr = interaction.fields.getTextInputValue("max_claims")?.trim() || "3";

  const parsedIst = parseIstScheduleTime(timeIstRaw);
  if (!parsedIst || parsedIst.date.getTime() <= Date.now()) {
    await interaction.editReply({
      embeds: [
        makeEmbed(COLORS.DANGER).setDescription(
          `❌ Could not parse or past time: **\`${timeIstRaw}\`**.\n\nValid examples: \`19:30\`, \`7:30 PM\`, \`tomorrow 14:00\`, \`in 45m\`.`
        ),
      ],
    });
    return;
  }

  const intervalMinutes = Math.max(0, parseInt(intervalStr, 10) || 0);
  const maxClaimsPerUser = Math.max(1, parseInt(maxClaimsStr, 10) || 3);

  const sheetUrl = await getMasterSheetUrl(guild.id);
  const sections = await fetchAndParseMasterSheet(sheetUrl).catch(() => []);
  const section = sections.find((s) => s.date === date);
  if (!section) {
    await interaction.editReply({ content: `❌ Date \`${date}\` not found in sheet.` });
    return;
  }

  await executeSheetDropPost({
    interaction,
    guild,
    section,
    sheetUrl,
    intervalMinutes,
    maxClaimsPerUser,
    scheduledStartAt: parsedIst.date,
    formattedIst: parsedIst.formattedIst,
  });
}

/**
 * Core executor for creating or scheduling bulk tasks from a sheet section.
 */
async function executeSheetDropPost(params: {
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction;
  guild: Guild;
  section: ParsedSheetDateSection;
  sheetUrl: string;
  intervalMinutes: number;
  maxClaimsPerUser: number;
  scheduledStartAt: Date | null;
  formattedIst: string | null;
}): Promise<void> {
  const { interaction, guild, section, sheetUrl, intervalMinutes, maxClaimsPerUser, scheduledStartAt, formattedIst } = params;

  const campaignTitle = `Daily Drop — ${section.date} (${section.tasks.length} Tasks)`;

  let result;
  try {
    result = await createBulkTasksFromCsv({
      csv: section.csvText,
      targetDate: section.date,
      campaignTitle,
      sourceType: "sheets",
      sourceUrl: `${sheetUrl}#gid=${section.gid}`,
      creatorDiscordId: interaction.user.id,
      guild,
      intervalMinutes,
      maxClaimsPerUser,
      allowMultipleClaims: maxClaimsPerUser > 1,
      scheduledStartAt,
      formattedIst,
    });
  } catch (err: any) {
    const errorEmbed = makeEmbed(COLORS.DANGER)
      .setTitle("❌ Sheet Drop Failed")
      .setDescription(`Could not create campaign:\n${err.message}`);

    if (interaction.isButton()) {
      await interaction.followUp({ embeds: [errorEmbed], flags: 64 });
    } else {
      await interaction.editReply({ embeds: [errorEmbed], components: [] });
    }
    return;
  }

  const { tasksChannel } = await setupGuild(guild);
  const isScheduled = !!scheduledStartAt;

  const successEmbed = makeEmbed(COLORS.SUCCESS)
    .setTitle(isScheduled ? `⏰ Daily Drop Scheduled — ${section.date}` : `🚀 Daily Drop Live — ${section.date}`)
    .setDescription(
      isScheduled
        ? `Campaign **#${result.campaignId}** has been scheduled for drop!\n\n` +
          `• **Drop Time (IST):** \`${formattedIst}\` (<t:${Math.floor(scheduledStartAt!.getTime() / 1000)}:R>)\n` +
          `• **Total Tasks:** ${result.scheduled || result.rowsFound}\n` +
          `• **Budget:** ${formatMoney(section.budget)}\n` +
          `• **Target Channel:** <#${tasksChannel.id}>\n\n` +
          `The queue processor will automatically publish the tasks at the scheduled time.`
        : `Successfully published **${result.created} tasks** directly from Google Sheets!\n\n` +
          `• **Campaign ID:** #${result.campaignId}\n` +
          `• **Total Slots:** ${section.totalSlots}\n` +
          `• **Total Budget:** ${formatMoney(section.budget)}\n` +
          `• **Tasks Channel:** <#${tasksChannel.id}>\n\n` +
          `Tasks are now open for claiming by verified workers!`
    )
    .setFooter({ text: `Synced from Master Sheet • Date: ${section.date}` })
    .setTimestamp();

  if (interaction.isButton()) {
    await interaction.editReply({ embeds: [successEmbed], components: [] }).catch(async () => {
      await interaction.followUp({ embeds: [successEmbed] });
    });
  } else {
    await interaction.editReply({ embeds: [successEmbed], components: [] });
  }

  // Record last synced date in server_config
  await db.execute(
    sql`UPDATE server_config SET last_synced_sheet_date = ${section.date}, updated_at = NOW() WHERE guild_id = ${guild.id}`
  ).catch(() => {});
}

/**
 * Handle /setmastersheet command.
 */
export async function handleSetMasterSheetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const member = interaction.member;
  if (!member || typeof member === "string" || !("roles" in member) || !hasModRole(member as any, guild)) {
    await interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins can set the master sheet URL.")],
      flags: 64,
    });
    return;
  }

  const newUrl = interaction.options.getString("url", true).trim();
  const parsed = extractGoogleSheetId(newUrl);
  if (!parsed) {
    await interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Invalid Google Sheets link. It must be a valid docs.google.com/spreadsheets/d/... URL.")],
      flags: 64,
    });
    return;
  }

  await db.execute(
    sql`INSERT INTO server_config (guild_id, master_sheet_url, updated_at)
        VALUES (${guild.id}, ${newUrl}, NOW())
        ON CONFLICT (guild_id) DO UPDATE SET master_sheet_url = ${newUrl}, updated_at = NOW()`
  );

  await interaction.reply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ Master Sheet URL Updated")
        .setDescription(`The default Google Sheets URL for this server is now:\n[${newUrl}](${newUrl})\n\nWhenever staff runs \`/syncsheet\` or drops new tasks, this sheet will be read automatically.`),
    ],
    flags: 64,
  });
}
