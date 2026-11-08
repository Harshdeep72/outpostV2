import {
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
} from "discord.js";
import { setupGuild } from "../setup.js";
import { makeEmbed, hasModRole } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";
import { createBulkTasksFromCsv, parseTaskCsv, type CreateBulkResult } from "../task-creation.js";
import { runCampaignLivenessCheck } from "../redditLivenessChecker.js";
import { db, campaigns, campaignQueue } from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";

function extractSheetId(url: string): { sheetId: string; gid: string } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("google.com")) return null;
    if (u.pathname.includes("/document/")) {
      throw Object.assign(new Error("GOOGLE_DOCS"), { isDoc: true });
    }
    const match = u.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return null;
    const sheetId = match[1]!;
    const gid = u.hash.match(/gid=(\d+)/)?.[1] ?? u.searchParams.get("gid") ?? "0";
    return { sheetId, gid };
  } catch (e: any) {
    if (e?.isDoc) throw e;
    return null;
  }
}

async function fetchSheetCsv(url: string): Promise<string> {
  let parsed: { sheetId: string; gid: string } | null;
  try {
    parsed = extractSheetId(url);
  } catch (e: any) {
    if (e?.isDoc) {
      throw new Error(
        "You provided a **Google Docs** link (a document), not a **Google Sheets** link (a spreadsheet).\n\n" +
        "To use `/bulktask`:\n" +
        "1. Open Google Sheets (sheets.google.com)\n" +
        "2. Create a spreadsheet with columns: `type, title, task_link, instructions, reward, slots`\n" +
        "3. Share it as **Anyone with link → Viewer**\n" +
        "4. Paste the Sheets URL here\n\n" +
        "Or skip the URL and use `/bulktask` without an argument to paste CSV directly."
      );
    }
    throw new Error("Invalid URL.");
  }

  if (!parsed) {
    throw new Error(
      "That doesn't look like a valid Google Sheets URL.\n\n" +
      "A valid URL looks like:\n`https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit`\n\n" +
      "Or use `/bulktask` without a URL to paste your CSV directly."
    );
  }

  const candidateUrls = [
    `https://docs.google.com/spreadsheets/d/${parsed.sheetId}/gviz/tq?tqx=out:csv&gid=${parsed.gid}`,
    `https://docs.google.com/spreadsheets/d/${parsed.sheetId}/gviz/tq?tqx=out:csv`,
    `https://docs.google.com/spreadsheets/d/${parsed.sheetId}/export?format=csv&gid=${parsed.gid}`,
    `https://docs.google.com/spreadsheets/d/${parsed.sheetId}/export?format=csv`,
  ];

  let lastStatus = 0;
  for (const candidate of candidateUrls) {
    try {
      const res = await fetch(candidate, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RedditMicrotasksBot/1.0" },
        signal: AbortSignal.timeout(15_000),
      });
      lastStatus = res.status;
      if (res.ok) {
        const text = await res.text();
        if (text && !text.trim().startsWith("<!DOCTYPE") && !text.trim().startsWith("<html")) {
          return text;
        }
      }
    } catch {
      // try next candidate endpoint
    }
  }

  if (lastStatus === 403 || lastStatus === 401) {
    throw new Error(
      "Google Sheets returned **Access Denied**.\n\nMake the sheet public:\n1. Click **Share** in Google Sheets\n2. Change to **Anyone with the link → Viewer**\n3. Try again."
    );
  }
  throw new Error(`Google Sheets returned HTTP ${lastStatus || 400}. Ensure the sheet is public (Anyone with the link → Viewer) and try again.`);
}

export function formatIstDate(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date) + " IST";
}

