// Wallet + Profile + Leaderboard card renderer.
//
// SAFETY CONTRACT (do not relax):
//  - Every public function in this file MUST be fully wrapped in try/catch
//    by the CALLER. If anything in here throws (font missing, OOM, broken
//    avatar URL, etc.) the caller falls back to the original embed reply.
//  - Pure rendering only. NO database access, NO Discord API calls, NO
//    network side-effects beyond fetching the avatar image (best-effort —
//    failure draws a placeholder, never throws).
//  - Returns a PNG Buffer. Caller attaches it to the Discord reply.
//
// Renderer: @napi-rs/canvas (Skia-backed, prebuilt binary, no system deps).
//
// Visual style: "Dash Zinc" — matches the dashboard website palette
// (zinc-950 bg, zinc-900 cards, zinc-800 borders, near-white text, mono
// accent text). Restrained, looks like a serious tool.
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { logger } from "../lib/logger.js";

const W = 900;
const H = 470;

// Dashboard palette (mirrors artifacts/dashboard/src/index.css).
const C = {
  bg: "#09090b",        // zinc-950
  card: "#18181b",      // zinc-900
  border: "#27272a",    // zinc-800
  text: "#fafafa",      // near-white
  muted: "#71717a",     // zinc-500
  accent: "#a1a1aa",    // zinc-400 (mono accent)
  accentStrong: "#e4e4e7", // zinc-200
  good: "#a3e635",      // lime-400 — only for status/success accents
  danger: "#f87171",    // red-400 — only for flagged/destructive
  gold: "#fbbf24",      // for #1 rank only
};

// ───────────────────── primitive helpers ─────────────────────

function roundedRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBackground(ctx: SKRSContext2D): void {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
}

// Top strip: breadcrumb on the left, status pill on the right, hairline divider.
function drawTopStrip(ctx: SKRSContext2D, breadcrumb: string, status: string, statusColor = C.good): void {
  ctx.save();
  ctx.font = "12px monospace";
  ctx.fillStyle = C.muted;
  ctx.fillText(breadcrumb, 30, 38);
  ctx.font = "bold 11px monospace";
  ctx.fillStyle = statusColor;
  ctx.textAlign = "right";
  ctx.fillText(status, W - 30, 38);
  ctx.textAlign = "start";
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 60);
  ctx.lineTo(W, 60);
  ctx.stroke();
  ctx.restore();
}

function drawText(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  opts: { font: string; color: string; align?: CanvasTextAlign; maxWidth?: number; baseline?: CanvasTextBaseline },
): void {
  ctx.save();
  ctx.font = opts.font;
  ctx.fillStyle = opts.color;
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = opts.baseline ?? "alphabetic";
  if (opts.maxWidth) ctx.fillText(text, x, y, opts.maxWidth);
  else ctx.fillText(text, x, y);
  ctx.restore();
}

