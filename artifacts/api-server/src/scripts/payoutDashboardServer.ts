import express from "express";
import http from "http";
import { Client, GatewayIntentBits } from "discord.js";
import { startDbWarmer } from "@workspace/db";
import { setDiscordClient } from "../bot/discord-client.js";
import { logger } from "../lib/logger.js";
import payoutsRouter from "../routes/payouts.js";

const PORT = process.env.PAYOUT_DASHBOARD_PORT || 3333;
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

const app = express();
app.use(express.json());
app.use("/", payoutsRouter);

async function start() {
  startDbWarmer(15000);
  console.log("Connecting Discord client for Payout Station...");
  await discordClient.login(token);
  setDiscordClient(discordClient);
  console.log(`Discord logged in as ${discordClient.user?.tag}`);

  const server = http.createServer(app);
  server.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`\n======================================================`);
    console.log(`🚀 MULTI-METHOD PAYOUT STATION LIVE!`);
    console.log(`• Local URL:      http://localhost:${PORT}`);
    console.log(`======================================================\n`);
  });
}

start().catch(err => {
  logger.error({ err }, "Payout station failed to start");
  process.exit(1);
});
