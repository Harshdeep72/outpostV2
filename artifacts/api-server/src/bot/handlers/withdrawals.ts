import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type Guild,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextInputBuilder,
  TextInputStyle,
  ModalBuilder,
  EmbedBuilder,
} from "discord.js";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withdrawals } from "@workspace/db";
import { refundAvailable } from "../db.js";
import { makeEmbed, formatMoney } from "../util.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";
import { tryPostWeeklyPayoutAnnouncement } from "./weeklyPayoutAnnouncement.js";

// ───────────────────── creator-payout helpers ─────────────────────

interface CreatorPayoutRow {
  id: number;
  withdrawal_id: number;
  creator_discord_id: string;
  amount: string;
  status: string;
  paid_by: string | null;
  paid_at: Date | null;
  display_name?: string | null;
}

/**
 * Friendly display name for a creator id. Real Discord ids resolve to the
 * stored discord_username. Dashboard pseudo-ids ("dashboard:alice") fall back
 * to the username after the colon.
 */
async function resolveCreatorDisplay(creatorDiscordId: string): Promise<string> {
  if (creatorDiscordId.startsWith("dashboard:")) {
    return `Dashboard · ${creatorDiscordId.slice("dashboard:".length)}`;
  }
  const r = await db.execute<{ discord_username: string }>(
    sql`SELECT discord_username FROM users WHERE discord_id = ${creatorDiscordId} LIMIT 1`
  );
  return r.rows[0]?.discord_username ?? creatorDiscordId;
}

async function getPayoutRows(wdId: number): Promise<CreatorPayoutRow[]> {
  const r = await db.execute<CreatorPayoutRow>(
    sql`SELECT id, withdrawal_id, creator_discord_id, amount, status, paid_by, paid_at
        FROM withdrawal_creator_payouts
        WHERE withdrawal_id = ${wdId}
        ORDER BY id ASC`
  );
  const rows = r.rows;
  for (const row of rows) {
    row.display_name = await resolveCreatorDisplay(row.creator_discord_id);
  }
  return rows;
}

/**
 * Allocate not-yet-allocated accepted submissions for this user (oldest first)
 * to fill the withdrawal amount, group by task creator, and insert one
 * `withdrawal_creator_payouts` row per creator.
 *
 * Submissions where the running total overshoots `wdAmount` are still tagged
 * with `withdrawal_id` (they're "consumed" by this payout for traceability),
 * but the LAST allocated submission's contribution to its creator's payout
 * row is capped to the remaining amount so per-creator amounts always sum to
 * wd.amount exactly.
 */
