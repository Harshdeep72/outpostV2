import express from "express";
import http from "http";
import { Client, GatewayIntentBits, TextChannel, EmbedBuilder } from "discord.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const PORT = process.env.PAYOUT_DASHBOARD_PORT || 3333;
const GUILD_ID = process.env.DISCORD_GUILD_ID || "1565314110621753495";
const WITHDRAWAL_LOG_CHANNEL_ID = "1565661347914453034";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("Missing DISCORD_BOT_TOKEN");

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

const app = express();
app.use(express.json());

// In-memory cache for live exchange rate
let cachedExchangeRate = 88.5;
let lastRateFetch = 0;

async function getLiveExchangeRate(): Promise<number> {
  if (Date.now() - lastRateFetch < 10 * 60 * 1000) {
    return cachedExchangeRate;
  }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await res.json() as any;
    if (data && data.rates && typeof data.rates.INR === "number") {
      cachedExchangeRate = parseFloat(data.rates.INR.toFixed(2));
      lastRateFetch = Date.now();
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch live exchange rate, using fallback");
  }
  return cachedExchangeRate;
}

// ──────────────────────────────────────────────────────────────────────────
// API ROUTES
// ──────────────────────────────────────────────────────────────────────────

app.get("/api/data", async (_req, res) => {
  try {
    const liveRate = await getLiveExchangeRate();

    // Fetch withdrawals from the current batch (#124 onwards)
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
    logger.error({ err }, "Error in /api/data");
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/mark-paid", async (req, res) => {
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

    const inrVal = typeof inrAmount === "number" ? inrAmount : (parseFloat(wd.amount) * (rate || 88.5));
    const usdVal = parseFloat(wd.amount).toFixed(2);
    const inrStr = inrVal.toFixed(2);

    // 2. Update Discord Log Message in #withdrawal-log
    try {
      const guild = await discordClient.guilds.fetch(GUILD_ID);
      const logChannel = (await guild.channels.fetch(WITHDRAWAL_LOG_CHANNEL_ID)) as TextChannel;
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
          const wsChannel = (await guild.channels.fetch(wd.workspace_channel_id)) as TextChannel;
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

    } catch (discErr) {
      logger.warn({ discErr }, "Discord update error during mark-paid (non-fatal)");
    }

    res.json({
      ok: true,
      message: `Withdrawal #${wd.id} marked as paid! Workspace channel and Discord log updated.`,
      inrStr,
    });
  } catch (err: any) {
    logger.error({ err }, "Error in /api/mark-paid");
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// HTML DASHBOARD INTERFACE
// ──────────────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>UPI Payout Station — Reddit Microtasks</title>
<style>
  :root {
    --bg: #090d16;
    --card-bg: #111827;
    --border: #1f2937;
    --text: #f9fafb;
    --text-muted: #9ca3af;
    --primary: #3b82f6;
    --success: #10b981;
    --warning: #f59e0b;
    --danger: #ef4444;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { background: var(--bg); color: var(--text); padding: 16px; max-width: 960px; margin: 0 auto; }
  
  header {
    background: linear-gradient(135deg, #1e1b4b 0%, #172554 100%);
    border: 1px solid #3730a3;
    border-radius: 16px;
    padding: 20px;
    margin-bottom: 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
  }
  h1 { font-size: 1.4rem; display: flex; align-items: center; gap: 8px; }
  p.sub { color: #a5b4fc; font-size: 0.85rem; margin-top: 4px; }

  .rate-panel {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .rate-panel label { font-size: 0.85rem; font-weight: 600; color: #cbd5e1; }
  .rate-input {
    background: #0f172a;
    border: 1px solid #475569;
    color: #38bdf8;
    padding: 6px 10px;
    border-radius: 8px;
    width: 80px;
    font-size: 1.1rem;
    font-weight: bold;
    text-align: center;
  }
  .presets { display: flex; gap: 6px; }
  .preset-btn {
    background: #1e293b;
    color: #e2e8f0;
    border: 1px solid #334155;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .preset-btn:hover { background: #334155; }

  .stats-bar {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
  }
  .stat-box { display: flex; flex-direction: column; }
  .stat-box .title { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-box .val { font-size: 1.25rem; font-weight: bold; margin-top: 2px; }
  .progress-wrap { width: 100%; background: #1f2937; height: 8px; border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .progress-fill { height: 100%; background: var(--success); width: 0%; transition: width 0.3s; }

  .filter-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }
  .tab-btn {
    background: #1f2937;
    color: #9ca3af;
    border: none;
    padding: 8px 14px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .tab-btn.active {
    background: var(--primary);
    color: #fff;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
    gap: 16px;
  }
  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px;
    display: flex;
    gap: 14px;
    position: relative;
    transition: transform 0.15s, border-color 0.2s;
  }
  .card:hover { border-color: #3b82f6; }
  .card.is-paid {
    border-color: #059669;
    background: linear-gradient(180deg, #111827 0%, rgba(6, 78, 59, 0.2) 100%);
  }

  .qr-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .qr-img {
    width: 130px;
    height: 130px;
    background: #fff;
    padding: 4px;
    border-radius: 10px;
  }
  .scan-tip { font-size: 0.65rem; color: #64748b; font-weight: 600; text-transform: uppercase; }

  .card-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 8px;
  }

  .user-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .username { font-size: 1.05rem; font-weight: bold; color: #fff; word-break: break-all; }
  .badge-row { display: flex; gap: 4px; margin-top: 2px; }
  .wd-pill {
    background: #374151;
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 600;
  }
  .ws-pill {
    background: rgba(99, 102, 241, 0.2);
    color: #a5b4fc;
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .amount-box {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 4px 0;
  }
  .inr-val { font-size: 1.4rem; font-weight: 900; color: #38bdf8; }
  .usd-val { font-size: 0.85rem; color: var(--text-muted); }

  .vpa-pill {
    background: #030712;
    border: 1px dashed #374151;
    padding: 6px 10px;
    border-radius: 6px;
    font-family: monospace;
    font-size: 0.85rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    word-break: break-all;
  }
  .copy-btn {
    background: none;
    border: none;
    color: #94a3b8;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 2px 4px;
  }
  .copy-btn:hover { color: #fff; }

  .card-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .btn-pay-app {
    flex: 1;
    background: #0284c7;
    color: #fff;
    text-decoration: none;
    font-size: 0.8rem;
    font-weight: bold;
    padding: 8px;
    border-radius: 8px;
    display: inline-flex;
    justify-content: center;
    align-items: center;
    gap: 4px;
  }
  .btn-pay-app:hover { background: #0369a1; }

  .btn-mark-paid {
    flex: 1;
    background: #16a34a;
    color: #fff;
    border: none;
    font-size: 0.8rem;
    font-weight: bold;
    padding: 8px;
    border-radius: 8px;
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
    align-items: center;
    gap: 4px;
    transition: background 0.2s;
  }
  .btn-mark-paid:hover { background: #15803d; }
  .btn-mark-paid:disabled { background: #065f46; cursor: not-allowed; opacity: 0.8; }

  .paid-badge {
    background: rgba(16, 185, 129, 0.2);
    border: 1px solid #10b981;
    color: #6ee7b7;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: bold;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #1e293b;
    border: 1px solid #3b82f6;
    color: #fff;
    padding: 12px 20px;
    border-radius: 10px;
    font-size: 0.9rem;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    display: none;
    z-index: 1000;
  }
</style>
</head>
<body>

<header>
  <div>
    <h1>⚡ Reddit Microtasks UPI Payout Station</h1>
    <p class="sub">Scan QR with Google Pay/PhonePe or tap "Pay via UPI App" on mobile</p>
  </div>
  <div class="rate-panel">
    <div>
      <label for="rateInput">Conversion Rate:</label>
      <div style="font-size: 0.75rem; color: #94a3b8;">1 USD to INR</div>
    </div>
    <input type="number" id="rateInput" class="rate-input" value="88.5" step="0.5">
    <div class="presets">
      <button class="preset-btn" onclick="setRate(88)">₹88</button>
      <button class="preset-btn" onclick="setRate(90)">₹90</button>
      <button class="preset-btn" onclick="fetchLiveRate()">Live API</button>
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

<script>
let withdrawals = [];
let currentFilter = 'pending';
let currentRate = 88.5;

async function loadData() {
  try {
    const res = await fetch('/api/data');
    const data = await res.json();
    if (data.ok) {
      withdrawals = data.withdrawals;
      if (data.liveRate && !localStorage.getItem('custom_rate')) {
        currentRate = data.liveRate;
        document.getElementById('rateInput').value = currentRate;
      }
      render();
    }
  } catch (err) {
    showToast('Failed to load withdrawals data');
  }
}

function setRate(val) {
  currentRate = parseFloat(val);
  document.getElementById('rateInput').value = currentRate;
  localStorage.setItem('custom_rate', currentRate);
  render();
}

async function fetchLiveRate() {
  showToast('Fetching latest live rate...');
  const res = await fetch('/api/data');
  const data = await res.json();
  if (data.liveRate) {
    setRate(data.liveRate);
    showToast('Updated to live rate: ₹' + data.liveRate);
  }
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
    const upiLink = \`upi://pay?pa=\${encodeURIComponent(w.destination)}&pn=\${encodeURIComponent(w.discord_username)}&am=\${inrAmt}&cu=INR&tn=\${encodeURIComponent('Reddit Microtasks WD#' + w.id)}\`;
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
    const res = await fetch('/api/mark-paid', {
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

// ──────────────────────────────────────────────────────────────────────────
// START SERVER
// ──────────────────────────────────────────────────────────────────────────

async function start() {
  console.log("Connecting Discord client for Payout Station...");
  await discordClient.login(token);
  console.log(`Discord logged in as ${discordClient.user?.tag}`);

  const server = http.createServer(app);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n======================================================`);
    console.log(`🚀 UPI PAYOUT STATION LIVE!`);
    console.log(`• Local URL:      http://localhost:${PORT}`);
    console.log(`• Network URL:    http://10.243.69.34:${PORT}`);
    console.log(`======================================================\n`);
  });
}

start().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
