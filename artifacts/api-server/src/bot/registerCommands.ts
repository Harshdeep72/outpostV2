import { REST, Routes } from "discord.js";
import { getCommandBuilders } from "./commands/index.js";
import { logger } from "../lib/logger.js";

// Commands that are safe to run in the bot's DMs (no guild/member dependency).
// Registered as GLOBAL commands so they appear in DMs as well as the guild.
// Inside the guild, the guild-scoped registration below takes precedence, so
// guild behavior is unchanged.
const DM_PUBLIC_COMMANDS = new Set([
  "digest", "referral", "referraluse",
  "setupi", "setpaypal", "setwallet",
  "wallet", "profile", "ping", "stats", "mystatus",
]);

export async function registerCommands(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN!;
  const clientId = process.env.DISCORD_CLIENT_ID!;
  const guildId = process.env.DISCORD_GUILD_ID!;

  const rest = new REST({ version: "10" }).setToken(token);
  const builders = getCommandBuilders();
  const body = builders.map((b) => b.toJSON());

  const guildBody = body.filter((c) => !DM_PUBLIC_COMMANDS.has(c.name));

  logger.info({ count: guildBody.length }, "Registering slash commands (guild scope)");
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: guildBody });
  logger.info("Slash commands registered (guild scope)");

  // Also publish the DM-safe subset globally so they work in bot DMs and in all guilds.
  // By excluding these from the guild-scoped array above, we prevent Discord from showing duplicate commands in the UI.
  const globalBody = body.filter((c) => DM_PUBLIC_COMMANDS.has(c.name));
  try {
    logger.info({ count: globalBody.length }, "Registering DM-safe slash commands (global scope)");
    await rest.put(Routes.applicationCommands(clientId), { body: globalBody });
    logger.info("DM-safe slash commands registered (global scope)");
  } catch (err) {
    // Best-effort: if global registration fails, the bot still works in the guild.
    logger.warn({ err }, "Global slash command registration failed — DM commands may be unavailable");
  }
}