async function buildCreatorPayouts(
  wdId: number,
  earnerDiscordId: string,
  wdAmount: string,
): Promise<CreatorPayoutRow[]> {
  const target = parseFloat(wdAmount);
  if (!(target > 0)) return [];

  // Race-safe: lock the withdrawal row and do the split atomically. Two
  // concurrent "Mark as Paid" clicks will serialize on the lock; the second
  // sees the rows already exist and returns them. The unique index on
  // (withdrawal_id, creator_discord_id) is a belt-and-suspenders guard.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${wdId} FOR UPDATE`);

    const existing = await tx.execute<{ id: number }>(
      sql`SELECT id FROM withdrawal_creator_payouts WHERE withdrawal_id = ${wdId} LIMIT 1`
    );
    if (existing.rows.length > 0) return; // already split

    const subs = await tx.execute<{
      id: number;
      reward: string;
      task_id: number;
      creator_discord_id: string;
    }>(sql`
      SELECT s.id, s.reward::text AS reward, s.task_id, t.creator_discord_id
      FROM submissions s
      JOIN tasks t ON t.id = s.task_id
      WHERE s.discord_id = ${earnerDiscordId}
        AND s.review_status = 'accepted'
        AND s.withdrawal_id IS NULL
        AND s.moved_to_available = 1
        AND COALESCE(t.creator_discord_id, '') <> ''
      ORDER BY s.submitted_at ASC, s.id ASC
      FOR UPDATE OF s
    `);

    const allocated: number[] = [];
    const perCreator = new Map<string, { amount: number; submissionIds: number[] }>();
    let running = 0;
    for (const r of subs.rows) {
      if (running >= target - 0.0001) break;
      const reward = parseFloat(r.reward);
      if (!(reward > 0)) continue;
      const remaining = target - running;
      const contribution = Math.min(reward, remaining);
      const bucket = perCreator.get(r.creator_discord_id) ?? { amount: 0, submissionIds: [] };
      bucket.amount = Math.round((bucket.amount + contribution) * 100) / 100;
      bucket.submissionIds.push(r.id);
      perCreator.set(r.creator_discord_id, bucket);
      allocated.push(r.id);
      running += contribution;
    }

    if (perCreator.size === 0) {
      // Fallback: legacy data with no creator-linked submissions.
      await tx.execute(sql`
        INSERT INTO withdrawal_creator_payouts (withdrawal_id, creator_discord_id, amount, submission_ids)
        VALUES (${wdId}, ${"treasury"}, ${target.toFixed(2)}, ${"[]"}::jsonb)
        ON CONFLICT (withdrawal_id, creator_discord_id) DO NOTHING
      `);
      return;
    }

    if (allocated.length > 0) {
      await tx.execute(sql`
        UPDATE submissions SET withdrawal_id = ${wdId}
        WHERE id = ANY(${sql`ARRAY[${sql.join(allocated.map((id) => sql`${id}`), sql`, `)}]::int[]`})
      `);
    }

    for (const [creatorId, bucket] of perCreator) {
      const idsJson = JSON.stringify(bucket.submissionIds);
      await tx.execute(sql`
        INSERT INTO withdrawal_creator_payouts (withdrawal_id, creator_discord_id, amount, submission_ids)
        VALUES (${wdId}, ${creatorId}, ${bucket.amount.toFixed(2)}, ${idsJson}::jsonb)
        ON CONFLICT (withdrawal_id, creator_discord_id) DO NOTHING
      `);
    }
  });

  return getPayoutRows(wdId);
}

// ── Embed-field marker. The per-creator breakdown is always upserted by
// this exact name, so repaints replace the row instead of appending another
// one (previous slice/splice logic could accumulate stale fields).
const BREAKDOWN_FIELD_NAME = "💸 Per-creator payout breakdown";

// Discord limits 5 buttons per row, 5 rows per message = 25 components.
// One slot is always reserved for the Reject button.
const MAX_CREATOR_BUTTONS = 24;

/**
 * Replace (or append) an embed field by name. Returns the SAME builder
 * for chaining. Idempotent — calling repeatedly with the same name only
 * ever updates the existing field, never duplicates it.
 */
function upsertField(embed: EmbedBuilder, name: string, value: string, inline = false): EmbedBuilder {
  const fields = (embed.data.fields ?? []).map((f) => ({ ...f }));
  const idx = fields.findIndex((f) => f.name === name);
  if (idx >= 0) fields[idx] = { name, value, inline };
  else fields.push({ name, value, inline });
  embed.setFields(fields);
  return embed;
}

/**
 * Pure render of the per-creator gate state — the breakdown text + button
 * rows for the log message. Called on first split AND on every repaint, so
 * the result must depend only on the payout rows (no side effects).
 */