export function parseIstScheduleTime(input: string): { date: Date; formattedIst: string } | null {
  const str = input.trim();
  if (!str) return null;

  const nowUtc = new Date();
  const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
  // Current time represented in IST
  const nowIst = new Date(nowUtc.getTime() + IST_OFFSET_MS);

  function istToUtc(year: number, month: number, day: number, hour: number, min: number): Date {
    const d = new Date(Date.UTC(year, month, day, hour, min, 0, 0));
    return new Date(d.getTime() - IST_OFFSET_MS);
  }

  // 1. Relative: "in 15m", "in 2 hours", "in 45 mins", "in 1.5h"
  const relMatch = str.match(/^in\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/i);
  if (relMatch) {
    const val = parseFloat(relMatch[1]!);
    const unit = relMatch[2]!.toLowerCase();
    const isHour = unit.startsWith("h");
    const msToAdd = isHour ? val * 3600 * 1000 : val * 60 * 1000;
    const targetUtc = new Date(nowUtc.getTime() + msToAdd);
    return { date: targetUtc, formattedIst: formatIstDate(targetUtc) };
  }

  // 2. Day-prefixed or standalone time: "today HH:MM", "tomorrow HH:MM", "HH:MM", "HH:MM AM/PM"
  let dayOffset = 0;
  let remaining = str;

  if (/^today\s+/i.test(remaining)) {
    remaining = remaining.replace(/^today\s+/i, "");
  } else if (/^tomorrow\s+/i.test(remaining)) {
    dayOffset = 1;
    remaining = remaining.replace(/^tomorrow\s+/i, "");
  }

  const time12Match = remaining.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  const time24Match = remaining.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);

  if (time12Match || time24Match) {
    let hour = 0;
    let min = 0;

    if (time12Match) {
      let h = parseInt(time12Match[1]!, 10);
      min = time12Match[2] ? parseInt(time12Match[2], 10) : 0;
      const ampm = time12Match[3]!.toLowerCase();
      if (h < 1 || h > 12 || min < 0 || min > 59) return null;
      if (ampm === "pm" && h < 12) h += 12;
      if (ampm === "am" && h === 12) h = 0;
      hour = h;
    } else if (time24Match) {
      hour = parseInt(time24Match[1]!, 10);
      min = parseInt(time24Match[2]!, 10);
      if (hour < 0 || hour > 23 || min < 0 || min > 59) return null;
    }

    const curYear = nowIst.getUTCFullYear();
    const curMonth = nowIst.getUTCMonth();
    const curDate = nowIst.getUTCDate() + dayOffset;

    let targetUtc = istToUtc(curYear, curMonth, curDate, hour, min);

    // If day was not explicitly specified ("tomorrow" or "today" was not used) and target has passed today in IST:
    if (dayOffset === 0 && !/^today\s+/i.test(str) && targetUtc.getTime() <= nowUtc.getTime()) {
      targetUtc = istToUtc(curYear, curMonth, curDate + 1, hour, min);
    }

    return { date: targetUtc, formattedIst: formatIstDate(targetUtc) };
  }

  // 3. Full date-time: "YYYY-MM-DD HH:MM" or "YYYY-MM-DD HH:MM AM/PM"
  const fullMatch = remaining.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (fullMatch) {
    const y = parseInt(fullMatch[1]!, 10);
    const m = parseInt(fullMatch[2]!, 10) - 1;
    const d = parseInt(fullMatch[3]!, 10);
    let h = parseInt(fullMatch[4]!, 10);
    const min = parseInt(fullMatch[5]!, 10);
    const ampm = fullMatch[6]?.toLowerCase();
    if (ampm) {
      if (h < 1 || h > 12) return null;
      if (ampm === "pm" && h < 12) h += 12;
      if (ampm === "am" && h === 12) h = 0;
    }
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    const targetUtc = istToUtc(y, m, d, h, min);
    return { date: targetUtc, formattedIst: formatIstDate(targetUtc) };
  }

  return null;
}

