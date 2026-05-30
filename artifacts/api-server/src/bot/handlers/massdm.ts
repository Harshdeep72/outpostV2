import {
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type GuildMember,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} from "discord.js";
import { makeEmbed, hasVerifiedRole } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";

// ---------- Rate-limit tuning ----------
// Discord global REST limit is 50 req/s for the whole bot. Each DM = 1-2 reqs
// (open DM channel + send). With 5 concurrent workers each waiting 600ms
// between its own sends we sustain ~8 DMs/sec which is well under the cap and
// has been stable in production for similar bots. Single-user path skips the
// pool entirely.
const WORKER_COUNT = 5;
const PER_WORKER_DELAY_MS = 600;
const PROGRESS_UPDATE_EVERY = 25;

const TARGET_LABELS: Record<string, string> = {
  verified: "Verified Members",
  unverified: "Non-Verified Members",
  all: "All Members",
};

function isValidTarget(t: string | null | undefined): t is "verified" | "unverified" | "all" {
  return t === "verified" || t === "unverified" || t === "all";
}

export async function handleMassDmCommand(interaction: ChatInputCommandInteraction) {
  // Use the cached member from the interaction itself (no fetch — keeps us within 3s)
  const member = interaction.member;
  const perms = member?.permissions;
  const hasPerm =
    typeof perms === "object" && perms !== null && "has" in perms
      ? (perms.has(PermissionFlagsBits.Administrator) || perms.has(PermissionFlagsBits.ManageMessages))
      : false;

  if (!hasPerm) {
    return interaction.reply({ content: "❌ Only admins and mods can use this command.", flags: 64 });
  }

  // NEW: optional `user` option. When supplied we DM just that one user.
  const singleUser = interaction.options.getUser("user");
  if (singleUser) {
    if (singleUser.bot) {
      return interaction.reply({ content: "❌ Cannot DM a bot.", flags: 64 });
    }
    const modal = new ModalBuilder()
      .setCustomId(`massdm:modal:single:${singleUser.id}`)
      .setTitle(`DM — ${singleUser.username}`.slice(0, 45));

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("subject")
          .setLabel("Subject / Title")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("message")
          .setLabel("Message Body")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1500)
      )
    );

    return interaction.showModal(modal);
  }

  const targetRaw = interaction.options.getString("target") ?? "verified";
  const target = isValidTarget(targetRaw) ? targetRaw : "verified";
  const audienceLabel = TARGET_LABELS[target]!;

  const modal = new ModalBuilder()
    .setCustomId(`massdm:modal:${target}`)
    .setTitle(`Mass DM — ${audienceLabel}`.slice(0, 45));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("subject")
        .setLabel("Subject / Title")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100)
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("message")
        .setLabel("Message Body")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1500)
    )
  );

  await interaction.showModal(modal);
}

