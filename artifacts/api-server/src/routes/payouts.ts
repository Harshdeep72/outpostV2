import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { getPrimaryGuild } from "../bot/discord-client.js";
import { TextChannel, EmbedBuilder } from "discord.js";

const router: IRouter = Router();

// In-memory cache for live exchange rate
let cachedExchangeRate = 94.29;
let lastRateFetch = 0;

async function getLiveExchangeRate(): Promise<number> {
  if (Date.now() - lastRateFetch < 60 * 1000) {
    return cachedExchangeRate;
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = (await res.json()) as any;
    if (data && data.rates && typeof data.rates.INR === "number") {
      cachedExchangeRate = parseFloat(data.rates.INR.toFixed(2));
      lastRateFetch = Date.now();
      return cachedExchangeRate;
    }
  } catch (err) {
    logger.warn({ err }, "Primary exchange rate fetch failed, trying fallback");
  }

  try {
    const res2 = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
    const data2 = (await res2.json()) as any;
    if (data2 && data2.rates && typeof data2.rates.INR === "number") {
      cachedExchangeRate = parseFloat(data2.rates.INR.toFixed(2));
      lastRateFetch = Date.now();
    }
  } catch (err) {
    logger.warn({ err }, "Fallback exchange rate fetch failed, using cached");
  }

  return cachedExchangeRate;
}

// ──────────────────────────────────────────────────────────────────────────
// API ROUTES
// ──────────────────────────────────────────────────────────────────────────

