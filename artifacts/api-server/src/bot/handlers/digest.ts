import { type ChatInputCommandInteraction } from "discord.js";
import { pool } from "@workspace/db";
import { makeEmbed } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";

/**
 * /digest — toggle (or check) opt-in for the once-a-day DM summary.
 * Subcommands: `on`, `off`, `status`.
 */
export async function handleDigestCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });
  const sub = interaction.options.getSubcommand(true);
  const discordId = interaction.user.id;

  try {
    if (sub === "on" || sub === "off") {
      const optin = sub === "on";
      const r = await pool.query(
        `UPDATE users SET daily_digest_optin = $1 WHERE discord_id = $2 RETURNING discord_id`,
        [optin, discordId],
      );
      if (r.rowCount === 0) {
        return interaction.editReply({
          embeds: [makeEmbed(COLORS.WARNING).setDescription(
            "⚠️ You need to interact with the bot first (try `/profile` or `/wallet`) so we know who you are.",
          )],
        });
      }
      logger.info({ discordId, optin }, "Daily digest opt-in toggled");
      return interaction.editReply({
        embeds: [makeEmbed(optin ? COLORS.SUCCESS : COLORS.PRIMARY).setDescription(
          optin
            ? "✅ You're opted in. We'll DM you a once-a-day summary of your earnings + new tasks. Use `/digest off` any time to stop."
            : "📴 Daily digest disabled. Use `/digest on` to re-enable.",
        )],
      });
    }

    // status
    const r = await pool.query(
      `SELECT daily_digest_optin, daily_digest_last_sent_at FROM users WHERE discord_id = $1`,
      [discordId],
    );
    const row = r.rows[0];
    const optin = !!row?.daily_digest_optin;
    const last = row?.daily_digest_last_sent_at as Date | null;
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.PRIMARY)
        .setTitle("📬 Daily Digest")
        .setDescription(
          `Status: **${optin ? "ON" : "OFF"}**\n` +
          (last ? `Last sent: <t:${Math.floor(new Date(last).getTime() / 1000)}:R>\n` : "Never sent yet.\n") +
          `\nUse \`/digest on\` or \`/digest off\` to toggle.`,
        )],
    });
  } catch (err) {
    logger.error({ err, discordId }, "handleDigestCommand failed");
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Something went wrong. Please try again.")],
    });
  }
}