export async function handleMassDmModal(
  interaction: ModalSubmitInteraction,
  variant?: string,
  arg?: string,
) {
  await interaction.deferReply({ flags: 64 });

  const subject = interaction.fields.getTextInputValue("subject");
  const message = interaction.fields.getTextInputValue("message");
  const guild = interaction.guild!;

  const embed = makeEmbed(COLORS.ACCENT)
    .setTitle(`📢 ${subject}`)
    .setDescription(message)
    .setFooter({ text: `Sent by ${interaction.user.username} from ${guild.name}` })
    .setTimestamp();

  // ---------- Single-user path ----------
  if (variant === "single" && arg) {
    let member: GuildMember | null = null;
    try {
      member = await guild.members.fetch(arg);
    } catch {
      return interaction.editReply({
        embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Could not find that user in this server.")],
      });
    }

    try {
      await member.send({ embeds: [embed] });
      logger.info({ recipient: member.id, sender: interaction.user.id, subject }, "Single DM sent");
      return interaction.editReply({
        embeds: [
          makeEmbed(COLORS.SUCCESS)
            .setTitle("📨 DM Sent")
            .addFields(
              { name: "Recipient", value: `<@${member.id}>`, inline: true },
              { name: "Subject", value: subject, inline: true },
            ),
        ],
      });
    } catch (err: any) {
      logger.warn({ err, recipient: member.id }, "Single DM failed");
      return interaction.editReply({
        embeds: [
          makeEmbed(COLORS.DANGER)
            .setTitle("❌ DM Failed")
            .setDescription(`Could not DM <@${member.id}> — they likely have DMs disabled or have blocked the bot.`),
        ],
      });
    }
  }

  // ---------- Bulk path ----------
  const target = isValidTarget(variant) ? variant : "verified";
  const audienceLabel = TARGET_LABELS[target]!;

  await interaction.editReply({
    embeds: [makeEmbed(COLORS.PRIMARY).setDescription(`📨 Fetching members for **${audienceLabel}**…`)],
  });

  let members;
  try {
    members = await guild.members.fetch();
  } catch (err) {
    logger.error({ err }, "Failed to fetch guild members for mass DM");
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Failed to fetch guild members.")],
    });
  }

  const targets: GuildMember[] = [];
  for (const [, m] of members) {
    if (m.user.bot) continue;
    if (m.user.id === interaction.user.id) continue;
    if (target === "all") { targets.push(m); continue; }
    const verified = hasVerifiedRole(m, guild);
    if (target === "verified" && verified) targets.push(m);
    else if (target === "unverified" && !verified) targets.push(m);
  }

  const total = targets.length;
  if (total === 0) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.WARNING ?? COLORS.MUTED).setDescription(`No members matched **${audienceLabel}**.`)],
    });
  }

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.PRIMARY).setDescription(
        `📨 Sending to **${total}** ${audienceLabel.toLowerCase()}… (parallel x${WORKER_COUNT}, this is much faster than before)`,
      ),
    ],
  });

  let sent = 0;
  let failed = 0;
  let cursor = 0;
  let lastProgressShown = 0;

  // Throttle progress edits — Discord rate-limits message edits too. We push
  // an update every PROGRESS_UPDATE_EVERY sends, and at minimum every 4s.
  let lastProgressAt = Date.now();
  const tryProgress = async () => {
    const done = sent + failed;
    if (done - lastProgressShown < PROGRESS_UPDATE_EVERY) return;
    if (Date.now() - lastProgressAt < 4000) return;
    lastProgressShown = done;
    lastProgressAt = Date.now();
    try {
      await interaction.editReply({
        embeds: [
          makeEmbed(COLORS.PRIMARY).setDescription(
            `📨 Sending to **${audienceLabel}**… ${done}/${total} (✅ ${sent} · ❌ ${failed})`,
          ),
        ],
      });
    } catch { /* ignore — purely cosmetic */ }
  };

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;
      const m = targets[idx]!;
      try {
        await m.send({ embeds: [embed] });
        sent++;
      } catch {
        failed++;
      }
      // Fire-and-forget progress edit; never let it block sending.
      void tryProgress();
      // Per-worker spacing. With WORKER_COUNT=5 and 600ms each → ~8 DMs/sec.
      await new Promise((r) => setTimeout(r, PER_WORKER_DELAY_MS));
    }
  }

  const workers = Array.from({ length: Math.min(WORKER_COUNT, total) }, () => worker());
  await Promise.all(workers);

  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("📨 Mass DM Complete")
        .addFields(
          { name: "Audience", value: audienceLabel, inline: false },
          { name: "Subject", value: subject, inline: false },
          { name: "✅ Sent", value: String(sent), inline: true },
          { name: "❌ Failed", value: String(failed), inline: true },
          { name: "Total Attempted", value: String(sent + failed), inline: true },
        )
        .setFooter({ text: "Failed DMs are usually from users with DMs disabled or who have blocked the bot." }),
    ],
  });

  logger.info({ sent, failed, total, target, subject, sender: interaction.user.id }, "Mass DM completed");
}
