import {
  type ChatInputCommandInteraction,
} from "discord.js";
import { measureDbLatency } from "@workspace/db";
import { makeEmbed, smokyFooterText } from "../util.js";
import { COLORS } from "../constants.js";
import { getProxyCount } from "../proxy.js";
import { getAllCacheStats } from "../cache.js";

const startedAt = Date.now();

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export async function handlePingCommand(interaction: ChatInputCommandInteraction) {
  const replyStart = Date.now();
  // Public — visible to everyone in the channel.
  await interaction.deferReply();
  const replyTime = Date.now() - replyStart;

  const [dbLatency] = await Promise.all([measureDbLatency()]);

  const wsPing = interaction.client.ws.ping;
  const proxies = getProxyCount();
  const uptime = formatUptime(Date.now() - startedAt);
  const stats = getAllCacheStats();

  const dbStr = dbLatency < 0 ? "❌ down" : `${dbLatency}ms`;
  const dbEmoji = dbLatency < 0 ? "🔴" : dbLatency < 50 ? "⚡" : dbLatency < 200 ? "🟢" : "🟡";
  const wsEmoji = wsPing < 0 ? "🔴" : wsPing < 100 ? "⚡" : wsPing < 250 ? "🟢" : "🟡";

  const cacheLines = Object.entries(stats)
    .filter(([, s]) => s.size > 0 || s.hits > 0 || s.misses > 0)
    .map(([name, s]) => `\`${name}\` — ${s.size} entries · ${s.hitRate}% hits`)
    .join("\n") || "_No cache activity yet_";

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle("⚡ Outpost Bot — Pong!")
    .setDescription(`**v2 Flash Edition** is running.`)
    .addFields(
      { name: "🌐 Discord WS", value: `${wsEmoji} ${wsPing}ms`, inline: true },
      { name: "🗄️ Database", value: `${dbEmoji} ${dbStr}`, inline: true },
      { name: "📡 Reply Defer", value: `⚡ ${replyTime}ms`, inline: true },
      { name: "🛡️ Proxies", value: proxies > 0 ? `✅ ${proxies} active` : "⚠️ none — direct mode", inline: true },
      { name: "⏱️ Uptime", value: uptime, inline: true },
      { name: "🚀 Mode", value: "Flash Edition", inline: true },
      { name: "📦 Cache", value: cacheLines },
    )
    .setFooter({ text: smokyFooterText("Built for speed") });

  await interaction.editReply({ embeds: [embed] });
}
