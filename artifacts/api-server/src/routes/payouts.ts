import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { getPrimaryGuild } from "../bot/discord-client.js";
import { TextChannel, EmbedBuilder } from "discord.js";

const router: IRouter = Router();

// In-memory cache for live exchange rates
let cachedRates: { INR: number; PHP: number } = { INR: 94.29, PHP: 58.75 };
let lastRateFetch = 0;

async function getLiveExchangeRates(): Promise<{ INR: number; PHP: number }> {
  if (Date.now() - lastRateFetch < 60 * 1000) {
    return cachedRates;
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = (await res.json()) as any;
    if (data && data.rates) {
      if (typeof data.rates.INR === "number") cachedRates.INR = parseFloat(data.rates.INR.toFixed(2));
      if (typeof data.rates.PHP === "number") cachedRates.PHP = parseFloat(data.rates.PHP.toFixed(2));
      lastRateFetch = Date.now();
      return cachedRates;
    }
  } catch (err) {
    logger.warn({ err }, "Primary exchange rate fetch failed, trying fallback");
  }

  try {
    const res2 = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    const data2 = (await res2.json()) as any;
    if (data2 && data2.rates) {
      if (typeof data2.rates.INR === "number") cachedRates.INR = parseFloat(data2.rates.INR.toFixed(2));
      if (typeof data2.rates.PHP === "number") cachedRates.PHP = parseFloat(data2.rates.PHP.toFixed(2));
      lastRateFetch = Date.now();
    }
  } catch (err) {
    logger.warn({ err }, "Fallback exchange rate fetch failed, using cached");
  }

  return cachedRates;
}

// ──────────────────────────────────────────────────────────────────────────
// API ROUTES
// ──────────────────────────────────────────────────────────────────────────