export async function handleBulkTaskCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const member = interaction.member;
  if (!member || typeof member === "string" || !("roles" in member) || !hasModRole(member as any, guild)) {
    return interaction.reply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can create bulk tasks.")], flags: 64 });
  }

  const sheetsUrl = interaction.options.getString("sheets_url");
  const intervalMinutes = interaction.options.getInteger("interval_minutes") ?? 0;
  const maxClaimsPerUser = interaction.options.getInteger("max_claims_per_user") ?? 3;
  const scheduleTimeRaw = (
    interaction.options.getString("schedule_time_ist") ?? interaction.options.getString("time_ist")
  )?.trim();

  let scheduledStartAt: Date | null = null;
  let formattedIst: string | null = null;

  if (scheduleTimeRaw) {
    const parsed = parseIstScheduleTime(scheduleTimeRaw);
    if (!parsed || parsed.date.getTime() <= Date.now()) {
      return interaction.reply({
        embeds: [
          makeEmbed(COLORS.DANGER)
            .setTitle("❌ Invalid IST Schedule Time")
            .setDescription(
              `Could not parse or time is in the past: **\`${scheduleTimeRaw}\`**\n\n` +
              `**Valid Examples (all in IST, UTC+05:30):**\n` +
              `• \`19:30\` or \`7:30 PM\` — Drops today (or tomorrow if already passed)\n` +
              `• \`tomorrow 14:00\` or \`tomorrow 2:00 PM\` — Drops tomorrow\n` +
              `• \`in 30m\` or \`in 2 hours\` — Relative to current time\n` +
              `• \`2026-11-08 20:00\` — Specific date & 24h time`
            ),
        ],
        flags: 64,
      });
    }
    scheduledStartAt = parsed.date;
    formattedIst = parsed.formattedIst;
  }

  if (sheetsUrl) {
    await interaction.deferReply({ flags: 64 });
    await processBulkFromUrl(interaction, sheetsUrl, intervalMinutes, maxClaimsPerUser, scheduledStartAt, formattedIst);
  } else {
    const modal = new ModalBuilder()
      .setCustomId(`bulktask:csvmodal:${intervalMinutes}:${maxClaimsPerUser}`)
      .setTitle("Bulk Create Tasks (CSV Paste)");

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("csv_data")
          .setLabel("Paste CSV Data")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder("type,task_link,prewritten_comment,reward,slots,hold_hours")
          .setMaxLength(4000)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("campaign_title")
          .setLabel("Campaign Name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. Reddit Outreach")
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("interval_minutes")
          .setLabel("Drip Interval (seconds, 0 = all now)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(String(intervalMinutes))
          .setPlaceholder("0 = post all at once. e.g. 30 = every 30s, 300 = every 5 min")
          .setMaxLength(6)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("schedule_time_ist")
          .setLabel("Schedule Time (IST, blank = drop now)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(scheduleTimeRaw ?? "")
          .setPlaceholder("e.g. 19:30, 7:30 PM, tomorrow 14:00, in 2h")
          .setMaxLength(50)
      )
    );

    await interaction.showModal(modal);
  }
}