async function drawAvatar(
  ctx: SKRSContext2D,
  url: string | null,
  initial: string,
  x: number,
  y: number,
  size: number,
): Promise<void> {
  // Soft border ring
  ctx.save();
  ctx.fillStyle = C.border;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2 + 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();

  let drewImage = false;
  if (url) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const img = await loadImage(buf);
        ctx.drawImage(img, x, y, size, size);
        drewImage = true;
      }
    } catch (err) {
      logger.debug({ err, url }, "avatar fetch failed; using placeholder");
    }
  }

  if (!drewImage) {
    // Mono fallback disc with initial.
    const g = ctx.createLinearGradient(x, y, x + size, y + size);
    g.addColorStop(0, "#3f3f46");
    g.addColorStop(1, "#18181b");
    ctx.fillStyle = g;
    ctx.fillRect(x, y, size, size);
    ctx.restore();
    ctx.save();
    ctx.fillStyle = C.text;
    ctx.font = `bold ${Math.floor(size * 0.42)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(initial.toUpperCase(), x + size / 2, y + size / 2 + 2);
  }
  ctx.restore();
}

// Card with thin border + slightly elevated bg.
function drawCard(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r = 10): void {
  roundedRect(ctx, x, y, w, h, r);
  ctx.fillStyle = C.card;
  ctx.fill();
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawWordmark(ctx: SKRSContext2D): void {
  drawText(ctx, "OUTPOST BOT", W - 30, H - 18, {
    font: "bold 10px monospace", color: C.muted, align: "right",
  });
}

function drawUpdatedAt(ctx: SKRSContext2D, label: string): void {
  drawText(ctx, label, 30, H - 18, {
    font: "10px monospace", color: C.muted,
  });
}

// ───────────────────── public renderers ─────────────────────

export interface WalletCardData {
  username: string;
  avatarUrl: string | null;
  redditUsername: string | null;
  verified: boolean;
  available: string;
  pending: string;
  earned: string;
  weekTotal: string;
  weekCount: number;
  lifeCount: number;
  trustScore: number;
  trustBadge: string;
  streakLabel: string;
  nextPayoutLabel: string;
  flagged: boolean;
}

export async function renderWalletCard(d: WalletCardData): Promise<Buffer> {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx);
  drawTopStrip(
    ctx,
    "outpost › wallet",
    d.flagged ? "● FLAGGED" : "● ONLINE",
    d.flagged ? C.danger : C.good,
  );

  // Header: title + subtitle, avatar pinned top-right.
  drawText(ctx, "Wallet", 30, 100, { font: "bold 22px sans-serif", color: C.text });
  const sub =
    `${d.username}` +
    (d.redditUsername ? ` · u/${d.redditUsername}` : "") +
    (d.verified ? " · verified" : "");
  drawText(ctx, sub, 30, 122, { font: "13px sans-serif", color: C.muted, maxWidth: 700 });

  await drawAvatar(ctx, d.avatarUrl, d.username[0] ?? "?", W - 100, 80, 60);

  // Big card: balance.
  drawCard(ctx, 30, 150, 540, 200, 12);
  drawText(ctx, "AVAILABLE", 50, 180, { font: "bold 11px monospace", color: C.muted });
  drawText(ctx, d.available, 50, 250, { font: "bold 64px sans-serif", color: C.text });
  drawText(ctx, `+ ${d.weekTotal} this week`, 50, 285, {
    font: "bold 13px monospace", color: C.accentStrong,
  });
  drawText(ctx, `Next payout · ${d.nextPayoutLabel}`, 50, 320, {
    font: "12px sans-serif", color: C.muted,
  });

  // Right column: 3 small stat cards.
  const small = [
    { l: "PENDING", v: d.pending },
    { l: "LIFETIME", v: d.earned },
    { l: "TRUST", v: `${d.trustScore} / 100` },
  ];
  small.forEach((s, i) => {
    const y = 150 + i * 67;
    drawCard(ctx, 590, y, 280, 60, 10);
    drawText(ctx, s.l, 605, y + 22, { font: "10px monospace", color: C.muted });
    drawText(ctx, s.v, 855, y + 38, {
      font: "bold 22px sans-serif", color: C.text, align: "right", maxWidth: 240,
    });
  });

  // Bottom strip.
  drawCard(ctx, 30, 370, 840, 50, 10);
  const streakDisplay = d.streakLabel === "—" ? "no streak" : d.streakLabel;
  const bottomLine =
    `${streakDisplay} · ${d.weekCount} task${d.weekCount === 1 ? "" : "s"} this week · ` +
    `${d.lifeCount} lifetime · ${d.trustBadge}`;
  drawText(ctx, bottomLine, 50, 400, {
    font: "13px sans-serif", color: C.text, maxWidth: 800,
  });

  // Flagged warning bar overrides bottom row's clean look.
  if (d.flagged) {
    ctx.save();
    ctx.fillStyle = "rgba(248, 113, 113, 0.12)";
    roundedRect(ctx, 30, 370, 840, 50, 10);
    ctx.fill();
    ctx.strokeStyle = C.danger;
    ctx.stroke();
    drawText(ctx, "⚠ Account flagged — contact an admin", W / 2, 400, {
      font: "bold 13px sans-serif", color: C.danger, align: "center",
    });
    ctx.restore();
  }

  drawUpdatedAt(ctx, "Updated just now");
  drawWordmark(ctx);

  return canvas.toBuffer("image/png");
}

export interface ProfileCardData {
  username: string;
  avatarUrl: string | null;
  redditUsername: string;
  ageDays: number;
  postKarma: number;
  commentKarma: number;
  totalKarma: number;
  trustScore: number;
  flagged: boolean;
  available: string;
  pending: string;
  earned: string;
  freshenedNow: boolean;
}

export async function renderProfileCard(d: ProfileCardData): Promise<Buffer> {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx);
  drawTopStrip(
    ctx,
    "outpost › profile",
    d.flagged ? "🚩 FLAGGED" : "✓ VERIFIED",
    d.flagged ? C.danger : C.good,
  );

  // Avatar + name row.
  await drawAvatar(ctx, d.avatarUrl, d.username[0] ?? "?", 30, 90, 90);
  drawText(ctx, d.username, 140, 130, { font: "bold 26px sans-serif", color: C.text, maxWidth: 720 });
  drawText(ctx, `u/${d.redditUsername} · reddit ${d.ageDays.toLocaleString()}d old`, 140, 152, {
    font: "13px sans-serif", color: C.muted, maxWidth: 720,
  });

  // Trust pill.
  ctx.save();
  roundedRect(ctx, 140, 165, 130, 26, 6);
  ctx.fillStyle = C.card;
  ctx.fill();
  ctx.strokeStyle = C.accent;
  ctx.stroke();
  drawText(ctx, `TRUST ${d.trustScore}/100`, 152, 183, {
    font: "bold 11px monospace", color: C.accentStrong,
  });
  ctx.restore();

  // 3 karma cards.
  const stats = [
    { l: "POST KARMA", v: d.postKarma.toLocaleString() },
    { l: "COMMENT KARMA", v: d.commentKarma.toLocaleString() },
    { l: "TOTAL KARMA", v: d.totalKarma.toLocaleString() },
  ];
  stats.forEach((s, i) => {
    const x = 30 + i * 280, y = 215;
    drawCard(ctx, x, y, 270, 90, 10);
    drawText(ctx, s.l, x + 18, y + 26, { font: "10px monospace", color: C.muted });
    drawText(ctx, s.v, x + 18, y + 68, {
      font: "bold 30px sans-serif", color: C.text, maxWidth: 240,
    });
  });

  // Wallet glance strip.
  drawCard(ctx, 30, 325, 840, 60, 10);
  drawText(ctx, "WALLET", 50, 348, { font: "10px monospace", color: C.muted });
  drawText(ctx, d.available, 110, 365, { font: "bold 18px sans-serif", color: C.text });
  drawText(ctx, `available · ${d.pending} pending · ${d.earned} lifetime`, 220, 365, {
    font: "13px sans-serif", color: C.muted, maxWidth: 640,
  });

  // Flagged overlay.
  if (d.flagged) {
    ctx.save();
    ctx.fillStyle = "rgba(248, 113, 113, 0.12)";
    roundedRect(ctx, 30, 395, 840, 30, 8);
    ctx.fill();
    ctx.strokeStyle = C.danger;
    ctx.stroke();
    drawText(ctx, "⚠ Account flagged — contact an admin", W / 2, 415, {
      font: "bold 12px sans-serif", color: C.danger, align: "center",
    });
    ctx.restore();
  }

  drawUpdatedAt(
    ctx,
    d.freshenedNow ? "karma refreshed from reddit just now" : "karma as of last verification",
  );
  drawWordmark(ctx);

  return canvas.toBuffer("image/png");
}

// ───────────────────── leaderboard ─────────────────────

export interface LeaderboardRow {
  rank: number;             // 1-based (global rank across all pages)
  username: string;         // discord username for display
  amount: string;           // formatted money like "$247.50"
  isYou?: boolean;          // optional highlight
  isZero?: boolean;         // backfilled placeholder ($0.00) — render muted
  acceptRate?: string;      // e.g. "98%" — shown under amount when present
  tier?: "Gold" | "Silver" | "Bronze" | "Verified" | "Earner"; // visual badge
}

export interface LeaderboardCardData {
  weekRangeLabel: string;   // e.g. "Week of May 12 → May 18"
  rows: LeaderboardRow[];   // rows for THIS page only (max ~10)
  lastWinnerLabel: string | null; // e.g. "smoky · $312.00 last week"
  totalEarners: number;     // across the week (for footer)
  totalPaid: string;        // total paid this week
  page?: number;            // 1-based, defaults to 1
  totalPages?: number;      // defaults to 1
}

export async function renderLeaderboardCard(d: LeaderboardCardData): Promise<Buffer> {
  // New vertical pill-style design (720x1280, 9:16 mobile-friendly). The
  // earlier horizontal "Dash Zinc" layout is replaced with purple pills +
  // green USD amounts + tier badges + accept-rate, paginated. Caller is
  // responsible for slicing `rows` to the current page.
  const LW = 720, LH = 1280;
  const lcanvas = createCanvas(LW, LH);
  const lctx = lcanvas.getContext("2d");

  // Background gradient — deep navy, easier on the eye on mobile than pure black.
  const bg = lctx.createLinearGradient(0, 0, 0, LH);
  bg.addColorStop(0, "#0b0b14");
  bg.addColorStop(1, "#06060c");
  lctx.fillStyle = bg;
  lctx.fillRect(0, 0, LW, LH);

  // Local helpers scoped to this renderer (don't touch the existing global
  // primitives so other cards stay byte-for-byte identical).
  function lrr(x: number, y: number, w: number, h: number, r: number): void {
    lctx.beginPath();
    lctx.moveTo(x + r, y);
    lctx.arcTo(x + w, y, x + w, y + h, r);
    lctx.arcTo(x + w, y + h, x, y + h, r);
    lctx.arcTo(x, y + h, x, y, r);
    lctx.arcTo(x, y, x + w, y, r);
    lctx.closePath();
  }
  function lt(s: string, x: number, y: number, opt: { f: string; c: string; a?: CanvasTextAlign; b?: CanvasTextBaseline }): void {
    lctx.font = opt.f;
    lctx.fillStyle = opt.c;
    lctx.textAlign = opt.a ?? "left";
    lctx.textBaseline = opt.b ?? "alphabetic";
    lctx.fillText(s, x, y);
  }
  function trunc(s: string, font: string, maxW: number): string {
    lctx.font = font;
    if (lctx.measureText(s).width <= maxW) return s;
    let cur = s;
    while (cur.length > 1 && lctx.measureText(cur + "…").width > maxW) cur = cur.slice(0, -1);
    return cur + "…";
  }

  // Header.
  lt("★", 40, 80, { f: "bold 38px sans-serif", c: "#fbbf24" });
  lt("Weekly Earnings Leaderboard", 84, 78, { f: "bold 32px sans-serif", c: "#fafafa" });
  lt(`Top Reddit Task Earners · ${d.weekRangeLabel}`, 40, 118, { f: "18px sans-serif", c: "#a1a1aa" });

  // Empty-state shortcut.
  if (d.rows.length === 0) {
    lt("No earners on the board yet — be the first!", LW / 2, LH / 2, {
      f: "20px sans-serif", c: "#a1a1aa", a: "center", b: "middle",
    });
    lt("OUTPOST BOT", LW - 40, LH - 30, { f: "bold 12px monospace", c: "#52525b", a: "right" });
    return lcanvas.toBuffer("image/png");
  }

  // Body rows.
  const N = Math.min(d.rows.length, 10);
  const ROW_H = 100, GAP = 16, startY = 170;
  const LEFT_X = 30, LEFT_W = 410;
  const RIGHT_X = LEFT_X + LEFT_W + 12, RIGHT_W = LW - RIGHT_X - 30;

  for (let i = 0; i < N; i++) {
    const r = d.rows[i]!;
    const y = startY + i * (ROW_H + GAP);
    const cy = y + ROW_H / 2;
    const isGold = r.rank === 1 && !r.isZero;

    // LEFT pill — gold gradient for #1, purple gradient for everyone else.
    // Zero-amount (backfill) rows get a muted purple so they don't look like
    // real earners.
    const leftGrad = lctx.createLinearGradient(LEFT_X, y, LEFT_X + LEFT_W, y);
    if (isGold) {
      leftGrad.addColorStop(0, "#fcd34d"); leftGrad.addColorStop(1, "#f59e0b");
    } else if (r.isZero) {
      leftGrad.addColorStop(0, "#4c1d95"); leftGrad.addColorStop(1, "#3b1370");
    } else {
      leftGrad.addColorStop(0, "#8b5cf6"); leftGrad.addColorStop(1, "#6d28d9");
    }
    lctx.fillStyle = leftGrad;
    lrr(LEFT_X, y, LEFT_W, ROW_H, ROW_H / 2);
    lctx.fill();

    // "You" outline for caller-highlighted row.
    if (r.isYou) {
      lctx.save();
      lctx.strokeStyle = "#a3e635";
      lctx.lineWidth = 3;
      lrr(LEFT_X, y, LEFT_W, ROW_H, ROW_H / 2);
      lctx.stroke();
      lctx.restore();
    }

    // Rank disc on the left edge of the pill.
    const rcx = LEFT_X + 52, rcy = cy;
    lctx.fillStyle = isGold ? "#1f1300" : "rgba(0,0,0,0.35)";
    lctx.beginPath();
    lctx.arc(rcx, rcy, 34, 0, Math.PI * 2);
    lctx.fill();
    if (r.rank <= 3 && !r.isZero) {
      const labelColor = r.rank === 1 ? "#fbbf24" : r.rank === 2 ? "#d4d4d8" : "#f97316";
      lt("TOP", rcx, rcy - 12, { f: "bold 10px sans-serif", c: labelColor, a: "center", b: "middle" });
      lt(`#${r.rank}`, rcx, rcy + 12, { f: "bold 20px monospace", c: "#fafafa", a: "center", b: "middle" });
    } else {
      lt(`#${r.rank}`, rcx, rcy + 2, { f: "bold 22px monospace", c: "#fafafa", a: "center", b: "middle" });
    }

    // Username + subtitle.
    const nameColor = isGold ? "#1a1206" : "#ffffff";
    const subColor  = isGold ? "#3f2e08" : r.isZero ? "#c4b5fd" : "#e9d5ff";
    const subText   = r.isZero ? "Career earner" : (r.tier === "Gold" ? "Elite Earner" : r.tier === "Silver" || r.tier === "Bronze" ? "Pro Earner" : "Verified Earner");
    const nameMax   = LEFT_W - 100 - 90;
    lt(trunc(r.username, "bold 26px sans-serif", nameMax), rcx + 50, rcy - 8, {
      f: "bold 26px sans-serif", c: nameColor, b: "middle",
    });
    lt(subText, rcx + 50, rcy + 20, { f: "15px sans-serif", c: subColor, b: "middle" });

    // Tier badge — pinned to the right end of the pill.
    const tierLabel = r.tier ?? (r.isZero ? "Earner" : "Verified");
    lctx.font = "bold 12px sans-serif";
    const tbW = lctx.measureText(tierLabel).width + 22;
    const tbX = LEFT_X + LEFT_W - tbW - 20, tbY = cy - 13;
    lctx.fillStyle =
      tierLabel === "Gold"     ? "#facc15" :
      tierLabel === "Silver"   ? "#d4d4d8" :
      tierLabel === "Bronze"   ? "#b45309" :
      tierLabel === "Verified" ? "#312e81" :
                                 "#3b3654";
    lrr(tbX, tbY, tbW, 26, 13);
    lctx.fill();
    lt(tierLabel, tbX + tbW / 2, tbY + 17, {
      f: "bold 12px sans-serif",
      c: tierLabel === "Gold" || tierLabel === "Silver" || tierLabel === "Bronze" ? "#0b0b14" : "#fafafa",
      a: "center",
    });

    // RIGHT pill — dark, USD amount + accept-rate.
    lctx.fillStyle = "#1c1c28";
    lrr(RIGHT_X, y, RIGHT_W, ROW_H, ROW_H / 2);
    lctx.fill();

    const amountColor = r.isZero ? "#52525b" : "#4ade80";
    lt(r.amount, RIGHT_X + RIGHT_W / 2, cy - (r.acceptRate ? 6 : 0), {
      f: "bold 28px monospace", c: amountColor, a: "center", b: "middle",
    });
    if (r.acceptRate) {
      lt(`${r.acceptRate} accept rate`, RIGHT_X + RIGHT_W / 2, cy + 22, {
        f: "13px sans-serif", c: "#a1a1aa", a: "center", b: "middle",
      });
    }
  }

  // Footer.
  const fy = startY + N * (ROW_H + GAP) + 24;
  const page = d.page ?? 1, totalPages = d.totalPages ?? 1;
  const footerLine = totalPages > 1
    ? `Page ${page} of ${totalPages}  ·  ${d.totalEarners} earner${d.totalEarners === 1 ? "" : "s"} this week  ·  ${d.totalPaid} paid out`
    : `${d.totalEarners} earner${d.totalEarners === 1 ? "" : "s"} this week  ·  ${d.totalPaid} paid out  ·  Updated just now`;
  lt(footerLine, LW / 2, Math.min(fy, LH - 50), {
    f: "15px sans-serif", c: "#a1a1aa", a: "center",
  });
  lt("OUTPOST BOT", LW - 40, LH - 30, { f: "bold 12px monospace", c: "#52525b", a: "right" });

  return lcanvas.toBuffer("image/png");
}

