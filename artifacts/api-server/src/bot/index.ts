import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
} from "discord.js";
import { startDbWarmer } from "@workspace/db";
import { registerCommands } from "./registerCommands.js";
import { registerInteractionHandler } from "./interactions.js";
import { startPendingProcessor } from "./pendingProcessor.js";
import { startClaimExpirer } from "./claimExpirer.js";
import { startDailyDigest } from "./dailyDigestSender.js";
import { startAutoBumper } from "./autoBumper.js";
import { startUnclaimedNotifier } from "./unclaimedNotifier.js";
import { startExpiryReminder } from "./expiryReminder.js";
import { ensureEarnerRoles } from "./earnerRoles.js";
import { startRedditLivenessChecker } from "./redditLivenessChecker.js";
import { startPendingReviewSweeper } from "./pendingReviewSweeper.js";
import { startSubmissionRetention } from "./submissionRetention.js";
import { startCampaignQueueProcessor } from "./campaignQueueProcessor.js";
import { runUpdateNotifierOnBoot } from "./updateNotifier.js";
import { refreshLeaderboard, checkAndRolloverWeek } from "./handlers/leaderboard.js";
import { runWeeklyPayouts } from "./handlers/weeklyPayouts.js";
import { startProxyAutoReload, getProxyCount } from "./proxy.js";
import { startCacheSweeper } from "./cache.js";
import { setDiscordClient } from "./discord-client.js";
import { logger } from "../lib/logger.js";

let schedulersStarted = false;

export async function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN!;

  startProxyAutoReload();
  startDbWarmer();
  startCacheSweeper();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel],
  });

  setDiscordClient(client);

  client.on("error", (err) => logger.error({ err }, "Discord client error"));
  client.on("warn", (msg) => logger.warn({ msg }, "Discord client warn"));
  client.on("shardError", (err, shardId) => logger.error({ err, shardId }, "Shard error"));
  client.on("shardDisconnect", (ev, id) => logger.warn({ ev, id }, "Shard disconnected"));
  client.on("shardReconnecting", (id) => logger.info({ id }, "Shard reconnecting"));
  client.on("shardResume", (id, replayed) => logger.info({ id, replayed }, "Shard resumed"));

  client.once("ready", async () => {
    logger.info({ tag: client.user?.tag, proxies: getProxyCount() }, "Discord bot ready (v2 Flash Edition)");

    const presences = [
      { name: "⚡ v2 Flash | by smoky", type: ActivityType.Playing },
      { name: "/ping for live stats", type: ActivityType.Watching },
      { name: "tasks fly by ⚡", type: ActivityType.Watching },
      { name: "your earnings grow 💰", type: ActivityType.Watching },
    ];
    let presenceIdx = 0;
    const rotatePresence = () => {
      try {
        const p = presences[presenceIdx % presences.length]!;
        client.user?.setPresence({
          activities: [{ name: p.name, type: p.type }],
          status: "online",
        });
        presenceIdx++;
      } catch (err) {
        logger.warn({ err }, "Failed to set presence");
      }
    };
    rotatePresence();
    setInterval(rotatePresence, 60_000).unref();

    try {
      await registerCommands();
    } catch (err) {
      logger.error({ err }, "Failed to register commands");
    }

    if (!schedulersStarted) {
      schedulersStarted = true;
      startPendingProcessor(client);
      startClaimExpirer(client);
      startExpiryReminder(client);
      startDailyDigest(client);
      startAutoBumper(client);
      startUnclaimedNotifier(client);

      // Auto-create earner-tier roles in every guild on boot (idempotent).
      for (const guild of client.guilds.cache.values()) {
        ensureEarnerRoles(guild).catch((err) =>
          logger.warn({ err, guildId: guild.id }, "ensureEarnerRoles failed on boot")
        );
      }
      startRedditLivenessChecker(client);
      // Re-checks pending manual-review submissions after 24h: if the Reddit
      // post is live by then → auto-accept; if still removed/deleted → auto-reject
      // (no trust penalty). Skips non-Reddit URLs (Twitter/Quora always manual).
      startPendingReviewSweeper(client);
      startCampaignQueueProcessor(client);
      // Daily cleanup: deletes submissions > 22 days old after mirroring each
      // to its Google Sheet (cost control for Neon). Sheet is the long-term
      // archive. See submissionRetention.ts for the safety design.
      startSubmissionRetention();

      setInterval(async () => {
        for (const guild of client.guilds.cache.values()) {
          try {
            await checkAndRolloverWeek(guild);
            await refreshLeaderboard(guild);
          } catch (err) {
            logger.error({ err, guildId: guild.id }, "Leaderboard scheduler error");
          }
        }
      }, 5 * 60 * 1000);

      setInterval(async () => {
        for (const guild of client.guilds.cache.values()) {
          try {
            await runWeeklyPayouts(guild);
          } catch (err) {
            logger.error({ err, guildId: guild.id }, "Weekly payout scheduler error");
          }
        }
      }, 60 * 60 * 1000);

      // Initial warm-up: refresh leaderboard once for each guild so the snapshot cache
      // is hot before the first user runs /leaderboard.
      for (const guild of client.guilds.cache.values()) {
        try {
          await checkAndRolloverWeek(guild);
          await refreshLeaderboard(guild);
        } catch (err) {
          logger.error({ err, guildId: guild.id }, "Initial leaderboard refresh error");
        }
      }

      // Post any new patch notes to each guild's #updates channel. Safe to call repeatedly —
      // already-announced versions are skipped via server_config.last_changelog_version.
      runUpdateNotifierOnBoot(client).catch((err) =>
        logger.error({ err }, "Update notifier failed on boot")
      );
    }
  });

  registerInteractionHandler(client);

  let delay = 5000;
  while (true) {
    try {
      await client.login(token);
      break;
    } catch (err) {
      logger.error({ err, delay }, "Discord login failed — retrying");
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5 * 60 * 1000);
    }
  }
}