function buildBreakdownComponents(
  wdId: number,
  payouts: CreatorPayoutRow[],
): { breakdownValue: string; rows: ActionRowBuilder<ButtonBuilder>[] } {
  // Pending creators first so the buttons users still need to click are at
  // the top of the row stack (and won't get truncated past the 24-button cap).
  const ordered = [...payouts].sort((a, b) => {
    if (a.status === b.status) return a.id - b.id;
    return a.status === "paid" ? 1 : -1;
  });

  const lines = ordered.map((p) => {
    const tick = p.status === "paid" ? "✅" : "⏳";
    const name = p.display_name ?? p.creator_discord_id;
    const tag = p.creator_discord_id.startsWith("dashboard:") || p.creator_discord_id === "treasury"
      ? `**${name}**`
      : `<@${p.creator_discord_id}> (${name})`;
    const paidBy = p.status === "paid" && p.paid_by ? `  · marked by <@${p.paid_by}>` : "";
    return `${tick} ${tag} — **${formatMoney(p.amount)}**${paidBy}`;
  });

  const buttonable = ordered.slice(0, MAX_CREATOR_BUTTONS);
  const overflow = ordered.length - buttonable.length;
  let breakdownValue = lines.join("\n") || "_No breakdown_";
  if (overflow > 0) {
    breakdownValue += `\n\n_⚠ ${overflow} more creator${overflow === 1 ? "" : "s"} not shown as buttons — mark via admin tools._`;
  }

  const buttons: ButtonBuilder[] = buttonable.map((p) =>
    new ButtonBuilder()
      .setCustomId(`wd:cpay:${wdId}:${p.id}`)
      .setLabel(`Mark ${(p.display_name ?? p.creator_discord_id).slice(0, 30)} Paid`)
      .setStyle(p.status === "paid" ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setDisabled(p.status === "paid"),
  );
  buttons.push(
    new ButtonBuilder()
      .setCustomId(`wd:reject:${wdId}`)
      .setLabel("Reject Withdrawal")
      .setStyle(ButtonStyle.Danger),
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  }
  return { breakdownValue, rows };
}

/** DM each task creator a heads-up that a payout is awaiting their action. */
async function notifyCreators(
  guild: Guild,
  earnerDiscordId: string,
  wd: typeof withdrawals.$inferSelect,
  payouts: CreatorPayoutRow[],
): Promise<void> {
  let earnerName = earnerDiscordId;
  try {
    const m = await guild.members.fetch(earnerDiscordId);
    earnerName = m.user.username;
  } catch { /* best-effort */ }

  for (const p of payouts) {
    if (p.creator_discord_id.startsWith("dashboard:") || p.creator_discord_id === "treasury") continue;
    try {
      const m = await guild.members.fetch(p.creator_discord_id);
      await m.send({
        embeds: [
          makeEmbed(COLORS.WARNING)
            .setTitle("💼 Payout Owed for Your Task")
            .setDescription(
              `**${earnerName}** completed your task(s) and is cashing out **${formatMoney(p.amount)}** of their balance from work they did for you.\n\n` +
              `Please pay them via their preferred method below, then notify the admin team — they'll mark this complete in the withdrawal log.`
            )
            .addFields(
              { name: "Amount Owed", value: formatMoney(p.amount), inline: true },
              { name: "Method", value: String(wd.method), inline: true },
              { name: "Send To", value: `\`${wd.destination}\`` },
            )
            .setFooter({ text: `Withdrawal #${wd.id} · payout #${p.id}` }),
        ],
      });
    } catch {
      logger.warn({ creator: p.creator_discord_id, wdId: wd.id }, "Could not DM creator on payout request");
    }
  }
}

// ───────────────────── handlers ─────────────────────

/**
 * First click on "Approve" splits the withdrawal into per-creator gates and
 * DMs each creator. Subsequent clicks on the same Approve button (legacy
 * customId) just refresh the breakdown — actual finalization happens via
 * `wd:cpay:*` per-creator buttons.
 */
export async function handleWdApprove(interaction: ButtonInteraction, wdId: number) {
  await interaction.deferUpdate();

  const rows = await db.select().from(withdrawals).where(eq(withdrawals.id, wdId)).limit(1);
  const wd = rows[0];
  if (!wd) return interaction.followUp({ content: "❌ Withdrawal not found.", flags: 64 });

  if (wd.status !== "pending") {
    return interaction.followUp({ content: "❌ Already processed.", flags: 64 });
  }

  // Build (or fetch existing) per-creator payout rows.
  const payouts = await buildCreatorPayouts(wdId, wd.discordId, String(wd.amount));
  if (payouts.length === 0) {
    return interaction.followUp({
      content: "❌ Could not compute payout breakdown — no eligible submissions found.",
      flags: 64,
    });
  }

  // DM creators on the FIRST split (i.e. when freshly created).
  const isFirstSplit = payouts.every((p) => p.status === "pending" && !p.paid_by);
  if (isFirstSplit && interaction.guild) {
    await notifyCreators(interaction.guild, wd.discordId, wd, payouts).catch((err) =>
      logger.warn({ err, wdId }, "notifyCreators failed (non-fatal)")
    );
  }

  // Repaint the log message (idempotent: replace-by-name, no accumulation).
  const originalEmbed = interaction.message.embeds[0];
  if (originalEmbed) {
    const { breakdownValue, rows: btnRows } = buildBreakdownComponents(wdId, payouts);
    const updated = upsertField(
      EmbedBuilder.from(originalEmbed).setColor(COLORS.WARNING),
      BREAKDOWN_FIELD_NAME, breakdownValue,
    ).setFooter({ text: `Awaiting ${payouts.filter((p) => p.status !== "paid").length} creator payment(s) · split by ${interaction.user.username}` });
    await interaction.message.edit({ embeds: [updated], components: btnRows });
  }

  logger.info({ wdId, creators: payouts.length, reviewer: interaction.user.id }, "Withdrawal split into creator payouts");
}

/**
 * Per-creator "Mark Paid" click. When the LAST creator is marked paid, run
 * the original finalize-payout logic: DM the user, mark the withdrawal
 * approved, and lock the message.
 */
export async function handleWdCreatorPay(
  interaction: ButtonInteraction,
  wdId: number,
  payoutId: number,
) {
  await interaction.deferUpdate();

  const wdRows = await db.select().from(withdrawals).where(eq(withdrawals.id, wdId)).limit(1);
  const wd = wdRows[0];
  if (!wd) return interaction.followUp({ content: "❌ Withdrawal not found.", flags: 64 });
  if (wd.status !== "pending") {
    return interaction.followUp({ content: "❌ Already finalized.", flags: 64 });
  }

  // Mark this row paid (no-op if already paid).
  const upd = await db.execute<{ id: number }>(sql`
    UPDATE withdrawal_creator_payouts
       SET status = 'paid', paid_by = ${interaction.user.id}, paid_at = NOW()
     WHERE id = ${payoutId} AND withdrawal_id = ${wdId} AND status = 'pending'
     RETURNING id
  `);
  if (upd.rows.length === 0) {
    // Already paid — just refresh the message and exit.
  }

  const payouts = await getPayoutRows(wdId);
  const allPaid = payouts.length > 0 && payouts.every((p) => p.status === "paid");

  if (!allPaid) {
    // Repaint with updated checkmarks; gate stays open for remaining creators.
    const originalEmbed = interaction.message.embeds[0];
    if (originalEmbed) {
      const { breakdownValue, rows: btnRows } = buildBreakdownComponents(wdId, payouts);
      const updated = upsertField(
        EmbedBuilder.from(originalEmbed).setColor(COLORS.WARNING),
        BREAKDOWN_FIELD_NAME, breakdownValue,
      ).setFooter({ text: `Awaiting ${payouts.filter((p) => p.status !== "paid").length} creator payment(s)` });
      await interaction.message.edit({ embeds: [updated], components: btnRows });
    }
    logger.info({ wdId, payoutId, reviewer: interaction.user.id }, "Creator payout marked paid (gate still open)");
    return;
  }

  // ── All creators paid → finalize the withdrawal. ──
  await db.update(withdrawals).set({
    status: "approved",
    reviewerDiscordId: interaction.user.id,
    processedAt: new Date(),
  }).where(eq(withdrawals.id, wdId));

  // After-finalize hook: post the Wednesday-payday weekly announcement PNG
  // to #announcements IF this was the last pending withdrawal of the cycle.
  // Wrapped in try/catch — must never block withdrawal finalization.
  if (interaction.guild) {
    tryPostWeeklyPayoutAnnouncement(interaction.guild).catch((err) =>
      logger.warn({ err, wdId }, "tryPostWeeklyPayoutAnnouncement failed (non-fatal)")
    );
  }

  // Final repaint: success color, no buttons.
  const originalEmbed = interaction.message.embeds[0];
  if (originalEmbed) {
    const { breakdownValue } = buildBreakdownComponents(wdId, payouts);
    const updated = upsertField(
      EmbedBuilder.from(originalEmbed).setColor(COLORS.SUCCESS),
      BREAKDOWN_FIELD_NAME, breakdownValue,
    ).setFooter({ text: `✅ All creators paid · finalized by ${interaction.user.username}` });
    await interaction.message.edit({ embeds: [updated], components: [] });
  }

  // DM the earner — same message they always got on approve.
  try {
    const guild = interaction.guild!;
    const member = await guild.members.fetch(wd.discordId);
    await member.send({
      embeds: [
        makeEmbed(COLORS.SUCCESS)
          .setTitle("💰 Payout Sent!")
          .setDescription(
            `Your withdrawal of **${formatMoney(wd.amount)}** via **${wd.method}** has been approved and sent!`
          )
          .addFields(
            { name: "Amount", value: formatMoney(wd.amount), inline: true },
            { name: "Method", value: String(wd.method), inline: true },
            { name: "Sent To", value: `\`${wd.destination}\`` },
          )
          .setFooter({ text: "Thanks for working with Outpost! 💸" }),
      ],
    });
  } catch {
    logger.warn({ discordId: wd.discordId }, "Could not DM user on withdrawal finalize");
  }

  logger.info({ wdId, reviewer: interaction.user.id }, "Withdrawal finalized after all creators paid");
}

export async function handleWdReject(interaction: ButtonInteraction, wdId: number) {
  const modal = new ModalBuilder()
    .setCustomId(`wd:reason:${wdId}`)
    .setTitle("Reject Withdrawal");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("reason").setLabel("Rejection reason").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
    )
  );

  await interaction.showModal(modal);
}

