import {
  type Guild,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { users, withdrawals, serverConfig } from "@workspace/db";
import { setupGuild } from "../setup.js";
import { refundAvailable } from "../db.js";
import { invalidateUser } from "../cache.js";
import { makeEmbed, formatMoney, getISOWeekStart } from "../util.js";
import { COLORS, PAYOUT_DAY_UTC } from "../constants.js";
import { logger } from "../../lib/logger.js";

/**
 * Normalize a wallet entry into { address, network }. Accepts the legacy
 * string format (just an address, no network) and the new object format
 * produced by `/setwallet`. Returns null for empty/garbage entries so
 * callers can `if (!wallet) continue;`.
 */
function extractWallet(raw: unknown): { address: string; network: string | null } | null {
  if (typeof raw === "string") {
    const addr = raw.trim();
    return addr.length > 0 ? { address: addr, network: null } : null;
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.address === "string" && o.address.trim().length > 0) {
      return {
        address: o.address.trim(),
        network: typeof o.network === "string" && o.network.length > 0 ? o.network : null,
      };
    }
  }
  return null;
}

async function getOrCreateConfig(guildId: string) {
  const rows = await db.select().from(serverConfig).where(eq(serverConfig.guildId, guildId)).limit(1);
  if (rows.length > 0) return rows[0]!;
  const [row] = await db.insert(serverConfig).values({ guildId }).returning();
  return row!;
}