router.get("/api/data", async (_req: Request, res: Response) => {
  try {
    const liveRate = await getLiveExchangeRate();

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
      liveRate,
      withdrawals: result.rows,
    });
  } catch (err: any) {
    logger.error({ err }, "Error in /payouts/api/data");
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/api/mark-paid", async (req: Request, res: Response) => {
  const { wdId, inrAmount, rate } = req.body;
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
            const updatedEmbed = EmbedBuilder.from(oldEmbed)
              .setColor(0x10b981)
              .setTitle("✅ Payout Completed")
              .addFields(
                { name: "Paid In INR", value: `₹${inrStr} (@ ₹${rate || 88.5}/$1)`, inline: true },
                { name: "Status", value: "Paid via UPI", inline: true }
              )
              .setFooter({ text: `Withdrawal #${wd.id} · Paid via Fast Station` });
            await msg.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {});
          }
        }

        // 3. Send celebratory payout message to User's Workspace Channel!
        if (wd.workspace_channel_id) {
          try {
            const wsChannel = (await guild.channels.fetch(wd.workspace_channel_id).catch(() => null)) as TextChannel | null;
            if (wsChannel) {
              const wsEmbed = new EmbedBuilder()
                .setColor(0x10b981)
                .setTitle("💸 Payout Sent!")
                .setDescription(
                  `Hey <@${wd.discord_id}>! Your weekly payout of **$${usdVal} USD** (**₹${inrStr}**) has been sent to your UPI ID!`
                )
                .addFields(
                  { name: "Amount (USD)", value: `$${usdVal}`, inline: true },
                  { name: "Amount (INR)", value: `₹${inrStr}`, inline: true },
                  { name: "Sent To", value: `\`${wd.destination}\``, inline: true },
                  { name: "Withdrawal #", value: `#${wd.id}`, inline: true },
                )
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
                    `Your payout of **$${usdVal} USD** (**₹${inrStr}**) via UPI (\`${wd.destination}\`) has been transferred!\n\nCheck your workspace channel for full details.`
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
<title>UPI Payout Station — Reddit Microtasks</title>
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
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { background: var(--bg); color: var(--text-main); min-height: 100vh; padding: 24px 16px; }
  .container { max-width: 1200px; margin: 0 auto; }

  /* Header */
  header {
    background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%);
    border: 1px solid #312e81;
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 24px;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    box-shadow: 0 10px 25px -5px rgba(0,0,0,0.4);
  }
  .header-left h1 { font-size: 1.6rem; font-weight: 800; display: flex; align-items: center; gap: 10px; color: #fff; }
  .header-left p { color: #a5b4fc; font-size: 0.9rem; margin-top: 4px; }

  .rate-box {
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid #4338ca;
    border-radius: 12px;
    padding: 12px 18px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .rate-label { font-size: 0.8rem; color: #94a3b8; font-weight: 600; text-transform: uppercase; }
  .rate-input {
    background: #020617;
    border: 1px solid #3b82f6;
    color: #38bdf8;
    font-size: 1.25rem;
    font-weight: 700;
    width: 85px;
    padding: 6px 10px;
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

  /* Summary Stats */
  .stats-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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
  .stat-box .val { font-size: 1.5rem; font-weight: 800; color: #fff; }

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

  /* Filters */
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

  /* Grid of Cards */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 18px;
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 16px;
    padding: 18px;
    display: flex;
    gap: 16px;
    transition: all 0.2s;
    position: relative;
    overflow: hidden;
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
    width: 140px;
    height: 140px;
    flex-shrink: 0;
  }
  .qr-img { width: 100%; height: 100%; object-fit: contain; }
  .scan-tip { font-size: 0.65rem; color: #64748b; font-weight: 700; margin-top: 4px; text-transform: uppercase; }

  .card-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }

  .user-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .username { font-size: 1.1rem; font-weight: 700; color: #fff; }
  .badge-row { display: flex; gap: 6px; margin-top: 4px; }
  .wd-pill {
    background: #1e293b;
    color: #94a3b8;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .ws-pill {
    background: #312e81;
    color: #c7d2fe;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .inr-val { font-size: 1.35rem; font-weight: 800; color: #38bdf8; }
  .usd-val { font-size: 0.8rem; color: var(--text-muted); }

  .vpa-pill {
    background: #020617;
    border: 1px dashed #334155;
    padding: 6px 8px;
    border-radius: 6px;
    font-family: monospace;
    font-size: 0.85rem;
    color: #e2e8f0;
    word-break: break-all;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 4px;
    margin: 8px 0;
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
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 6px;
  }
  .btn-pay-app {
    background: #2563eb;
    color: #fff;
    border: none;
    padding: 9px 10px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 700;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: background 0.15s;
  }
  .btn-pay-app:hover { background: #1d4ed8; }

  .btn-mark-paid {
    background: #059669;
    color: #fff;
    border: none;
    padding: 9px 10px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
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

  @media (max-width: 600px) {
    .card { flex-direction: column; align-items: center; text-align: center; }
    .user-header { flex-direction: column; align-items: center; gap: 4px; }
    .badge-row { justify-content: center; }
    .qr-section { width: 180px; height: 180px; }
    .vpa-pill { justify-content: center; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="header-left">
      <h1>⚡ Reddit Microtasks UPI Payout Station</h1>
      <p>Scan QR with Google Pay/PhonePe or tap "Pay via UPI App" on mobile</p>
    </div>

    <div class="rate-box">
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

  <div class="stats-bar">
    <div class="stat-box">
      <span class="title">Total UPI Queue</span>
      <span class="val" id="totalCount">0</span>
    </div>
    <div class="stat-box">
      <span class="title">Total Amount (USD)</span>
      <span class="val" style="color: #60a5fa;" id="totalUsd">$0.00</span>
    </div>
    <div class="stat-box">
      <span class="title">Total Amount (INR)</span>
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
    <button class="tab-btn" id="tabAll" onclick="setFilter('all')">All Withdrawals</button>
    <button class="tab-btn" id="tabPaid" onclick="setFilter('approved')">Completed</button>
  </div>

  <div class="grid" id="grid"></div>

  <div class="toast" id="toast"></div>
</div>

<script>
let withdrawals = [];
let currentFilter = 'pending';
let isLiveApiMode = true;
let currentRate = 94.29;

function getApiBase() {
  const p = window.location.pathname.replace(/\\/$/, '');
  return p;
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

function setFilter(f) {
  currentFilter = f;
  document.getElementById('tabUnpaid').classList.toggle('active', f === 'pending');
  document.getElementById('tabAll').classList.toggle('active', f === 'all');
  document.getElementById('tabPaid').classList.toggle('active', f === 'approved');
  render();
}

function render() {
  const upiItems = withdrawals.filter(w => w.method === 'UPI');
  const rate = parseFloat(document.getElementById('rateInput').value) || 88.5;
  currentRate = rate;

  const totalUsd = upiItems.reduce((s, w) => s + parseFloat(w.amount), 0);
  const totalInr = totalUsd * rate;
  const paidCount = upiItems.filter(w => w.status === 'approved').length;

  document.getElementById('totalCount').textContent = upiItems.length;
  document.getElementById('totalUsd').textContent = '$' + totalUsd.toFixed(2);
  document.getElementById('totalInr').textContent = '₹' + totalInr.toFixed(2);
  document.getElementById('paidCount').textContent = paidCount;
  document.getElementById('maxCount').textContent = upiItems.length;
  const pct = upiItems.length > 0 ? (paidCount / upiItems.length) * 100 : 0;
  document.getElementById('progressFill').style.width = pct + '%';

  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  const filtered = upiItems.filter(w => {
    if (currentFilter === 'pending') return w.status === 'pending';
    if (currentFilter === 'approved') return w.status === 'approved';
    return true;
  });

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px; color: #64748b;">No withdrawals found in this tab.</div>';
    return;
  }

  filtered.forEach(w => {
    const isPaid = w.status === 'approved';
    const inrAmt = (parseFloat(w.amount) * rate).toFixed(2);
    const upiLink = \`upi://pay?pa=\${encodeURIComponent(w.destination)}&pn=\${encodeURIComponent(w.discord_username)}&am=\${inrAmt}&cu=INR&tn=\${encodeURIComponent('Payment from reddit microtasks')}\`;
    const qrUrl = \`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=\${encodeURIComponent(upiLink)}\`;

    const card = document.createElement('div');
    card.className = 'card ' + (isPaid ? 'is-paid' : '');
    card.id = 'card-' + w.id;

    card.innerHTML = \`
      <div class="qr-section">
        <img class="qr-img" src="\${qrUrl}" alt="Scan to pay">
        <span class="scan-tip">\${isPaid ? 'PAID' : 'SCAN TO PAY'}</span>
      </div>
      <div class="card-body">
        <div>
          <div class="user-header">
            <div>
              <div class="username">\${w.discord_username}</div>
              <div class="badge-row">
                <span class="wd-pill">#\${w.id}</span>
                \${w.workspace_channel_id ? '<span class="ws-pill">📂 Workspace Linked</span>' : ''}
              </div>
            </div>
            <div style="text-align: right;">
              <div class="inr-val">₹\${inrAmt}</div>
              <div class="usd-val">$\${parseFloat(w.amount).toFixed(2)} USD</div>
            </div>
          </div>
          
          <div class="vpa-pill" style="margin-top: 8px;">
            <span>\${w.destination}</span>
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
              <a href="\${upiLink}" class="btn-pay-app" onclick="markPaidPrompt(\${w.id}, \${inrAmt})">⚡ Pay App</a>
              <button class="btn-mark-paid" id="btn-\${w.id}" onclick="markPaid(\${w.id}, \${inrAmt})">
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

function markPaidPrompt(id, inrAmt) {
  setTimeout(() => {
    if (confirm('Did you complete payment of ₹' + inrAmt + ' for withdrawal #' + id + '?\\n\\nClick OK to mark as paid and notify the user in their workspace channel.')) {
      markPaid(id, inrAmt);
    }
  }, 1500);
}

async function markPaid(id, inrAmt) {
  const btn = document.getElementById('btn-' + id);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Updating...';
  }

  try {
    const res = await fetch(getApiBase() + '/api/mark-paid', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wdId: id, inrAmount: parseFloat(inrAmt), rate: currentRate })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('✅ #' + id + ' Paid! Workspace channel notified.');
      const wd = withdrawals.find(w => w.id === id);
      if (wd) wd.status = 'approved';
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