router.get("/api/data", async (_req: Request, res: Response) => {
  try {
    const rates = await getLiveExchangeRates();

    const result = await db.execute<{
      id: number;
      user_id: number;
      discord_id: string;
      amount: string;
      method: string;
      destination: string;
      status: string;
      log_message_id: string | null;
      processed_at: string | null;
      discord_username: string;
      workspace_channel_id: string | null;
    }>(sql`
      SELECT w.id, w.user_id, w.discord_id, w.amount, w.method, w.destination, w.status,
             w.log_message_id, w.processed_at,
             u.discord_username, u.workspace_channel_id
        FROM withdrawals w
        JOIN users u ON u.id = w.user_id
       WHERE w.id >= 124
       ORDER BY w.id ASC
    `);

    res.json({
      ok: true,
      liveRate: rates.INR,
      phpRate: rates.PHP,
      withdrawals: result.rows,
    });
  } catch (err: any) {
    logger.error({ err }, "Error in /payouts/api/data");
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/api/mark-paid", async (req: Request, res: Response) => {
  const { wdId, inrAmount, rate, txHash } = req.body;
  if (!wdId) return res.status(400).json({ ok: false, error: "Missing wdId" });

  try {
    const rowRes = await db.execute<{
      id: number;
      user_id: number;
      discord_id: string;
      amount: string;
      method: string;
      destination: string;
      status: string;
      log_message_id: string | null;
      discord_username: string;
      workspace_channel_id: string | null;
    }>(sql`
      SELECT w.id, w.user_id, w.discord_id, w.amount, w.method, w.destination, w.status,
             w.log_message_id, u.discord_username, u.workspace_channel_id
        FROM withdrawals w
        JOIN users u ON u.id = w.user_id
       WHERE w.id = ${parseInt(wdId)}
       LIMIT 1
    `);

    const wd = rowRes.rows[0];
    if (!wd) return res.status(404).json({ ok: false, error: "Withdrawal not found" });

    // 1. Update Database
    await db.execute(sql`
      UPDATE withdrawals
         SET status = 'approved',
             processed_at = NOW()
       WHERE id = ${wd.id}
    `);

    const inrVal = typeof inrAmount === "number" ? inrAmount : parseFloat(wd.amount) * (rate || 88.5);
    const usdVal = parseFloat(wd.amount).toFixed(2);
    const inrStr = inrVal.toFixed(2);

    // 2. Update Discord Log Message in #withdrawal-log
    try {
      const guild = getPrimaryGuild();
      if (guild) {
        const WITHDRAWAL_LOG_CHANNEL_ID = "1565661347914453034";
        const logChannel = (await guild.channels.fetch(WITHDRAWAL_LOG_CHANNEL_ID).catch(() => null)) as TextChannel | null;
        if (logChannel && wd.log_message_id) {
          const msg = await logChannel.messages.fetch(wd.log_message_id).catch(() => null);
          if (msg && msg.embeds.length > 0) {
            const oldEmbed = msg.embeds[0]!;
            const isUpi = wd.method === "UPI";
            const updatedEmbed = EmbedBuilder.from(oldEmbed)
              .setColor(0x10b981)
              .setTitle("✅ Payout Completed")
              .addFields(
                ...(isUpi
                  ? [{ name: "Paid In INR", value: `₹${inrStr} (@ ₹${rate || 88.5}/$1)`, inline: true }]
                  : [{ name: "Paid Amount", value: `$${usdVal} USD`, inline: true }]),
                { name: "Status", value: `Paid via ${wd.method}`, inline: true },
                ...(txHash ? [{ name: "Tx Reference", value: `\`${txHash}\``, inline: false }] : [])
              )
              .setFooter({ text: `Withdrawal #${wd.id} · Paid via Payout Station` });
            await msg.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {});
          }
        }

        // 3. Send celebratory payout message to User's Workspace Channel!
        if (wd.workspace_channel_id) {
          try {
            const wsChannel = (await guild.channels.fetch(wd.workspace_channel_id).catch(() => null)) as TextChannel | null;
            if (wsChannel) {
              let description = "";
              const fields = [
                { name: "Amount (USD)", value: `$${usdVal}`, inline: true },
                { name: "Payment Method", value: wd.method, inline: true },
                { name: "Destination", value: `\`${wd.destination}\``, inline: true },
                { name: "Withdrawal #", value: `#${wd.id}`, inline: true },
              ];

              if (wd.method === "UPI") {
                description = `Hey <@${wd.discord_id}>! Your weekly payout of **$${usdVal} USD** (**₹${inrStr}**) has been sent to your UPI ID!`;
                fields.splice(1, 0, { name: "Amount (INR)", value: `₹${inrStr}`, inline: true });
              } else if (wd.method === "PayPal") {
                description = `Hey <@${wd.discord_id}>! Your weekly payout of **$${usdVal} USD** has been sent to your PayPal account!`;
              } else if (wd.method === "GCash") {
                description = `Hey <@${wd.discord_id}>! Your weekly payout of **$${usdVal} USD** has been sent to your GCash number!`;
              } else if (wd.method.includes("USDT")) {
                description = `Hey <@${wd.discord_id}>! Your weekly payout of **$${usdVal} USDT** (${wd.method}) has been transferred to your wallet!`;
                if (txHash) {
                  fields.push({ name: "Transaction Hash", value: `\`${txHash}\``, inline: false });
                }
              } else {
                description = `Hey <@${wd.discord_id}>! Your weekly payout of **$${usdVal} USD** has been transferred!`;
              }

              const wsEmbed = new EmbedBuilder()
                .setColor(0x10b981)
                .setTitle("💸 Payout Sent!")
                .setDescription(description)
                .addFields(fields)
                .setFooter({ text: "Reddit Microtasks · Thanks for your hard work! ⚡" })
                .setTimestamp();

              await wsChannel.send({
                content: `🎉 <@${wd.discord_id}> — your payment has arrived!`,
                embeds: [wsEmbed],
              });
            }
          } catch (wsErr) {
            logger.warn({ wsErr, wsId: wd.workspace_channel_id }, "Could not send message to workspace channel");
          }
        }

        // 4. Also send a polite DM confirmation
        try {
          const member = await guild.members.fetch(wd.discord_id);
          if (member) {
            await member.send({
              embeds: [
                new EmbedBuilder()
                  .setColor(0x10b981)
                  .setTitle("💸 Payout Sent!")
                  .setDescription(
                    `Your payout of **$${usdVal} USD** via ${wd.method} (\`${wd.destination}\`) has been transferred!\n\nCheck your workspace channel for full details.`
                  )
                  .setFooter({ text: "Reddit Microtasks 💸" })
                  .setTimestamp(),
              ],
            }).catch(() => {});
          }
        } catch {
          // DM failed (non-fatal)
        }
      }
    } catch (discErr) {
      logger.warn({ discErr }, "Discord update error during mark-paid (non-fatal)");
    }

    res.json({
      ok: true,
      message: `Withdrawal #${wd.id} marked as paid! Workspace channel and Discord log updated.`,
      inrStr,
    });
  } catch (err: any) {
    logger.error({ err }, "Error in /payouts/api/mark-paid");
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// HTML DASHBOARD INTERFACE
// ──────────────────────────────────────────────────────────────────────────

router.get("/", (_req: Request, res: Response) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Payout Station — Reddit Microtasks</title>
<style>
  :root {
    --bg: #0b0f19;
    --card-bg: #111827;
    --card-border: #1f2937;
    --primary: #3b82f6;
    --primary-hover: #2563eb;
    --success: #10b981;
    --success-hover: #059669;
    --text-main: #f9fafb;
    --text-muted: #9ca3af;
    --accent: #8b5cf6;
    --warning: #f59e0b;
    --paypal: #0070ba;
    --gcash: #0066f5;
    --crypto: #f59e0b;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { background: var(--bg); color: var(--text-main); min-height: 100vh; padding: 24px 16px; }
  .container { max-width: 1060px; margin: 0 auto; }

  /* Header */
  header {
    background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%);
    border: 1px solid #312e81;
    border-radius: 16px;
    padding: 22px 24px;
    margin-bottom: 24px;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    box-shadow: 0 10px 25px -5px rgba(0,0,0,0.4);
  }
  .header-left h1 { font-size: 1.55rem; font-weight: 800; display: flex; align-items: center; gap: 10px; color: #fff; }
  .header-left p { color: #a5b4fc; font-size: 0.88rem; margin-top: 4px; }

  .rate-box {
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid #4338ca;
    border-radius: 12px;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .rate-label { font-size: 0.78rem; color: #94a3b8; font-weight: 600; text-transform: uppercase; }
  .rate-input {
    background: #020617;
    border: 1px solid #3b82f6;
    color: #38bdf8;
    font-size: 1.2rem;
    font-weight: 700;
    width: 82px;
    padding: 6px 8px;
    border-radius: 8px;
    text-align: center;
    outline: none;
  }
  .rate-pills { display: flex; gap: 6px; }
  .pill-btn {
    background: #1e293b;
    border: 1px solid #334155;
    color: #e2e8f0;
    font-size: 0.8rem;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 600;
    transition: all 0.15s;
  }
  .pill-btn:hover { background: #334155; }
  .live-pill {
    display: inline-block;
    background: #064e3b;
    color: #34d399;
    border: 1px solid #059669;
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  /* Method Selector Tabs */
  .method-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
  }
  .method-tab {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    color: #cbd5e1;
    padding: 10px 18px;
    border-radius: 12px;
    font-size: 0.92rem;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: all 0.2s;
  }
  .method-tab:hover { background: #1f2937; border-color: #374151; color: #fff; }
  .method-tab.active {
    background: #1e1b4b;
    border-color: #6366f1;
    color: #fff;
    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.25);
  }
  .count-badge {
    background: #374151;
    color: #f3f4f6;
    font-size: 0.75rem;
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 700;
  }
  .method-tab.active .count-badge {
    background: #4f46e5;
    color: #fff;
  }

  /* Summary Stats */
  .stats-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
    margin-bottom: 24px;
  }
  .stat-box {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .stat-box .title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 600; }
  .stat-box .val { font-size: 1.4rem; font-weight: 800; color: #fff; }

  /* Progress Bar */
  .progress-wrap {
    grid-column: 1 / -1;
    background: #1f2937;
    border-radius: 999px;
    height: 10px;
    overflow: hidden;
    margin-top: 4px;
  }
  .progress-fill {
    background: linear-gradient(90deg, #10b981, #06b6d4);
    height: 100%;
    width: 0%;
    transition: width 0.3s ease;
  }

  /* Status Filter Tabs */
  .filter-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 20px;
    border-bottom: 1px solid var(--card-border);
    padding-bottom: 12px;
  }
  .tab-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }
  .tab-btn:hover { background: #1f2937; color: #fff; }
  .tab-btn.active { background: #2563eb; color: #fff; border-color: #3b82f6; }

  /* Grid of Cards: 2 Columns on Desktop, 1 on Mobile */
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
  }
  @media (max-width: 860px) {
    .grid { grid-template-columns: 1fr; }
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 16px;
    padding: 16px;
    display: flex;
    gap: 16px;
    align-items: stretch;
    transition: all 0.2s;
    min-width: 0;
  }
  .card:hover { border-color: #3b82f6; box-shadow: 0 8px 24px -4px rgba(59, 130, 246, 0.15); }
  .card.is-paid {
    background: #091717;
    border-color: #065f46;
    opacity: 0.75;
  }

  .qr-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #fff;
    padding: 8px;
    border-radius: 12px;
    width: 135px;
    height: 135px;
    flex-shrink: 0;
  }
  .qr-img { width: 100%; height: 100%; object-fit: contain; }
  .scan-tip { font-size: 0.65rem; color: #64748b; font-weight: 700; margin-top: 4px; text-transform: uppercase; }

  .icon-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    width: 135px;
    height: 135px;
    flex-shrink: 0;
    background: #020617;
    border: 1px solid #1e293b;
    text-align: center;
    padding: 10px;
  }
  .icon-logo { font-size: 2.5rem; line-height: 1; }
  .icon-sub { font-size: 0.7rem; color: #94a3b8; font-weight: 700; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.5px; }

  .card-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  .user-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
  }
  .user-info {
    min-width: 0;
    flex: 1;
  }
  .username {
    font-size: 1.05rem;
    font-weight: 700;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge-row {
    display: flex;
    gap: 6px;
    margin-top: 4px;
    flex-wrap: wrap;
    align-items: center;
  }
  .wd-pill {
    background: #1e293b;
    color: #94a3b8;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .method-pill {
    font-size: 0.75rem;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .method-pill.upi { background: #1e1b4b; color: #a5b4fc; border: 1px solid #4338ca; }
  .method-pill.paypal { background: #082f49; color: #7dd3fc; border: 1px solid #0284c7; }
  .method-pill.gcash { background: #042f2e; color: #5eead4; border: 1px solid #0d9488; }
  .method-pill.crypto { background: #3b2a05; color: #fde047; border: 1px solid #d97706; }

  .ws-pill {
    background: #312e81;
    color: #c7d2fe;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }

  .amount-info {
    text-align: right;
    flex-shrink: 0;
  }
  .primary-amt {
    font-size: 1.35rem;
    font-weight: 800;
    color: #38bdf8;
    line-height: 1.2;
  }
  .secondary-amt {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .dest-pill {
    background: #020617;
    border: 1px dashed #334155;
    padding: 6px 8px;
    border-radius: 6px;
    font-family: monospace;
    font-size: 0.85rem;
    color: #e2e8f0;
    margin: 8px 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .dest-pill span {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .copy-btn {
    background: #1e293b;
    border: none;
    color: #94a3b8;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.75rem;
    font-weight: 600;
    flex-shrink: 0;
  }
  .copy-btn:hover { background: #334155; color: #fff; }

  .card-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
  .btn-action-primary {
    flex: 1;
    background: #2563eb;
    color: #fff;
    border: none;
    padding: 9px 12px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 700;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .btn-action-primary:hover { background: #1d4ed8; }
  .btn-action-primary.paypal-btn { background: #0070ba; }
  .btn-action-primary.paypal-btn:hover { background: #005ea6; }
  .btn-action-primary.gcash-btn { background: #0284c7; }
  .btn-action-primary.gcash-btn:hover { background: #0369a1; }
  .btn-action-primary.crypto-btn { background: #d97706; }
  .btn-action-primary.crypto-btn:hover { background: #b45309; }

  .btn-mark-paid {
    flex: 1;
    background: #059669;
    color: #fff;
    border: none;
    padding: 9px 12px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .btn-mark-paid:hover { background: #047857; }
  .btn-mark-paid:disabled { opacity: 0.5; cursor: not-allowed; }

  .paid-badge {
    background: #064e3b;
    color: #34d399;
    border: 1px solid #059669;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 700;
    text-align: center;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  /* Toast Notification */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: #1e1b4b;
    border: 1px solid #4f46e5;
    color: #fff;
    padding: 14px 20px;
    border-radius: 12px;
    font-size: 0.9rem;
    font-weight: 600;
    box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);
    display: none;
    z-index: 9999;
    animation: slideUp 0.3s ease;
  }
  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  @media (max-width: 520px) {
    .card { flex-direction: column; align-items: center; text-align: center; }
    .card-body { width: 100%; }
    .user-header { flex-direction: column; align-items: center; gap: 4px; }
    .amount-info { text-align: center; margin-top: 4px; }
    .badge-row { justify-content: center; }
    .qr-section, .icon-section { width: 160px; height: 160px; }
    .dest-pill { justify-content: center; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="header-left">
      <h1>⚡ Reddit Microtasks Payout Station</h1>
      <p>Instant payouts & notifications for UPI, PayPal, GCash and USDT (BEP-20)</p>
    </div>

    <div class="rate-box" id="rateBox">
      <div>
        <div class="rate-label">Conversion Rate: <span class="live-pill" id="livePill">● LIVE API</span></div>
        <div style="font-size: 0.75rem; color: #94a3b8; margin-top: 2px;">1 USD to INR (auto-synced)</div>
      </div>
      <input type="number" step="0.01" class="rate-input" id="rateInput" value="94.29" />
      <div class="rate-pills">
        <button class="pill-btn" id="btnLiveApi" style="background: #059669; color: #fff;" onclick="enableLiveApi()">⚡ Live API</button>
        <button class="pill-btn" onclick="setRate(88)">₹88</button>
        <button class="pill-btn" onclick="setRate(90)">₹90</button>
      </div>
    </div>
  </header>

  <!-- Method Selection Pills -->
  <div class="method-bar">
    <button class="method-tab active" id="tabMethodAll" onclick="setMethod('all')">
      <span>🌟 All Methods</span>
      <span class="count-badge" id="badgeAll">0</span>
    </button>
    <button class="method-tab" id="tabMethodUpi" onclick="setMethod('UPI')">
      <span>🇮🇳 UPI</span>
      <span class="count-badge" id="badgeUpi">0</span>
    </button>
    <button class="method-tab" id="tabMethodPaypal" onclick="setMethod('PayPal')">
      <span>🅿️ PayPal</span>
      <span class="count-badge" id="badgePaypal">0</span>
    </button>
    <button class="method-tab" id="tabMethodGcash" onclick="setMethod('GCash')">
      <span>🇵🇭 GCash</span>
      <span class="count-badge" id="badgeGcash">0</span>
    </button>
    <button class="method-tab" id="tabMethodCrypto" onclick="setMethod('USDT (BEP-20)')">
      <span>🪙 USDT</span>
      <span class="count-badge" id="badgeCrypto">0</span>
    </button>
  </div>

  <div class="stats-bar">
    <div class="stat-box">
      <span class="title" id="statQueueTitle">Pending Queue</span>
      <span class="val" id="totalCount">0</span>
    </div>
    <div class="stat-box">
      <span class="title">Pending Amount (USD)</span>
      <span class="val" style="color: #60a5fa;" id="totalUsd">$0.00</span>
    </div>
    <div class="stat-box">
      <span class="title" id="statLocalTitle">Pending Amount (INR)</span>
      <span class="val" style="color: #38bdf8;" id="totalInr">₹0.00</span>
    </div>
    <div class="stat-box">
      <span class="title">Paid Progress</span>
      <span class="val" style="color: #34d399;"><span id="paidCount">0</span> / <span id="maxCount">0</span></span>
    </div>
    <div class="progress-wrap">
      <div class="progress-fill" id="progressFill"></div>
    </div>
  </div>

  <div class="filter-tabs">
    <button class="tab-btn active" id="tabUnpaid" onclick="setFilter('pending')">Pending (To Pay)</button>
    <button class="tab-btn" id="tabAll" onclick="setFilter('all')">All Statuses</button>
    <button class="tab-btn" id="tabPaid" onclick="setFilter('approved')">Completed</button>
  </div>

  <div class="grid" id="grid"></div>

  <div class="toast" id="toast"></div>
</div>

<script>
let withdrawals = [];
let currentFilter = 'pending';
let currentMethod = 'all';
let isLiveApiMode = true;
let currentRate = 94.29;
let currentPhpRate = 58.75;

function getApiBase() {
  return window.location.pathname.replace(/\\/$/, '');
}

async function loadData() {
  try {
    const res = await fetch(getApiBase() + '/api/data');
    const data = await res.json();
    if (data.ok) {
      withdrawals = data.withdrawals;
      if (data.liveRate && isLiveApiMode) {
        currentRate = data.liveRate;
        document.getElementById('rateInput').value = currentRate;
      }
      if (data.phpRate) {
        currentPhpRate = data.phpRate;
      }
      render();
    }
  } catch (err) {
    showToast('Failed to load withdrawals data');
  }
}

function enableLiveApi() {
  isLiveApiMode = true;
  document.getElementById('livePill').style.display = 'inline-block';
  document.getElementById('btnLiveApi').style.background = '#059669';
  document.getElementById('btnLiveApi').style.color = '#fff';
  showToast('⚡ Live API rate enabled');
  loadData();
}

function setRate(val) {
  isLiveApiMode = false;
  currentRate = parseFloat(val);
  document.getElementById('rateInput').value = currentRate;
  document.getElementById('livePill').style.display = 'none';
  document.getElementById('btnLiveApi').style.background = '#1e293b';
  document.getElementById('btnLiveApi').style.color = '#e2e8f0';
  render();
}

function setMethod(m) {
  currentMethod = m;
  document.getElementById('tabMethodAll').classList.toggle('active', m === 'all');
  document.getElementById('tabMethodUpi').classList.toggle('active', m === 'UPI');
  document.getElementById('tabMethodPaypal').classList.toggle('active', m === 'PayPal');
  document.getElementById('tabMethodGcash').classList.toggle('active', m === 'GCash');
  document.getElementById('tabMethodCrypto').classList.toggle('active', m === 'USDT (BEP-20)');
  render();
}

function setFilter(f) {
  currentFilter = f;
  document.getElementById('tabUnpaid').classList.toggle('active', f === 'pending');
  document.getElementById('tabAll').classList.toggle('active', f === 'all');
  document.getElementById('tabPaid').classList.toggle('active', f === 'approved');
  render();
}

function render() {
  const rate = parseFloat(document.getElementById('rateInput').value) || 88.5;
  currentRate = rate;

  // Update method counts (pending count)
  const pendingItems = withdrawals.filter(w => w.status === 'pending');
  document.getElementById('badgeAll').textContent = pendingItems.length;
  document.getElementById('badgeUpi').textContent = pendingItems.filter(w => w.method === 'UPI').length;
  document.getElementById('badgePaypal').textContent = pendingItems.filter(w => w.method === 'PayPal').length;
  document.getElementById('badgeGcash').textContent = pendingItems.filter(w => w.method === 'GCash').length;
  document.getElementById('badgeCrypto').textContent = pendingItems.filter(w => w.method.includes('USDT')).length;

  // Filter items based on active method
  const methodItems = withdrawals.filter(w => {
    if (currentMethod === 'all') return true;
    if (currentMethod === 'USDT (BEP-20)') return w.method.includes('USDT');
    return w.method === currentMethod;
  });

  const totalUsd = methodItems.reduce((s, w) => s + parseFloat(w.amount), 0);
  const paidCount = methodItems.filter(w => w.status === 'approved').length;

  // Dynamic stat titles based on method
  if (currentMethod === 'UPI') {
    document.getElementById('statLocalTitle').textContent = 'Pending Amount (INR)';
    const pendingUpiUsd = methodItems.filter(w => w.status === 'pending').reduce((s, w) => s + parseFloat(w.amount), 0);
    document.getElementById('totalInr').textContent = '₹' + (pendingUpiUsd * rate).toFixed(2);
  } else if (currentMethod === 'GCash') {
    document.getElementById('statLocalTitle').textContent = 'Est. PHP (~₱' + currentPhpRate + ')';
    const pendingGcashUsd = methodItems.filter(w => w.status === 'pending').reduce((s, w) => s + parseFloat(w.amount), 0);
    document.getElementById('totalInr').textContent = '₱' + (pendingGcashUsd * currentPhpRate).toFixed(0);
  } else {
    document.getElementById('statLocalTitle').textContent = 'INR Value (@ ₹' + rate + ')';
    const pendingUsd = methodItems.filter(w => w.status === 'pending').reduce((s, w) => s + parseFloat(w.amount), 0);
    document.getElementById('totalInr').textContent = '₹' + (pendingUsd * rate).toFixed(2);
  }

  const pendingUsd = methodItems.filter(w => w.status === 'pending').reduce((s, w) => s + parseFloat(w.amount), 0);
  document.getElementById('totalCount').textContent = methodItems.filter(w => w.status === 'pending').length;
  document.getElementById('totalUsd').textContent = '$' + pendingUsd.toFixed(2);
  document.getElementById('paidCount').textContent = paidCount;
  document.getElementById('maxCount').textContent = methodItems.length;

  const pct = methodItems.length > 0 ? (paidCount / methodItems.length) * 100 : 0;
  document.getElementById('progressFill').style.width = pct + '%';

  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  const filtered = methodItems.filter(w => {
    if (currentFilter === 'pending') return w.status === 'pending';
    if (currentFilter === 'approved') return w.status === 'approved';
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #64748b;">No withdrawals found for this selection.</div>';
    return;
  }

  filtered.forEach(w => {
    const isPaid = w.status === 'approved';
    const usdVal = parseFloat(w.amount).toFixed(2);

    let leftColHtml = '';
    let methodBadgeClass = 'upi';
    let primaryAmtHtml = '';
    let secondaryAmtHtml = '';
    let actionBtnHtml = '';

    if (w.method === 'UPI') {
      methodBadgeClass = 'upi';
      const inrAmt = (parseFloat(w.amount) * rate).toFixed(2);
      const upiLink = \`upi://pay?pa=\${encodeURIComponent(w.destination)}&pn=\${encodeURIComponent(w.discord_username)}&am=\${inrAmt}&cu=INR&tn=\${encodeURIComponent('Payment from reddit microtasks')}\`;
      const qrUrl = \`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=\${encodeURIComponent(upiLink)}\`;
      
      leftColHtml = \`
        <div class="qr-section">
          <img class="qr-img" src="\${qrUrl}" alt="Scan UPI">
          <span class="scan-tip">\${isPaid ? 'PAID' : 'SCAN TO PAY'}</span>
        </div>
      \`;
      primaryAmtHtml = \`₹\${inrAmt}\`;
      secondaryAmtHtml = \`$\${usdVal} USD\`;
      actionBtnHtml = \`
        <a href="\${upiLink}" class="btn-action-primary" onclick="markPaidPrompt(\${w.id}, '\${w.method}', \${inrAmt})">⚡ Pay App</a>
      \`;

    } else if (w.method === 'PayPal') {
      methodBadgeClass = 'paypal';
      // PayPal send money preview link
      const ppLink = \`https://www.paypal.com/myaccount/transfer/homepage/buy/preview?recipient=\${encodeURIComponent(w.destination)}&amount=\${usdVal}&currencyCode=USD\`;
      const qrUrl = \`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=\${encodeURIComponent(w.destination)}\`;

      leftColHtml = \`
        <div class="qr-section">
          <img class="qr-img" src="\${qrUrl}" alt="PayPal Email">
          <span class="scan-tip">PAYPAL QR</span>
        </div>
      \`;
      primaryAmtHtml = \`$\${usdVal} USD\`;
      secondaryAmtHtml = \`PayPal Transfer\`;
      actionBtnHtml = \`
        <a href="\${ppLink}" target="_blank" rel="noopener" class="btn-action-primary paypal-btn" onclick="copyAndPayPrompt(\${w.id}, '\${w.destination}', 'PayPal')">⚡ Open PayPal</a>
      \`;

    } else if (w.method === 'GCash') {
      methodBadgeClass = 'gcash';
      const phpAmt = (parseFloat(w.amount) * currentPhpRate).toFixed(0);
      const qrUrl = \`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=\${encodeURIComponent(w.destination)}\`;

      leftColHtml = \`
        <div class="qr-section">
          <img class="qr-img" src="\${qrUrl}" alt="GCash Number">
          <span class="scan-tip">GCASH NUMBER</span>
        </div>
      \`;
      primaryAmtHtml = \`$\${usdVal} USD\`;
      secondaryAmtHtml = \`~₱\${phpAmt} PHP\`;
      actionBtnHtml = \`
        <button class="btn-action-primary gcash-btn" onclick="copyGcashPrompt(\${w.id}, '\${w.destination}')">📋 Copy Number</button>
      \`;

    } else if (w.method.includes('USDT')) {
      methodBadgeClass = 'crypto';
      const qrUrl = \`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=\${encodeURIComponent(w.destination)}\`;

      leftColHtml = \`
        <div class="qr-section">
          <img class="qr-img" src="\${qrUrl}" alt="Scan BEP-20 Address">
          <span class="scan-tip">SCAN ADDRESS</span>
        </div>
      \`;
      primaryAmtHtml = \`$\${usdVal} USDT\`;
      secondaryAmtHtml = \`BNB Chain (BEP-20)\`;
      actionBtnHtml = \`
        <button class="btn-action-primary crypto-btn" onclick="copyCryptoPrompt(\${w.id}, '\${w.destination}')">📋 Copy Address</button>
      \`;
    }

    const card = document.createElement('div');
    card.className = 'card ' + (isPaid ? 'is-paid' : '');
    card.id = 'card-' + w.id;

    card.innerHTML = \`
      \${leftColHtml}
      <div class="card-body">
        <div>
          <div class="user-header">
            <div class="user-info">
              <div class="username" title="\${w.discord_username}">\${w.discord_username}</div>
              <div class="badge-row">
                <span class="wd-pill">#\${w.id}</span>
                <span class="method-pill \${methodBadgeClass}">\${w.method}</span>
                \${w.workspace_channel_id ? '<span class="ws-pill">📂 Workspace Linked</span>' : ''}
              </div>
            </div>
            <div class="amount-info">
              <div class="primary-amt">\${primaryAmtHtml}</div>
              <div class="secondary-amt">\${secondaryAmtHtml}</div>
            </div>
          </div>
          
          <div class="dest-pill">
            <span title="\${w.destination}">\${w.destination}</span>
            <button class="copy-btn" onclick="copyText('\${w.destination}')" title="Copy">📋 Copy</button>
          </div>
        </div>

        <div>
          \${isPaid ? \`
            <div class="paid-badge">
              <span>✅ PAID & WORKSPACE NOTIFIED</span>
            </div>
          \` : \`
            <div class="card-actions">
              \${actionBtnHtml}
              <button class="btn-mark-paid" id="btn-\${w.id}" onclick="markPaid(\${w.id})">
                ✓ Mark as Paid
              </button>
            </div>
          \`}
        </div>
      </div>
    \`;
    grid.appendChild(card);
  });
}

function copyText(txt) {
  navigator.clipboard.writeText(txt).then(() => showToast('Copied: ' + txt));
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 3000);
}

function copyAndPayPrompt(id, email, method) {
  navigator.clipboard.writeText(email);
  showToast('Copied ' + method + ' recipient: ' + email);
}

function copyGcashPrompt(id, phone) {
  navigator.clipboard.writeText(phone);
  showToast('Copied GCash mobile: ' + phone);
}

function copyCryptoPrompt(id, addr) {
  navigator.clipboard.writeText(addr);
  showToast('Copied BEP-20 address: ' + addr.substring(0, 10) + '...');
}

function markPaidPrompt(id, method, inrAmt) {
  setTimeout(() => {
    if (confirm('Did you complete ' + method + ' payment for withdrawal #' + id + '?\\n\\nClick OK to mark as paid and notify the user in their workspace channel.')) {
      markPaid(id);
    }
  }, 1500);
}

async function markPaid(id) {
  const wd = withdrawals.find(w => w.id === id);
  if (!wd) return;

  let inrAmt = (parseFloat(wd.amount) * currentRate);
  let txHash = null;

  if (wd.method.includes('USDT')) {
    const input = prompt('Enter Transaction Hash / TxID for withdrawal #' + id + ' (optional, press OK to continue):', '');
    if (input !== null) txHash = input.trim();
  } else {
    if (!confirm('Mark withdrawal #' + id + ' (' + wd.discord_username + ' · $' + parseFloat(wd.amount).toFixed(2) + ' ' + wd.method + ') as paid?\\n\\nThis will update the database and announce payment in their workspace channel.')) {
      return;
    }
  }

  const btn = document.getElementById('btn-' + id);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Updating...';
  }

  try {
    const res = await fetch(getApiBase() + '/api/mark-paid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wdId: id,
        inrAmount: inrAmt,
        rate: currentRate,
        txHash: txHash
      })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('✅ #' + id + ' Paid! Workspace channel notified.');
      wd.status = 'approved';
      render();
    } else {
      showToast('Error: ' + data.error);
      if (btn) { btn.disabled = false; btn.textContent = '✓ Mark as Paid'; }
    }
  } catch (err) {
    showToast('Failed to update: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = '✓ Mark as Paid'; }
  }
}

document.getElementById('rateInput').addEventListener('input', (e) => {
  currentRate = parseFloat(e.target.value) || 88.5;
  localStorage.setItem('custom_rate', currentRate);
  render();
});

// Initial load
loadData();
// Auto refresh data every 30 seconds
setInterval(loadData, 30000);
</script>
</body>
</html>`);
});

export default router;