export async function runWeeklyPayouts(guild: Guild, force = false): Promise<{ processed: number; totalAmount: number; skipped: number }> {
  const now = new Date();
  if (!force && now.getUTCDay() !== PAYOUT_DAY_UTC) return { processed: 0, totalAmount: 0, skipped: 0 };

  await getOrCreateConfig(guild.id); // ensure row exists for the CAS below
  const weekStart = getISOWeekStart(now);

  if (!force) {
    // ATOMIC WEEK CLAIM — the prior code read last_weekly_payout_at, decided
    // whether this week was already paid, then much later (L152) updated it.
    // Two cron ticks racing here would BOTH pass the check and BOTH process
    // the eligible-user loop → users get paid twice, balances double-zeroed
    // (or worse: deduct+insert+refund interleavings). Pin the claim into a
    // single conditional UPDATE so exactly one tick wins the week.
    const claim = await db.execute<{ guild_id: string }>(
      sql`UPDATE server_config
             SET last_weekly_payout_at = ${now}, updated_at = ${now}
           WHERE guild_id = ${guild.id}
             AND (last_weekly_payout_at IS NULL
                  OR last_weekly_payout_at < ${weekStart})
           RETURNING guild_id`
    );
    if (claim.rows.length === 0) {
      logger.info({ guildId: guild.id, weekStart }, "Weekly payouts: already claimed this week, skipping");
      return { processed: 0, totalAmount: 0, skipped: 0 };
    }
  }

  const { withdrawalLogChannel } = await setupGuild(guild);

  const eligible = await db.select().from(users)
    .where(sql`verified = true AND flagged = false AND balance_available > 0`);

  if (eligible.length === 0) {
    // Week was already claimed by the atomic CAS above — no need to
    // re-update lastWeeklyPayoutAt here.
    await withdrawalLogChannel.send({
      embeds: [makeEmbed(COLORS.MUTED).setDescription("💤 No eligible balances to pay out this week.")],
    });
    return { processed: 0, totalAmount: 0, skipped: 0 };
  }

  await withdrawalLogChannel.send({
    embeds: [makeEmbed(COLORS.PRIMARY).setDescription(`💸 **Weekly Payouts — Processing ${eligible.length} eligible users**`)],
  });

  let processed = 0;
  let skipped = 0;

  for (const user of eligible) {
    const wallets = (user.cryptoWallets as Record<string, unknown>) ?? {};
    let method: string | null = null;
    let destination: string | null = null;

    // Helper: pick the chosen coin's wallet, format method as "USDT (TRC20)"
    // so admins see the chain right in the withdrawal embed and can't send
    // funds to the wrong network by mistake.
    const pickCrypto = (coin: string, displayCoin?: string): boolean => {
      const w = extractWallet(wallets[coin]);
      if (!w) return false;
      method = w.network ? `${displayCoin ?? coin} (${w.network})` : (displayCoin ?? coin);
      destination = w.address;
      return true;
    };

    if (user.upiId) { method = "UPI"; destination = user.upiId; }
    else if (pickCrypto("USDT")) { /* picked */ }
    else if (wallets["BINANCE"]) {
      const bw = extractWallet(wallets["BINANCE"]);
      if (bw) { method = "Binance Pay"; destination = bw.address; }
    }
    if (!method) {
      if (pickCrypto("ETH")) { /* picked */ }
      else if (pickCrypto("BTC")) { /* picked */ }
    }

    if (!method || !destination) {
      skipped++;
      try {
        const member = await guild.members.fetch(user.discordId);
        await member.send({
          embeds: [
            makeEmbed(COLORS.WARNING)
              .setTitle("⚠️ No Payment Method")
              .setDescription(`You have **${formatMoney(user.balanceAvailable)}** ready to pay out but no payment method saved.\n\nUse \`/setupi\` to save your UPI ID, or \`/setwallet\` to save a crypto wallet or Binance Pay ID.`),
          ],
        });
      } catch {
        logger.warn({ discordId: user.discordId }, "Could not DM user about missing payment method");
      }
      continue;
    }

    // ATOMIC per-user deduct — the prior code read user.balanceAvailable
    // from the eligible-list snapshot, then called deductAvailable(amount)
    // separately. Between those two operations, the user could have earned
    // more (pendingProcessor crediting balance_available) or submitted a
    // /withdraw, leaving the deducted amount out of sync with the
    // withdrawal row we then insert. Wrap in a transaction with FOR UPDATE
    // so the read and zero-out are one indivisible step and the amount we
    // pay out equals the amount we actually deducted.
    let amount: string | null = null;
    try {
      amount = await db.transaction(async (tx: any) => {
        const lockRes = await tx.execute(
          sql`SELECT balance_available::text AS amount FROM users WHERE id = ${user.id} FOR UPDATE`
        );
        const current = lockRes.rows[0]?.amount as string | undefined;
        if (!current || parseFloat(current) <= 0) return null;
        await tx.execute(sql`UPDATE users SET balance_available = 0 WHERE id = ${user.id}`);
        return current;
      });
    } catch (err) {
      logger.error({ err, discordId: user.discordId }, "Weekly payouts: deduct failed, skipping user");
      continue;
    }
    if (!amount) {
      // Balance hit zero between eligible-list query and the lock above
      // (e.g. the user just submitted /withdraw). Safe to skip.
      continue;
    }
    invalidateUser(user.discordId, user.id);

    const [wd] = await db.insert(withdrawals).values({
      userId: user.id,
      discordId: user.discordId,
      amount,
      method,
      destination,
      status: "pending",
    }).returning();

    if (!wd) {
      // Insert failed — refund the deducted amount so we don't strand the
      // user's money. refundAvailable is itself atomic (+=).
      await refundAvailable(user.id, amount).catch(() => {});
      continue;
    }

    const normDest = destination.toLowerCase();
    const duplicateRows = await db.select({ 
      discordId: users.discordId,
      upiId: users.upiId,
      paypalEmail: users.paypalEmail,
      cryptoWallets: users.cryptoWallets
    })
      .from(users)
      .where(sql`discord_id != ${user.discordId} AND (
        LOWER(upi_id) = ${normDest} OR 
        LOWER(paypal_email) = ${normDest} OR 
        LOWER(crypto_wallets::text) LIKE ${"%" + normDest + "%"}
      )`);
      
    let duplicateUsers: string[] = [];
    for (const row of duplicateRows) {
      let match = false;
      if (row.upiId?.toLowerCase() === normDest) match = true;
      if (row.paypalEmail?.toLowerCase() === normDest) match = true;
      const cw = row.cryptoWallets as Record<string, unknown> | null;
      if (cw) {
        for (const val of Object.values(cw)) {
          if (typeof val === "string" && val.toLowerCase() === normDest) match = true;
          if (typeof val === "object" && val !== null && (val as any).address?.toLowerCase() === normDest) match = true;
        }
      }
      if (match) {
        duplicateUsers.push(`<@${row.discordId}>`);
      }
    }

    const wdEmbed = makeEmbed(COLORS.WARNING)
      .setTitle("💸 Payout Pending")
      .addFields(
        { name: "User", value: `<@${user.discordId}>`, inline: true },
        { name: "Amount", value: formatMoney(amount), inline: true },
        { name: "Method", value: method, inline: true },
        { name: "Destination", value: destination },
      );
      
    if (duplicateUsers.length > 0) {
      wdEmbed.addFields({ name: "⚠️ DUPLICATE DESTINATION DETECTED", value: `Shared with: ${duplicateUsers.join(", ")}` });
    }
    
    wdEmbed.setFooter({ text: `Withdrawal #${wd.id}` });

    const wdRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`wd:approve:${wd.id}`).setLabel("Mark as Paid").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`wd:reject:${wd.id}`).setLabel("Reject (refund)").setStyle(ButtonStyle.Danger),
    );

    const logMsg = await withdrawalLogChannel.send({ embeds: [wdEmbed], components: [wdRow] });
    await db.update(withdrawals).set({ logMessageId: logMsg.id }).where(eq(withdrawals.id, wd.id));

    try {
      const member = await guild.members.fetch(user.discordId);
      await member.send({
        embeds: [
          makeEmbed(COLORS.PRIMARY)
            .setTitle("💸 Payout Processing")
            .setDescription(`Your weekly payout of **${formatMoney(amount)}** via **${method}** is being processed.`),
        ],
      });
    } catch {
      logger.warn({ discordId: user.discordId }, "Could not DM user about payout");
    }

    processed++;
  }

  const totalAmount = eligible
    .filter((u: any) => {
      const wallets = (u.cryptoWallets as Record<string, string>) ?? {};
      return u.upiId || wallets["USDT"] || wallets["BINANCE"] || wallets["ETH"] || wallets["BTC"];
    })
    .reduce((sum: number, u: any) => sum + parseFloat(String(u.balanceAvailable)), 0);

  await withdrawalLogChannel.send({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("✅ Weekly Payouts — Summary")
        .addFields(
          { name: "Processed", value: String(processed), inline: true },
          { name: "Total Amount", value: formatMoney(totalAmount), inline: true },
          { name: "Skipped (no payment method)", value: String(skipped), inline: true },
        ),
    ],
  });

  // lastWeeklyPayoutAt already stamped by the atomic week-claim CAS at the
  // top of this function — no second write needed.
  logger.info({ guildId: guild.id, processed, skipped, totalAmount }, "Weekly payouts completed");
  return { processed, totalAmount, skipped };
}
