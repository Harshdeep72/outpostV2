import cron from "node-cron";
import {
  type Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { sql } from "drizzle-orm";
import { db, serverConfig } from "@workspace/db";
import { setupGuild } from "./setup.js";
import { getPrimaryGuild } from "./discord-client.js";
import { makeEmbed, formatMoney } from "./util.js";
import { COLORS } from "./constants.js";
import { logger } from "../lib/logger.js";
import {
  fetchAndParseMasterSheet,
  getMasterSheetUrl,
  checkDateCampaignStatus,
} from "./handlers/sheetSync.js";

let started = false;
const notifiedDates = new Set<string>();

/**
 * Check the master Google Sheet for newly added dates that have not yet been posted to Discord.
 * If new tasks are detected, notifies staff in #task-logs with 1-click [🚀 Post Tasks Now] buttons.
 */
export async function checkMasterSheetForNewDrops(client: Client): Promise<void> {
  try {
    const guild = getPrimaryGuild();
    if (!guild) return;

    const sheetUrl = await getMasterSheetUrl(guild.id);
    const sections = await fetchAndParseMasterSheet(sheetUrl).catch((err) => {
      logger.debug({ err: err.message }, "Sheet drop watcher: fetch failed (silent)");
      return [];
    });

    if (sections.length === 0) return;

    // Pick latest date
    const latest = sections[sections.length - 1]!;
    if (notifiedDates.has(latest.date)) return;

    // Check if recorded as already synced in DB
    const cfg = await db.execute<{ last_synced_sheet_date: string | null }>(
      sql`SELECT last_synced_sheet_date FROM server_config WHERE guild_id = ${guild.id} LIMIT 1`
    );
    const lastSynced = cfg.rows[0]?.last_synced_sheet_date;
    if (lastSynced === latest.date) {
      notifiedDates.add(latest.date);
      return;
    }

    // Check if campaign was already posted
    const status = await checkDateCampaignStatus(
      latest.date,
      latest.tasks.map((t) => t.task_link)
    );
    if (status.isPosted) {
      notifiedDates.add(latest.date);
      return;
    }

    // New unposted date detected! Notify staff in #task-logs
    const { taskLogsChannel, adminRole } = await setupGuild(guild);

    const embed = makeEmbed(COLORS.PRIMARY)
      .setTitle(`🔔 New Tasks Detected in Master Sheet — ${latest.date}`)
      .setDescription(
        `A new daily batch of tasks has been added to the [Master Google Sheet](${sheetUrl}).\n\n` +
        `• **Date Section:** \`${latest.date}\`\n` +
        `• **Total Tasks:** **${latest.tasks.length}** Reddit tasks\n` +
        `• **Total Budget:** **${formatMoney(latest.budget)}**\n` +
        `• **Tab GID:** \`${latest.gid}\`\n\n` +
        `Click **🚀 Post Tasks Now** below to publish immediately, or **⏰ Schedule Drop** for an IST drop time.`
      )
      .setFooter({ text: "Auto-Watcher • Master Sheet Pipeline" })
      .setTimestamp();

    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`sheetsync:post:${latest.date}`)
        .setLabel("🚀 Post Tasks Now")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`sheetsync:schedule:${latest.date}`)
        .setLabel("⏰ Schedule Drop (IST)")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sheetsync:preview:${latest.date}`)
        .setLabel("🔍 View Tasks")
        .setStyle(ButtonStyle.Secondary)
    );

    await taskLogsChannel.send({
      content: adminRole ? `<@&${adminRole.id}>` : undefined,
      embeds: [embed],
      components: [buttons],
    });

    notifiedDates.add(latest.date);
    logger.info({ date: latest.date, tasks: latest.tasks.length }, "Notified staff of new tasks in master sheet");
  } catch (err: any) {
    logger.warn({ err: err.message }, "Error running master sheet drop watcher");
  }
}

/**
 * Start the background watcher cron (runs every 30 minutes).
 */
export function startSheetDropWatcher(client: Client): void {
  if (started) return;
  started = true;

  // Run every 30 minutes
  cron.schedule("*/30 * * * *", () => {
    checkMasterSheetForNewDrops(client).catch((err) => {
      logger.error({ err }, "Sheet drop watcher cron error");
    });
  });

  // Also do a gentle initial check 60 seconds after bot boot
  setTimeout(() => {
    checkMasterSheetForNewDrops(client).catch(() => {});
  }, 60_000);

  logger.info("Master Sheet Drop Watcher started (every 30m)");
}