async function processBulkFromUrl(
  interaction: ChatInputCommandInteraction,
  sheetsUrl: string,
  intervalMinutes: number,
  maxClaimsPerUser: number = 3,
  scheduledStartAt: Date | null = null,
  formattedIst: string | null = null,
) {
  let csv: string;
  try {
    csv = await fetchSheetCsv(sheetsUrl);
  } catch (err: any) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ ${err.message}`)],
    });
  }

  try {
    parseTaskCsv(csv);
  } catch (err: any) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ CSV parse error: ${err.message}`)],
    });
  }

  const guild = interaction.guild!;
  await setupGuild(guild);

  const urlObj = new URL(sheetsUrl);
  const campaignTitle = `Sheet Import — ${urlObj.hostname}${urlObj.pathname.slice(0, 40)}`;

  let result;
  try {
    result = await createBulkTasksFromCsv({
      csv,
      campaignTitle,
      sourceType: "sheets",
      sourceUrl: sheetsUrl,
      creatorDiscordId: interaction.user.id,
      guild,
      intervalMinutes,
      maxClaimsPerUser,
      allowMultipleClaims: maxClaimsPerUser === 0 || maxClaimsPerUser > 1,
      scheduledStartAt,
      formattedIst,
    });
  } catch (err: any) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ ${err.message}`)],
    });
  }

  const embed = buildBulkResultEmbed(result, "Google Sheets", campaignTitle);
  await interaction.editReply({ embeds: [embed] });
  logger.info(
    { campaignId: result.campaignId, created: result.created, scheduled: result.scheduled, intervalMinutes: result.intervalMinutes, maxClaimsPerUser, errors: result.errors.length, scheduledStartAt },
    "Bulk import from Sheets complete",
  );

  runCampaignLivenessCheck(result.campaignId).catch((err) => {
    logger.warn({ err, campaignId: result.campaignId }, "Sheet-generation liveness check (bulktask): unhandled error");
  });
}

export async function handleBulkTaskCsvModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: 64 });

  const csvData = interaction.fields.getTextInputValue("csv_data");
  const campaignTitle = interaction.fields.getTextInputValue("campaign_title");

  const customIdParts = interaction.customId.split(":");
  const customIdInterval = Number(customIdParts[2] ?? "0");
  let intervalMinutes = Number.isFinite(customIdInterval) ? customIdInterval : 0;
  try {
    const fieldVal = interaction.fields.getTextInputValue("interval_minutes").trim();
    if (fieldVal) {
      const parsedSeconds = Number(fieldVal);
      if (Number.isFinite(parsedSeconds)) intervalMinutes = parsedSeconds / 60;
    }
  } catch { /* field not present in older modals */ }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0) intervalMinutes = 0;
  if (intervalMinutes > 1440) intervalMinutes = 1440;

  const customIdMax = Number(customIdParts[3] ?? "3");
  const maxClaimsPerUser = Number.isFinite(customIdMax) && customIdMax >= 0 ? Math.floor(customIdMax) : 3;

  let scheduledStartAt: Date | null = null;
  let formattedIst: string | null = null;
  try {
    const scheduleRaw = interaction.fields.getTextInputValue("schedule_time_ist").trim();
    if (scheduleRaw) {
      const parsed = parseIstScheduleTime(scheduleRaw);
      if (!parsed || parsed.date.getTime() <= Date.now()) {
        return interaction.editReply({
          embeds: [
            makeEmbed(COLORS.DANGER)
              .setTitle("❌ Invalid IST Schedule Time")
              .setDescription(
                `Could not parse or time is in the past: **\`${scheduleRaw}\`**\n\n` +
                `**Valid Examples (all in IST, UTC+05:30):**\n` +
                `• \`19:30\` or \`7:30 PM\` — Drops today (or tomorrow if already passed)\n` +
                `• \`tomorrow 14:00\` or \`tomorrow 2:00 PM\` — Drops tomorrow\n` +
                `• \`in 30m\` or \`in 2 hours\` — Relative to current time\n` +
                `• \`2026-11-08 20:00\` — Specific date & time`
              ),
          ],
        });
      }
      scheduledStartAt = parsed.date;
      formattedIst = parsed.formattedIst;
    }
  } catch { /* field not present in older modals */ }

  try {
    parseTaskCsv(csvData);
  } catch (err: any) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ CSV parse error: ${err.message}`)],
    });
  }

  const guild = interaction.guild!;
  await setupGuild(guild);

  let result;
  try {
    result = await createBulkTasksFromCsv({
      csv: csvData,
      campaignTitle,
      sourceType: "csv",
      sourceUrl: null,
      creatorDiscordId: interaction.user.id,
      guild,
      intervalMinutes,
      maxClaimsPerUser,
      allowMultipleClaims: maxClaimsPerUser === 0 || maxClaimsPerUser > 1,
      scheduledStartAt,
      formattedIst,
    });
  } catch (err: any) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ ${err.message}`)],
    });
  }

  const embed = buildBulkResultEmbed(result, "CSV Paste", campaignTitle);
  await interaction.editReply({ embeds: [embed] });
  logger.info(
    { campaignId: result.campaignId, created: result.created, scheduled: result.scheduled, intervalMinutes: result.intervalMinutes, maxClaimsPerUser, errors: result.errors.length, scheduledStartAt },
    "Bulk import from CSV paste complete",
  );
}

