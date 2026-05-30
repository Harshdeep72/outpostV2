import type { ChatInputCommandInteraction } from "discord.js";
import { measureDbLatency } from "@workspace/db";
import { makeEmbed, hasAdminRole, smokyFooterText } from "../util.js";
import { COLORS } from "../constants.js";
import { getProxyMetrics, proxyFetchJson } from "../proxy.js";
import { getAllCacheStats } from "../cache.js";
import { logger } from "../../lib/logger.js";

const startedAt = Date.now();

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export async function handleHealthCommand(interaction: ChatInputCommandInteraction) {
  const member = interaction.member;
  if (!member || typeof member === "string" || !("roles" in member)) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Could not verify your roles.")],
      flags: 64,
    });
  }
  if (!hasAdminRole(member as any, interaction.guild!)) {
    return interaction.reply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ This command is admin-only.")],
      flags: 64,
    });
  }

  await interaction.deferReply({ flags: 64 });

  const dbLatency = await measureDbLatency().catch(() => -1);

  // Live Reddit API probe (cheap)
  const probeStart = Date.now();
  let redditStatus = "❓ unknown";
  try {
    const res = await proxyFetchJson(
      ["https://www.reddit.com/r/announcements/about.json?raw_json=1"],
      { timeoutMs: 6_000 }
    );
    const ms = Date.now() - probeStart;
    redditStatus = res.ok
      ? `✅ healthy (${ms}ms via ${res.via})`
      : `⚠️ HTTP ${res.status} (${ms}ms via ${res.via})`;
  } catch (err) {
    logger.warn({ err }, "/health Reddit probe failed");
    redditStatus = `❌ unreachable (${Date.now() - probeStart}ms)`;
  }

  const m = getProxyMetrics();
  const wsPing = interaction.client.ws.ping;
  const cache = getAllCacheStats();
  const totalCacheEntries = Object.values(cache).reduce((sum, s) => sum + s.size, 0);
  const totalHits = Object.values(cache).reduce((sum, s) => sum + s.hits, 0);
  const totalMisses = Object.values(cache).reduce((sum, s) => sum + s.misses, 0);
  const overallHitRate = totalHits + totalMisses === 0
    ? 0
    : Math.round((totalHits / (totalHits + totalMisses)) * 100);

  const dbStr = dbLatency < 0 ? "🔴 down" : `${dbLatency < 50 ? "⚡" : dbLatency < 200 ? "🟢" : "🟡"} ${dbLatency}ms`;
  const wsStr = wsPing < 0 ? "🔴 down" : `${wsPing < 100 ? "⚡" : wsPing < 250 ? "🟢" : "🟡"} ${wsPing}ms`;

  const fmtChannel = (label: string, c: { total: number; successes: number; successRate: number; avgLatencyMs: number }) => {
    if (c.total === 0) return `${label}: _no probes yet_`;
    const emoji = c.successRate >= 0.9 ? "🟢" : c.successRate >= 0.7 ? "🟡" : "🔴";
    return `${label}: ${emoji} ${(c.successRate * 100).toFixed(0)}% (${c.successes}/${c.total}) · avg ${c.avgLatencyMs}ms`;
  };
  const proxyLine = `**${m.proxyCount}** proxies loaded\n${fmtChannel("Proxy", m.proxy)}\n${fmtChannel("Direct fallback", m.direct)}`;

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle("🩺 Outpost Bot — Deep Health Check")
    .addFields(
      { name: "🌐 Discord WS", value: wsStr, inline: true },
      { name: "🗄️ Database", value: dbStr, inline: true },
      { name: "⏱️ Uptime", value: formatUptime(Date.now() - startedAt), inline: true },
      { name: "🛡️ Proxy Pool", value: proxyLine },
      { name: "📡 Reddit API", value: redditStatus },
      { name: "📦 Cache", value: `${totalCacheEntries} entries · ${overallHitRate}% hit rate (${totalHits} hits / ${totalMisses} misses)` },
    )
    .setFooter({ text: smokyFooterText(`Proxy metrics window: last ${m.windowSize} attempts per channel`) });

  await interaction.editReply({ embeds: [embed] });
}
