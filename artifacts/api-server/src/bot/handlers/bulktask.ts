import {
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
} from "discord.js";
import { setupGuild } from "../setup.js";
import { makeEmbed } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";
import { createBulkTasksFromCsv, parseTaskCsv } from "../task-creation.js";

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

  const csvUrl = `https://docs.google.com/spreadsheets/d/${parsed.sheetId}/export?format=csv&gid=${parsed.gid}`;
  const res = await fetch(csvUrl, {
    headers: { "User-Agent": "OutpostBot/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(
        "Google Sheets returned **Access Denied**.\n\nMake the sheet public:\n1. Click **Share** in Google Sheets\n2. Change to **Anyone with the link → Viewer**\n3. Try again."
      );
    }
    throw new Error(`Google Sheets returned HTTP ${res.status}. Ensure the sheet is public and try again.`);
  }
  return res.text();
}

export async function handleBulkTaskCommand(interaction: ChatInputCommandInteraction) {
  const sheetsUrl = interaction.options.getString("sheets_url");
  const intervalMinutes = interaction.options.getInteger("interval_minutes") ?? 0;
  const maxClaimsPerUser = interaction.options.getInteger("max_claims_per_user") ?? 1;

  if (sheetsUrl) {
    await interaction.deferReply({ flags: 64 });
    await processBulkFromUrl(interaction, sheetsUrl, intervalMinutes, maxClaimsPerUser);
  } else {
    const modal = new ModalBuilder()
      .setCustomId(`bulktask:csvmodal:${intervalMinutes}:${maxClaimsPerUser}`)
      .setTitle("Bulk Create Tasks (CSV Paste)");

    // NOTE: Discord caps modal `placeholder` at 100 chars. The previous
    // multi-line example was ~160 chars and Discord rejected the whole
    // modal silently — that's why `/bulktask` looked broken.
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("csv_data")
          .setLabel("Paste CSV (header: type,title,task_link…)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder("type,title,task_link,instructions,reward,slots")
          .setMaxLength(4000)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("campaign_title")
          .setLabel("Campaign Name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder("e.g. April Twitter Push")
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("interval_minutes")
          .setLabel("Drip interval (seconds, e.g. 60 = 1 min, 0 = all at once)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue(String(intervalMinutes))
          .setPlaceholder("0 = post all at once. e.g. 30 = every 30s, 300 = every 5 min")
          .setMaxLength(6)
      )
    );

    await interaction.showModal(modal);
  }
}

async function processBulkFromUrl(
  interaction: ChatInputCommandInteraction,
  sheetsUrl: string,
  intervalMinutes: number,
  maxClaimsPerUser: number = 1,
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
    });
  } catch (err: any) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ ${err.message}`)],
    });
  }

  const embed = buildBulkResultEmbed(result, "Google Sheets", campaignTitle);
  await interaction.editReply({ embeds: [embed] });
  logger.info(
    { campaignId: result.campaignId, created: result.created, scheduled: result.scheduled, intervalMinutes: result.intervalMinutes, maxClaimsPerUser, errors: result.errors.length },
    "Bulk import from Sheets complete",
  );
}

export async function handleBulkTaskCsvModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: 64 });

  const csvData = interaction.fields.getTextInputValue("csv_data");
  const campaignTitle = interaction.fields.getTextInputValue("campaign_title");

  // Interval and maxClaimsPerUser come from the slash-option defaults baked into the customId.
  // customId format: bulktask:csvmodal:<intervalMinutes>:<maxClaimsPerUser>
  const customIdParts = interaction.customId.split(":");
  const customIdInterval = Number(customIdParts[2] ?? "0");
  let intervalMinutes = Number.isFinite(customIdInterval) ? customIdInterval : 0;
  try {
    const fieldVal = interaction.fields.getTextInputValue("interval_minutes").trim();
    if (fieldVal) {
      const parsedSeconds = Number(fieldVal);
      // Field now accepts seconds — convert to fractional minutes for the pipeline.
      if (Number.isFinite(parsedSeconds)) intervalMinutes = parsedSeconds / 60;
    }
  } catch { /* field not present in older modals */ }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 0) intervalMinutes = 0;
  if (intervalMinutes > 1440) intervalMinutes = 1440;
  // No Math.floor — allow fractional minutes (sub-minute drip intervals).

  const customIdMax = Number(customIdParts[3] ?? "1");
  const maxClaimsPerUser = Number.isFinite(customIdMax) && customIdMax >= 0 ? Math.floor(customIdMax) : 1;

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
    });
  } catch (err: any) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ ${err.message}`)],
    });
  }

  const embed = buildBulkResultEmbed(result, "CSV Paste", campaignTitle);
  await interaction.editReply({ embeds: [embed] });
  logger.info(
    { campaignId: result.campaignId, created: result.created, scheduled: result.scheduled, intervalMinutes: result.intervalMinutes, maxClaimsPerUser, errors: result.errors.length },
    "Bulk import from CSV paste complete",
  );
}

function buildBulkResultEmbed(
  result: { campaignId: number; rowsFound: number; created: number; scheduled: number; intervalMinutes: number; errors: string[] },
  source: string,
  campaignTitle: string,
) {
  const ok = result.created > 0 || result.scheduled > 0;
  const embed = makeEmbed(ok ? COLORS.SUCCESS : COLORS.DANGER)
    .setTitle(`📦 Bulk Task Import — Campaign #${result.campaignId}`)
    .setDescription(`**${campaignTitle}**`)
    .addFields(
      { name: "Source", value: source, inline: true },
      { name: "Rows Found", value: String(result.rowsFound), inline: true },
    );

  if (result.intervalMinutes > 0) {
    const totalSec = Math.round(result.scheduled * result.intervalMinutes * 60);
    const intervalSec = Math.round(result.intervalMinutes * 60);
    const lastDropSec = Math.round((result.scheduled - 1) * result.intervalMinutes * 60);
    embed.addFields(
      { name: "Mode", value: `Drip-feed every ${intervalSec}s`, inline: true },
      { name: "Tasks Queued", value: String(result.scheduled), inline: true },
      {
        name: "Schedule",
        value: result.scheduled > 0
          ? `First task drops within 30s, last drops at ~T+${lastDropSec}s.`
          : "Nothing queued (all rows had errors).",
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