function buildBulkResultEmbed(
  result: CreateBulkResult,
  source: string,
  campaignTitle: string,
) {
  const ok = result.created > 0 || result.scheduled > 0;
  const isScheduled = !!(result.scheduledStartAt && result.scheduledStartAt.getTime() > Date.now());
  const embed = makeEmbed(ok ? COLORS.SUCCESS : COLORS.DANGER)
    .setTitle(isScheduled ? `⏰ Scheduled Campaign — Campaign #${result.campaignId}` : `📦 Bulk Task Import — Campaign #${result.campaignId}`)
    .setDescription(`**${campaignTitle}**`)
    .addFields(
      { name: "Source", value: source, inline: true },
      { name: "Rows Found", value: String(result.rowsFound), inline: true },
    );

  if (isScheduled) {
    const unixSec = Math.floor(result.scheduledStartAt!.getTime() / 1000);
    const istLabel = result.formattedIst || formatIstDate(result.scheduledStartAt!);
    embed.addFields(
      { name: "⏰ Scheduled Drop (IST)", value: `📅 **${istLabel}**\n⏳ <t:${unixSec}:F> (<t:${unixSec}:R>)`, inline: false },
      { name: "Tasks Queued", value: String(result.scheduled), inline: true },
    );

    if (result.intervalMinutes > 0) {
      const intervalSec = Math.round(result.intervalMinutes * 60);
      const lastDropSec = Math.round((result.scheduled - 1) * result.intervalMinutes * 60);
      embed.addFields(
        { name: "Mode", value: `Scheduled Drip-feed (${intervalSec}s apart)`, inline: true },
        {
          name: "Schedule",
          value: `First task drops at <t:${unixSec}:t>, remaining tasks drop every ${intervalSec}s (last at ~T+${lastDropSec}s).\n\n💡 *To cancel this drop before it starts, run:* \`/cancelscheduled campaign_id:${result.campaignId}\``,
          inline: false,
        },
      );
    } else {
      embed.addFields(
        { name: "Mode", value: "Scheduled Batch (All at once)", inline: true },
        {
          name: "Schedule",
          value: `All ${result.scheduled} tasks will drop simultaneously at <t:${unixSec}:t> (<t:${unixSec}:R>).\n\n💡 *To cancel this drop before it starts, run:* \`/cancelscheduled campaign_id:${result.campaignId}\``,
          inline: false,
        },
      );
    }
  } else if (result.intervalMinutes > 0) {
    const intervalSec = Math.round(result.intervalMinutes * 60);
    const lastDropSec = Math.round((result.scheduled - 1) * result.intervalMinutes * 60);
    embed.addFields(
      { name: "Mode", value: `Drip-feed every ${intervalSec}s`, inline: true },
      { name: "Tasks Queued", value: String(result.scheduled), inline: true },
      {
        name: "Schedule",
        value: result.scheduled > 0
          ? `First task drops within 15–30s, last drops at ~T+${lastDropSec}s.`
          : "Nothing queued (all rows had errors).",
        inline: false,
      },
    );
  } else {
    embed.addFields(
      { name: "Mode", value: "All-at-once", inline: true },
      { name: "Tasks Created", value: String(result.created), inline: true },
    );
  }

  if (result.errors.length > 0) {
    embed.addFields({ name: "⚠️ Errors", value: result.errors.slice(0, 5).join("\n").slice(0, 1000) });
  }
  return embed;
}