// ──────────────────────────────────────────────────────────────────────
// /sendstats — per-user stats card (PNG)
//
// SAFETY: all inputs are pre-computed strings/numbers from the caller.
// This function does NOT read the DB, does NOT touch Discord, does NOT
// compute money. The caller maps real database values into StatsCardData
// — there is no path here that can invent earnings or change a balance.
// Any throw is caught by the caller and falls back to the embed reply.
// ──────────────────────────────────────────────────────────────────────

export type StatsCardStatus = "cleared" | "hold" | "pending" | "rejected";
export type StatsCardLive = "live" | "removed" | "deleted" | "unknown";

export interface StatsCardRecentRow {
  status: StatsCardStatus;
  live: StatsCardLive;
  title: string;
  reward: string; // pre-formatted "$0.15"
  when: string;   // pre-formatted "clears in 4d" / "cleared 2d ago" / etc.
}

export interface StatsCardData {
  username: string;
  generatedAt: Date;
  available: string;  // pre-formatted "$0.00"
  pending: string;
  lifetime: string;
  activeClaims: number;
  counts7d: {
    total: number;
    cleared: number;
    hold: number;
    pending: number;
    rejected: number;
    removed: number;
  };
  recent: StatsCardRecentRow[]; // already sliced to render-able count
  payments: { paypal: boolean; upi: boolean; crypto: boolean };
  // Optional: when present, the stat strip + recent-subs header label
  // change from "Last 7 days" to e.g. "Last 21 days". Counts in counts7d
  // are interpreted as the totals for THIS window regardless of the
  // historical field name. Defaults to 7 for backward compatibility.
  windowDays?: number;
  // Optional: when present, shown in the recent-subs header right so a
  // paginated card reads e.g. "Page 2 of 4 · 14 of 47 · newest first".
  pageInfo?: { page: number; totalPages: number };
}

