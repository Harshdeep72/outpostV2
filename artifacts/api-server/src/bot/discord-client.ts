import type { Client, Guild } from "discord.js";

let _client: Client | null = null;

export function setDiscordClient(client: Client) {
  _client = client;
}

export function getDiscordClient(): Client | null {
  return _client;
}

/**
 * Returns the primary guild the bot is in. Prefers DISCORD_GUILD_ID when set,
 * otherwise falls back to the first guild in the cache. Returns null if the
 * bot isn't ready or isn't in any guild.
 */
export function getPrimaryGuild(): Guild | null {
  if (!_client?.isReady()) return null;
  const guildId = process.env.DISCORD_GUILD_ID;
  if (guildId) {
    const g = _client.guilds.cache.get(guildId);
    if (g) return g;
  }
  return _client.guilds.cache.first() ?? null;
}