export async function handleWdRejectReason(interaction: ModalSubmitInteraction, wdId: number) {
  await interaction.deferUpdate();

  const reason = interaction.fields.getTextInputValue("reason");

  const rows = await db.select().from(withdrawals).where(eq(withdrawals.id, wdId)).limit(1);
  const wd = rows[0];
  if (!wd) return interaction.followUp({ content: "❌ Withdrawal not found.", flags: 64 });

  if (wd.status !== "pending") {
    return interaction.followUp({ content: "❌ Already processed.", flags: 64 });
  }

  // ATOMIC CAS — the pending check above is a stale read. Two reviewers
  // double-clicking Reject would BOTH pass it and BOTH call
  // refundAvailable, giving the user 2× their withdrawal amount back.
  // Pin status='pending' into the WHERE so only one reviewer wins and the
  // refund/cleanup only runs on the winning path.
  const cas = await db.execute<{ id: number }>(
    sql`UPDATE withdrawals SET
            status = 'rejected',
            reviewer_discord_id = ${interaction.user.id},
            reason = ${reason},
            processed_at = NOW()
          WHERE id = ${wdId} AND status = 'pending'
          RETURNING id`
  );
  if (cas.rows.length === 0) {
    return interaction.followUp({ content: "❌ Already processed by someone else.", flags: 64 });
  }

  await refundAvailable(wd.userId, String(wd.amount));

  // Release any submissions we'd allocated to this withdrawal so they can be
  // re-allocated when the user retries, and drop the per-creator payout rows.
  await db.execute(sql`UPDATE submissions SET withdrawal_id = NULL WHERE withdrawal_id = ${wdId}`);
  await db.execute(sql`DELETE FROM withdrawal_creator_payouts WHERE withdrawal_id = ${wdId}`);

  const originalEmbed = interaction.message?.embeds[0];
  if (originalEmbed) {
    const updated = EmbedBuilder.from(originalEmbed).setColor(COLORS.DANGER)
      .setFooter({ text: `Rejected by ${interaction.user.username}: ${reason}` });
    await interaction.message?.edit({ embeds: [updated], components: [] });
  }

  try {
    const guild = interaction.guild!;
    const member = await guild.members.fetch(wd.discordId);
    await member.send({
      embeds: [
        makeEmbed(COLORS.DANGER)
          .setTitle("❌ Withdrawal Rejected")
          .setDescription(`Your withdrawal of **${formatMoney(wd.amount)}** was rejected and the amount has been refunded to your available balance.\n\n**Reason:** ${reason}`),
      ],
    });
  } catch {
    logger.warn({ discordId: wd.discordId }, "Could not DM user on withdrawal reject");
  }

  logger.info({ wdId, reviewer: interaction.user.id, reason }, "Withdrawal rejected and refunded");
}