// Extra palette entries scoped to the stats card (the existing wallet
// renderer's C object only has good/danger/gold accents — these are
// additive, never modify the existing exported palette).
const SC = {
  warn: "#fbbf24",
  info: "#7dd3fc",
  bad:  "#f87171",
  cardAlt:    "#1c1c1f",
  borderSoft: "#202023",
  dim:        "#52525b",
};

function scRoundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function scFillRound(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number, color: string): void {
  ctx.fillStyle = color;
  scRoundRect(ctx, x, y, w, h, r);
  ctx.fill();
}
function scStrokeRound(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number, color: string, lineW = 1): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  scRoundRect(ctx, x, y, w, h, r);
  ctx.stroke();
}
function scText(ctx: SKRSContext2D, str: string, x: number, y: number, opts: {
  font: string; color: string; align?: CanvasTextAlign; baseline?: CanvasTextBaseline;
}): void {
  ctx.fillStyle = opts.color;
  ctx.font = opts.font;
  ctx.textAlign = opts.align ?? "left";
  ctx.textBaseline = opts.baseline ?? "alphabetic";
  ctx.fillText(str, x, y);
}
function scTrunc(ctx: SKRSContext2D, str: string, font: string, maxW: number): string {
  ctx.font = font;
  if (ctx.measureText(str).width <= maxW) return str;
  let s = str;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

const STATUS_META: Record<StatsCardStatus, { dot: string; label: string }> = {
  cleared:  { dot: C.good, label: "CLEARED"  },
  hold:     { dot: SC.warn, label: "IN HOLD" },
  pending:  { dot: SC.info, label: "REVIEW"  },
  rejected: { dot: SC.bad,  label: "REJECTED"},
};
const LIVE_META: Record<StatsCardLive, { color: string; label: string }> = {
  live:    { color: C.good,    label: "LIVE"    },
  removed: { color: SC.bad,    label: "REMOVED" },
  deleted: { color: C.accent,  label: "DELETED" },
  unknown: { color: SC.dim,    label: "—"       },
};

export function renderStatsCard(d: StatsCardData): Buffer {
  const SW = 900;
  const PAD = 28;
  const TILE_GAP = 14;
  const TILE_H = 110;
  const STRIP_H = 64;
  const ROW_H = 36;
  const HEADER_H = 78;
  const FOOTER_H = 60;
  // Hard-cap recent rows so the card height stays bounded even if the
  // caller forgets to slice. 14 rows × 36 ≈ 504px — comfortable on Discord.
  const recent = d.recent.slice(0, 14);
  const tableH = 14 + recent.length * ROW_H + (recent.length === 0 ? 30 : 14);
  const SH = HEADER_H + PAD + TILE_H + 18 + STRIP_H + 22 + 30 + tableH + 18 + FOOTER_H + PAD;

  const canvas = createCanvas(SW, SH);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, SW, SH);

  // Header
  scText(ctx, "Task Stats", PAD, 48, { font: "bold 28px sans-serif", color: C.text });
  const subStr = `@${d.username}  ·  ${d.generatedAt.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
  })} UTC`;
  scText(ctx, subStr, PAD, 70, { font: "13px sans-serif", color: C.muted });
  const snapTxt = "LIVE SNAPSHOT";
  scText(ctx, snapTxt, SW - PAD, 48, { font: "bold 11px monospace", color: C.muted, align: "right" });
  ctx.font = "bold 11px monospace";
  ctx.fillStyle = C.good;
  ctx.beginPath();
  ctx.arc(SW - PAD - ctx.measureText(snapTxt).width - 12, 44, 4, 0, Math.PI * 2);
  ctx.fill();
  scText(ctx, "Pulled directly from your wallet", SW - PAD, 70, {
    font: "12px sans-serif", color: SC.dim, align: "right",
  });

  // Divider
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, HEADER_H);
  ctx.lineTo(SW - PAD, HEADER_H);
  ctx.stroke();

  let y = HEADER_H + PAD;

  // Balance tiles
  const tileCount = 3;
  const tileW = Math.floor((SW - PAD * 2 - TILE_GAP * (tileCount - 1)) / tileCount);
  const drawTile = (x: number, ty: number, label: string, value: string, sub: string, accent: string) => {
    scFillRound(ctx, x, ty, tileW, TILE_H, 10, C.card);
    scStrokeRound(ctx, x, ty, tileW, TILE_H, 10, C.border);
    ctx.fillStyle = accent;
    scRoundRect(ctx, x, ty, tileW, 3, 10);
    ctx.fill();
    scText(ctx, label, x + 18, ty + 28, { font: "bold 11px monospace", color: C.muted });
    scText(ctx, value, x + 18, ty + 78, { font: "bold 36px sans-serif", color: C.text });
    scText(ctx, sub,   x + 18, ty + 98, { font: "12px sans-serif", color: SC.dim });
  };
  drawTile(PAD + 0 * (tileW + TILE_GAP), y, "AVAILABLE TO WITHDRAW", d.available, "Cash out anytime with /withdraw", C.good);
  drawTile(PAD + 1 * (tileW + TILE_GAP), y, "PENDING (HOLD)",        d.pending,   "Clears automatically when hold ends", SC.warn);
  drawTile(PAD + 2 * (tileW + TILE_GAP), y, "LIFETIME EARNED",       d.lifetime,
    `${d.activeClaims} task${d.activeClaims === 1 ? "" : "s"} currently claimed`, C.accent);
  y += TILE_H + 18;

  // N-day stat strip (label adapts to d.windowDays — defaults to 7).
  const winDays = d.windowDays && d.windowDays > 0 ? d.windowDays : 7;
  scFillRound(ctx, PAD, y, SW - PAD * 2, STRIP_H, 10, C.card);
  scStrokeRound(ctx, PAD, y, SW - PAD * 2, STRIP_H, 10, C.border);
  scText(ctx, `LAST ${winDays} DAYS`, PAD + 18, y + 22, { font: "bold 11px monospace", color: C.muted });
  const chips = [
    { label: "Total",      val: d.counts7d.total,    color: C.accentStrong },
    { label: "Cleared",    val: d.counts7d.cleared,  color: C.good },
    { label: "In hold",    val: d.counts7d.hold,     color: SC.warn },
    { label: "Review",     val: d.counts7d.pending,  color: SC.info },
    { label: "Rejected",   val: d.counts7d.rejected, color: SC.bad },
    { label: "Removed",    val: d.counts7d.removed,  color: SC.bad },
  ];
  let chipX = SW - PAD - 18;
  for (let i = chips.length - 1; i >= 0; i--) {
    const c = chips[i]!;
    const valStr = String(c.val);
    ctx.font = "bold 18px sans-serif";
    const valW = ctx.measureText(valStr).width;
    ctx.font = "bold 10px monospace";
    const labW = ctx.measureText(c.label.toUpperCase()).width;
    const chipW = Math.max(valW, labW) + 24;
    const chipLeft = chipX - chipW;
    scText(ctx, valStr, chipLeft + chipW / 2, y + 30, { font: "bold 18px sans-serif", color: c.color, align: "center" });
    scText(ctx, c.label.toUpperCase(), chipLeft + chipW / 2, y + 48, { font: "bold 10px monospace", color: C.muted, align: "center" });
    chipX = chipLeft - 6;
  }
  y += STRIP_H + 22;

  // Recent submissions header
  scText(ctx, "Recent submissions", PAD, y + 16, { font: "bold 16px sans-serif", color: C.text });
  let headerRight: string;
  if (d.counts7d.total === 0) {
    headerRight = `no submissions in last ${winDays} days`;
  } else if (d.pageInfo && d.pageInfo.totalPages > 1) {
    // Paginated card — surface the page position so users know there's more.
    headerRight = `Page ${d.pageInfo.page + 1} of ${d.pageInfo.totalPages}  ·  ${recent.length} of ${d.counts7d.total}  ·  newest first`;
  } else {
    headerRight = `Showing ${recent.length} of ${d.counts7d.total}  ·  newest first`;
  }
  scText(ctx, headerRight, SW - PAD, y + 16, { font: "12px sans-serif", color: C.muted, align: "right" });
  y += 30;

  // Recent submissions table
  const tableX = PAD;
  const tableW = SW - PAD * 2;
  scFillRound(ctx, tableX, y, tableW, tableH, 10, C.card);
  scStrokeRound(ctx, tableX, y, tableW, tableH, 10, C.border);

  if (recent.length === 0) {
    scText(ctx, "You haven't submitted any tasks yet. Grab one from the tasks channel whenever you're ready.",
      tableX + tableW / 2, y + tableH / 2 + 4, {
        font: "13px sans-serif", color: C.muted, align: "center",
      });
  } else {
    const COL = {
      status: { x: tableX + 16,  w: 92  },
      live:   { x: tableX + 116, w: 80  },
      title:  { x: tableX + 204, w: 360 },
      reward: { x: tableX + 580, w: 70  },
      when:   { x: tableX + 660, w: tableW - (660 - tableX) - 16 },
    };
    const headY = y + 22;
    scText(ctx, "STATUS",    COL.status.x, headY, { font: "bold 10px monospace", color: SC.dim });
    scText(ctx, "ON REDDIT", COL.live.x,   headY, { font: "bold 10px monospace", color: SC.dim });
    scText(ctx, "TASK",      COL.title.x,  headY, { font: "bold 10px monospace", color: SC.dim });
    scText(ctx, "REWARD",    COL.reward.x + COL.reward.w, headY, { font: "bold 10px monospace", color: SC.dim, align: "right" });
    scText(ctx, "WHEN",      COL.when.x,   headY, { font: "bold 10px monospace", color: SC.dim });

    ctx.strokeStyle = SC.borderSoft;
    ctx.beginPath();
    ctx.moveTo(tableX + 12, headY + 8);
    ctx.lineTo(tableX + tableW - 12, headY + 8);
    ctx.stroke();

    let rowY = headY + 22;
    for (let i = 0; i < recent.length; i++) {
      const r = recent[i]!;
      const sm = STATUS_META[r.status];
      const lm = LIVE_META[r.live];

      if (i % 2 === 1) {
        scFillRound(ctx, tableX + 8, rowY - 22, tableW - 16, ROW_H - 4, 6, SC.cardAlt);
      }

      ctx.fillStyle = sm.dot;
      ctx.beginPath();
      ctx.arc(COL.status.x + 5, rowY - 9, 4, 0, Math.PI * 2);
      ctx.fill();
      scText(ctx, sm.label, COL.status.x + 16, rowY - 5, { font: "bold 10px monospace", color: sm.dot });

      ctx.font = "bold 10px monospace";
      const lmW = ctx.measureText(lm.label).width;
      scStrokeRound(ctx, COL.live.x - 4, rowY - 18, lmW + 14, 18, 9, lm.color, 1);
      scText(ctx, lm.label, COL.live.x + 3, rowY - 5, { font: "bold 10px monospace", color: lm.color });

      const titleStr = scTrunc(ctx, r.title, "14px sans-serif", COL.title.w - 8);
      scText(ctx, titleStr, COL.title.x, rowY - 5, { font: "14px sans-serif", color: C.accentStrong });

      scText(ctx, r.reward, COL.reward.x + COL.reward.w, rowY - 5, {
        font: "bold 13px monospace", color: C.text, align: "right",
      });

      scText(ctx, r.when, COL.when.x, rowY - 5, { font: "12px sans-serif", color: C.muted });
      rowY += ROW_H;
    }
  }
  y += tableH + 18;

  // Footer
  scFillRound(ctx, PAD, y, SW - PAD * 2, FOOTER_H, 10, C.card);
  scStrokeRound(ctx, PAD, y, SW - PAD * 2, FOOTER_H, 10, C.border);
  scText(ctx, "PAYMENT METHODS", PAD + 18, y + 22, { font: "bold 10px monospace", color: C.muted });
  const pmItems: Array<{ label: string; on: boolean }> = [
    { label: "PayPal", on: d.payments.paypal },
    { label: "UPI",    on: d.payments.upi },
    { label: "Crypto", on: d.payments.crypto },
  ];
  let pmX = PAD + 18;
  const pmY = y + 44;
  for (const p of pmItems) {
    ctx.fillStyle = p.on ? C.good : SC.dim;
    ctx.beginPath();
    ctx.arc(pmX + 5, pmY - 4, 4, 0, Math.PI * 2);
    ctx.fill();
    scText(ctx, p.label, pmX + 16, pmY, { font: "13px sans-serif", color: p.on ? C.text : C.muted });
    ctx.font = "13px sans-serif";
    pmX += 16 + ctx.measureText(p.label).width + 22;
  }
  scText(ctx, "Hold period: 24h–7d per task. Clears automatically — nothing to do.",
    SW - PAD - 18, y + 28, { font: "12px sans-serif", color: C.muted, align: "right" });
  scText(ctx, "Use /wallet to see this anytime  ·  /withdraw to cash out",
    SW - PAD - 18, y + 46, { font: "bold 11px monospace", color: C.accent, align: "right" });

  return canvas.toBuffer("image/png");
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly Payout Announcement card. Posted to #announcements when ALL of a
// Wednesday's withdrawals have been finalized. Lists each user that got paid
// with their amount, masked destination, and the admin(s) who paid them.
//
// Same SAFETY CONTRACT as the rest of this file: pure renderer, no DB / no
// Discord calls, caller wraps in try/catch.
//
// Width fixed at 900px (matches W). Height is DYNAMIC based on row count.
// ─────────────────────────────────────────────────────────────────────────────