export async function handleListScheduledCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const member = interaction.member;
  if (!member || typeof member === "string" || !("roles" in member) || !hasModRole(member as any, guild)) {
    return interaction.reply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can view scheduled tasks.")], flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });

  const pendingRows = await db
    .select({
      id: campaignQueue.id,
      campaignId: campaignQueue.campaignId,
      scheduledAt: campaignQueue.scheduledAt,
      campaignTitle: campaigns.title,
      creatorDiscordId: campaigns.creatorDiscordId,
      intervalMinutes: campaigns.intervalMinutes,
      status: campaignQueue.status,
    })
    .from(campaignQueue)
    .innerJoin(campaigns, eq(campaignQueue.campaignId, campaigns.id))
    .where(and(eq(campaignQueue.guildId, guild.id), eq(campaignQueue.status, "pending")))
    .orderBy(asc(campaignQueue.scheduledAt));

  if (pendingRows.length === 0) {
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.PRIMARY)
          .setTitle("📅 Scheduled Task Drops")
          .setDescription("There are currently no scheduled campaigns or pending drip tasks in the queue.\n\nUse `/scheduletask` or `/bulktask` with `schedule_time_ist` to queue a drop!"),
      ],
    });
  }

  type CampaignGroup = {
    campaignId: number;
    title: string;
    creatorDiscordId: string;
    intervalMinutes: number;
    earliest: Date;
    latest: Date;
    count: number;
  };

  const groups = new Map<number, CampaignGroup>();
  for (const row of pendingRows) {
    const existing = groups.get(row.campaignId);
    if (!existing) {
      groups.set(row.campaignId, {
        campaignId: row.campaignId,
        title: row.campaignTitle,
        creatorDiscordId: row.creatorDiscordId,
        intervalMinutes: row.intervalMinutes ?? 0,
        earliest: row.scheduledAt,
        latest: row.scheduledAt,
        count: 1,
      });
    } else {
      existing.count++;
      if (row.scheduledAt < existing.earliest) existing.earliest = row.scheduledAt;
      if (row.scheduledAt > existing.latest) existing.latest = row.scheduledAt;
    }
  }

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle(`📅 Scheduled Campaigns (${groups.size} Active)`)
    .setDescription("The following campaigns are queued to drop automatically:\n");

  for (const g of groups.values()) {
    const startUnix = Math.floor(g.earliest.getTime() / 1000);
    const istStart = formatIstDate(g.earliest);
    const modeLabel = g.intervalMinutes > 0
      ? `Drip (${Math.round(g.intervalMinutes * 60)}s apart)`
      : `Batch (All at once)`;

    embed.addFields({
      name: `Campaign #${g.campaignId} — ${g.title}`,
      value:
        `• **Tasks Queued:** ${g.count}\n` +
        `• **Mode:** ${modeLabel}\n` +
        `• **Drops At (IST):** \`${istStart}\`\n` +
        `• **Countdown:** <t:${startUnix}:R> (<t:${startUnix}:f>)\n` +
        `• **Cancel Drop:** \`/cancelscheduled campaign_id:${g.campaignId}\``,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

export async function handleCancelScheduledCommand(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild!;
  const member = interaction.member;
  if (!member || typeof member === "string" || !("roles" in member) || !hasModRole(member as any, guild)) {
    return interaction.reply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can cancel scheduled tasks.")], flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });

  const campaignId = interaction.options.getInteger("campaign_id", true);
  const reason = interaction.options.getString("reason") ?? "Scheduled campaign cancelled by admin";

  const campaignRows = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  const campaign = campaignRows[0];
  if (!campaign) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Campaign #${campaignId} not found.`)],
    });
  }

  const cancelQueueRes = await db.execute<{ id: number }>(
    sql`UPDATE campaign_queue SET status = 'cancelled' WHERE campaign_id = ${campaignId} AND status = 'pending' RETURNING id`
  );

  const cancelledCount = cancelQueueRes.rowCount ?? 0;

  if (cancelledCount === 0) {
    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.WARNING)
          .setTitle("⚠️ No Pending Drops Found")
          .setDescription(`Campaign #${campaignId} has no pending scheduled tasks in the queue (they may have already been posted, or the campaign was already cancelled).`),
      ],
    });
  }

  await db.execute(
    sql`UPDATE campaigns SET status = 'cancelled' WHERE id = ${campaignId}`
  );

  logger.info({ campaignId, cancelledCount, reason, actor: interaction.user.id }, "Scheduled campaign cancelled");

  return interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle(`🚫 Scheduled Campaign #${campaignId} Cancelled`)
        .setDescription(
          `Successfully cancelled **${cancelledCount}** pending scheduled tasks for campaign **"${campaign.title}"**.\n\n` +
          `**Reason:** ${reason}\n\n` +
          `None of these tasks will be posted.`
        ),
    ],
  });
}