export interface PayoutWeeklyRow {
  username: string;             // discord username of the earner
  amount: string;               // formatted, e.g. "₹800.00"
  method: string;               // "UPI" / "PayPal" / "USDT" / etc.
  destinationMasked: string;    // already masked by the caller
  paidBy: string[];             // admin display names
}

export interface PayoutWeeklyCardData {
  payDate: string;              // "22 May 2026"
  generatedAt: string;          // "8:42 PM IST"
  totalAmount: string;          // "₹2,840.00"
  totalUsers: number;
  totalAdmins: number;          // distinct admin count across all rows
  rows: PayoutWeeklyRow[];      // one row per user
}

export function renderPayoutWeeklyCard(d: PayoutWeeklyCardData): Buffer {
  // Dynamic height — header + total card + N rows + footer.
  const ROW_H = 56;
  const HEADER_H = 130;
  const TOTAL_CARD_H = 90;
  const FOOTER_H = 70;
  // Cap visible rows at 20 to keep the image height sane. Caller can split
  // into pages if needed (we never expect this in practice — Wed payday for
  // a real-world server tops out around 50 paid users per week).
  const visibleRows = d.rows.slice(0, 20);
  const H_DYN = HEADER_H + TOTAL_CARD_H + 20 + visibleRows.length * ROW_H + 30 + FOOTER_H;

  const canvas = createCanvas(W, H_DYN);
  const ctx = canvas.getContext("2d");

  // Background + top strip
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H_DYN);

  ctx.save();
  ctx.font = "12px monospace";
  ctx.fillStyle = C.muted;
  ctx.fillText("outpost › payouts › weekly", 30, 38);
  ctx.font = "bold 11px monospace";
  ctx.fillStyle = C.good;
  ctx.textAlign = "right";
  ctx.fillText("● ALL PAID", W - 30, 38);
  ctx.textAlign = "start";
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 60); ctx.lineTo(W, 60); ctx.stroke();
  ctx.restore();

  // Header
  drawText(ctx, "Wednesday Payday", 30, 100, { font: "bold 24px sans-serif", color: C.text });
  drawText(ctx, `${d.payDate} · ${d.totalUsers} user${d.totalUsers === 1 ? "" : "s"} paid by ${d.totalAdmins} admin${d.totalAdmins === 1 ? "" : "s"}`, 30, 122, {
    font: "13px sans-serif", color: C.muted, maxWidth: 700,
  });

  // Total card
  drawCard(ctx, 30, HEADER_H, W - 60, TOTAL_CARD_H, 12);
  drawText(ctx, "TOTAL DISTRIBUTED", 50, HEADER_H + 28, { font: "bold 11px monospace", color: C.muted });
  drawText(ctx, d.totalAmount, 50, HEADER_H + 72, { font: "bold 40px sans-serif", color: C.text });
  drawText(ctx, `${d.totalUsers} earner${d.totalUsers === 1 ? "" : "s"}`, W - 50, HEADER_H + 50, {
    font: "bold 14px monospace", color: C.accentStrong, align: "right",
  });
  drawText(ctx, `${d.totalAdmins} admin${d.totalAdmins === 1 ? "" : "s"} settled`, W - 50, HEADER_H + 72, {
    font: "12px monospace", color: C.muted, align: "right",
  });

  // List headers
  const listY0 = HEADER_H + TOTAL_CARD_H + 20;
  drawText(ctx, "USER", 50, listY0 + 18, { font: "bold 11px monospace", color: C.muted });
  drawText(ctx, "PAID BY", 480, listY0 + 18, { font: "bold 11px monospace", color: C.muted });
  drawText(ctx, "AMOUNT", W - 50, listY0 + 18, { font: "bold 11px monospace", color: C.muted, align: "right" });

  ctx.save();
  ctx.strokeStyle = C.border;
  ctx.beginPath();
  ctx.moveTo(30, listY0 + 28); ctx.lineTo(W - 30, listY0 + 28); ctx.stroke();
  ctx.restore();

  // Local helper for tiny initial-disc avatars (rows render dozens).
  const drawDot = (initial: string, cx: number, cy: number, size: number, bg = C.border, fg = C.text): void => {
    ctx.save();
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.font = `bold ${Math.floor(size * 0.42)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((initial[0] ?? "?").toUpperCase(), cx, cy + 1);
    ctx.restore();
  };

  // Rows
  visibleRows.forEach((row, i) => {
    const y = listY0 + 40 + i * ROW_H;

    if (i < visibleRows.length - 1) {
      ctx.save();
      ctx.strokeStyle = "#1f1f23";
      ctx.beginPath();
      ctx.moveTo(50, y + ROW_H - 8); ctx.lineTo(W - 50, y + ROW_H - 8); ctx.stroke();
      ctx.restore();
    }

    drawDot(row.username, 60, y + 18, 28);
    drawText(ctx, `@${row.username}`, 85, y + 14, { font: "bold 15px sans-serif", color: C.text, maxWidth: 380 });
    drawText(ctx, `${row.method} · ${row.destinationMasked}`, 85, y + 32, {
      font: "11px monospace", color: C.muted, maxWidth: 380,
    });

    // Admin chips (up to 4 visible, +N if more)
    const startX = 480;
    const dotSize = 22;
    const overlap = 6;
    const visAdmins = row.paidBy.slice(0, 4);
    visAdmins.forEach((adm, j) => {
      drawDot(adm, startX + j * (dotSize - overlap), y + 18, dotSize, "#3f3f46", C.text);
    });
    if (row.paidBy.length > 4) {
      drawText(ctx, `+${row.paidBy.length - 4}`, startX + visAdmins.length * (dotSize - overlap) + 10, y + 22, {
        font: "bold 11px monospace", color: C.muted,
      });
    }
    const adminLine = row.paidBy.map((a) => `@${a}`).join(", ");
    drawText(ctx, adminLine, 480, y + 38, {
      font: "11px monospace", color: C.muted, maxWidth: 320,
    });

    drawText(ctx, row.amount, W - 50, y + 24, {
      font: "bold 18px sans-serif", color: C.accentStrong, align: "right",
    });
  });

  // Footer
  const footerY = H_DYN - 22;
  drawText(ctx, `Generated ${d.payDate}, ${d.generatedAt}`, 30, footerY, {
    font: "10px monospace", color: C.muted,
  });
  drawText(ctx, "OUTPOST BOT", W - 30, footerY, {
    font: "bold 10px monospace", color: C.muted, align: "right",
  });

  return canvas.toBuffer("image/png");
}
