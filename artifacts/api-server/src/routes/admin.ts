import { Router } from "express";
import { db, pool } from "@workspace/db";
import { users, tasks, submissions, campaigns, claims, redditAccounts } from "@workspace/db";
import { eq, ilike, or, sql, desc, and } from "drizzle-orm";
import { logger, getInMemoryLogs, pushLog } from "../lib/logger.js";
import { adjustUserBalance } from "../bot/handlers/admin.js";
import { getPrimaryGuild } from "../bot/discord-client.js";
import { setupGuild, getOrCreateWorkspaceChannel } from "../bot/setup.js";
import { makeEmbed } from "../bot/util.js";
import { COLORS } from "../bot/constants.js";
import { runLivenessTickNow, startBulkLivenessScanAllTime, isBulkScanRunning } from "../bot/redditLivenessChecker.js";
import { runPostPayoutCheckNow } from "../bot/postPayoutChecker.js";
import { invalidateUser } from "../bot/cache.js";
import { getCooldownConfig, setCooldownConfig, getAutoBumpConfig, setAutoBumpConfig, getMaxRedditAccounts, setMaxRedditAccounts, getProxies, setProxies } from "../lib/settings.js";
import { reloadProxiesNow, getProxyMetrics } from "../bot/proxy.js";
import { validateRedditProof, recheckRedditLiveness, parseRedditProofUrl, detectAppUrl, resolveShareLink } from "../bot/reddit-validator.js";

const router = Router();

// Re-check the user against the DB on every protected request so that
// changes (suspend/demote/delete) take effect immediately, without waiting
// for the user to log out.
export async function requireAuth(req: any, res: any, next: any) {
  const sessionUser = (req as any).session?.adminUser;
  if (!sessionUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const fresh = await pool.query<{ id: number; username: string; role: string; status: string }>(
      `SELECT id, username, role, status FROM admin_users WHERE id = $1`,
      [sessionUser.id]
    );
    const row = fresh.rows[0];
    if (!row || row.status === "suspended") {
      (req as any).session?.destroy?.(() => {});
      res.status(401).json({ error: "Session is no longer valid. Please log in again." });
      return;
    }
    // Refresh role on the session object so downstream middleware sees the latest.
    (req as any).session.adminUser = { id: row.id, username: row.username, role: row.role };
    next();
  } catch (err) {
    req.log?.error?.({ err }, "requireAuth DB check failed");
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function requireAdminRole(req: any, res: any, next: any) {
  await requireAuth(req, res, () => {
    const u = (req as any).session?.adminUser;
    if (!u) return; // requireAuth already responded
    // 'dev' is a higher-privileged role and passes any admin check.
    if (u.role !== "admin" && u.role !== "dev") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    next();
  });
}

export async function requireDevRole(req: any, res: any, next: any) {
  await requireAuth(req, res, () => {
    const u = (req as any).session?.adminUser;
    if (!u) return;
    if (u.role !== "dev") {
      res.status(403).json({ error: "Dev role required" });
      return;
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Settings (Phase 2): global cooldown configuration. Read by any signed-in
// admin/dev; write-protected to admin+dev role only. The bot reads through
// lib/settings.getCooldownConfig() which has its own 30s in-memory cache.
// ---------------------------------------------------------------------------
router.get("/settings/cooldown", requireAuth, async (_req, res) => {
  try {
    const cfg = await getCooldownConfig();
    res.json(cfg);
  } catch (err) {
    logger.error({ err }, "GET /settings/cooldown failed");
    res.status(500).json({ error: "Failed to load cooldown settings" });
  }
});

router.patch("/settings/cooldown", requireAdminRole, async (req, res) => {
  const { enabled, minutes } = (req.body ?? {}) as { enabled?: unknown; minutes?: unknown };
  const patch: { enabled?: boolean; minutes?: number } = {};
  if (typeof enabled === "boolean") patch.enabled = enabled;
  if (minutes !== undefined && minutes !== null) {
    const n = typeof minutes === "number" ? minutes : parseInt(String(minutes));
    if (!Number.isFinite(n) || n < 0 || n > 60 * 24 * 30) {
      return res.status(400).json({ error: "minutes must be between 0 and 43200" });
    }
    patch.minutes = n;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: "Provide at least one of: enabled, minutes" });
  }
  try {
    const next = await setCooldownConfig(patch);
    res.json(next);
  } catch (err) {
    logger.error({ err }, "PATCH /settings/cooldown failed");
    res.status(500).json({ error: "Failed to save cooldown settings" });
  }
});

// Feature #9 master switch — see lib/settings.getAutoBumpConfig().
router.get("/settings/auto-bump", requireAuth, async (_req, res) => {
  try {
    const cfg = await getAutoBumpConfig();
    res.json(cfg);
  } catch (err) {
    logger.error({ err }, "GET /settings/auto-bump failed");
    res.status(500).json({ error: "Failed to load auto-bump settings" });
  }
});

router.patch("/settings/auto-bump", requireAdminRole, async (req, res) => {
  const { enabled } = (req.body ?? {}) as { enabled?: unknown };
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled (boolean) is required" });
  }
  try {
    const next = await setAutoBumpConfig({ enabled });
    res.json(next);
  } catch (err) {
    logger.error({ err }, "PATCH /settings/auto-bump failed");
    res.status(500).json({ error: "Failed to save auto-bump settings" });
  }
});

// ── Proxy list (HTTP/SOCKS proxies the bot rotates through for Reddit) ────
// GET returns the current list + live metrics so the dashboard can show
// the operator how many proxies are loaded, success rate, latency.
router.get("/settings/proxies", requireAdminRole, async (_req, res) => {
  try {
    const list = await getProxies();
    const metrics = getProxyMetrics();
    res.json({ list, metrics });
  } catch (err) {
    logger.error({ err }, "GET /settings/proxies failed");
    res.status(500).json({ error: "Failed to load proxies" });
  }
});

// PUT replaces the entire list (simpler than diff-based add/remove for the
// dashboard). Body: { list: string[] }. Empty array clears proxies (bot
// falls back to direct connections). After save we force an immediate
// reload so the change is live in seconds instead of up to 60s.
router.put("/settings/proxies", requireAdminRole, async (req, res) => {
  const body = (req.body ?? {}) as { list?: unknown };
  if (!Array.isArray(body.list)) {
    return res.status(400).json({ error: "list (string[]) is required" });
  }
  try {
    const saved = await setProxies(body.list as string[]);
    const loadedCount = await reloadProxiesNow();
    res.json({ list: saved, loadedCount, metrics: getProxyMetrics() });
  } catch (err) {
    logger.error({ err }, "PUT /settings/proxies failed");
    res.status(500).json({ error: "Failed to save proxies" });
  }
});

// ── Max Reddit accounts per Discord user ──────────────────────────────────
router.get("/settings/max-reddit-accounts", requireAuth, async (_req, res) => {
  try {
    const max = await getMaxRedditAccounts();
    res.json({ max });
  } catch (err) {
    logger.error({ err }, "GET /settings/max-reddit-accounts failed");
    res.status(500).json({ error: "Failed to load setting" });
  }
});

router.patch("/settings/max-reddit-accounts", requireAdminRole, async (req, res) => {
  const { max } = (req.body ?? {}) as { max?: unknown };
  if (max === undefined || max === null) {
    return res.status(400).json({ error: "max is required" });
  }
  const n = typeof max === "number" ? max : parseInt(String(max));
  if (!Number.isFinite(n) || n < 1 || n > 20) {
    return res.status(400).json({ error: "max must be 1–20" });
  }
  try {
    const v = await setMaxRedditAccounts(n);
    res.json({ max: v });
  } catch (err) {
    logger.error({ err }, "PATCH /settings/max-reddit-accounts failed");
    res.status(500).json({ error: "Failed to save setting" });
  }
});

// ── Active cooldowns dashboard ─────────────────────────────────────────────
router.get("/cooldowns", requireAuth, async (_req, res) => {
  try {
    const cfg = await getCooldownConfig();
    if (!cfg.enabled || cfg.minutes <= 0) {
      return res.json({ cooldowns: [], cooldownEnabled: false, cooldownMinutes: cfg.minutes, totalActive: 0 });
    }
    const cutoff = new Date(Date.now() - cfg.minutes * 60 * 1000);

    const [redditRows, userRows] = await Promise.all([
      pool.query(
        `SELECT ra.discord_id, u.discord_username, ra.reddit_username,
                ra.last_used_at,
                (ra.last_used_at + ($1 || ' minutes')::interval) AS ready_at,
                GREATEST(0, EXTRACT(EPOCH FROM (ra.last_used_at + ($1 || ' minutes')::interval - NOW())) * 1000)::bigint AS ms_remaining
           FROM reddit_accounts ra
           JOIN users u ON u.discord_id = ra.discord_id
          WHERE ra.last_used_at IS NOT NULL AND ra.last_used_at > $2
          ORDER BY ms_remaining DESC
          LIMIT 500`,
        [cfg.minutes, cutoff],
      ),
      pool.query(
        `SELECT u.discord_id, u.discord_username, u.last_task_completed_at,
                (u.last_task_completed_at + ($1 || ' minutes')::interval) AS ready_at,
                GREATEST(0, EXTRACT(EPOCH FROM (u.last_task_completed_at + ($1 || ' minutes')::interval - NOW())) * 1000)::bigint AS ms_remaining
           FROM users u
          WHERE u.last_task_completed_at IS NOT NULL AND u.last_task_completed_at > $2
          ORDER BY ms_remaining DESC
          LIMIT 500`,
        [cfg.minutes, cutoff],
      ),
    ]);

    const combined = [
      ...redditRows.rows.map((r: any) => ({ ...r, cooldown_type: "reddit" })),
      ...userRows.rows.map((r: any) => ({ ...r, cooldown_type: "user" })),
    ].sort((a, b) => Number(b.ms_remaining) - Number(a.ms_remaining));

    res.json({ cooldowns: combined, cooldownEnabled: true, cooldownMinutes: cfg.minutes, totalActive: combined.length });
  } catch (err: any) {
    logger.error({ err }, "GET /cooldowns failed");
    res.status(500).json({ error: err?.message ?? "Failed to load cooldowns" });
  }
});

// ── Link an additional Reddit account to a user ──────────────────────────
// Admin-only helper for when a worker asks to swap or add a Reddit account
// without going through the in-Discord verification dance. This is purely
// additive: it inserts into reddit_accounts (subject to the per-user cap
// and the global uniqueness constraint on reddit_username). If the user
// currently has NO primary on `users.reddit_username`, the new account is
// promoted to primary so existing claim-time checks keep working.
//
// This endpoint does NOT change a user's verified flag or touch Discord
// roles/channels — initial verification still flows through POST
// /users/:id/verify. Use this only for managing already-linked accounts.
router.post("/users/:id/reddit-accounts", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const raw = ((req.body as any)?.reddit_username ?? "").toString().trim();
  const redditUsername = raw.toLowerCase().replace(/^\/?u\//i, "");
  if (!redditUsername || !/^[a-z0-9_-]{2,20}$/.test(redditUsername)) {
    return res.status(400).json({ error: "Invalid Reddit username (letters/digits/_/-, 2–20 chars)." });
  }
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Enforce the configurable per-user cap.
    const cap = await getMaxRedditAccounts();
    const cur = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM reddit_accounts WHERE discord_id = ${user.discordId}`
    );
    const currentCount = parseInt(cur.rows[0]?.count ?? "0");
    if (currentCount >= cap) {
      return res.status(400).json({ error: `User already has the maximum of ${cap} linked Reddit accounts. Unlink one first.` });
    }

    // Global uniqueness: reddit_username is UNIQUE in the reddit_accounts
    // table, so check up-front to give a friendly error rather than a 500.
    const dup = await db.execute<{ discord_id: string }>(
      sql`SELECT discord_id FROM reddit_accounts WHERE reddit_username = ${redditUsername} LIMIT 1`
    );
    if (dup.rows[0]) {
      if (dup.rows[0].discord_id === user.discordId) {
        return res.status(409).json({ error: `u/${redditUsername} is already linked to this user.` });
      }
      return res.status(409).json({ error: `u/${redditUsername} is already linked to a different Discord user.` });
    }

    try {
      await db.insert(redditAccounts).values({
        discordId: user.discordId,
        redditUsername,
      });
    } catch (insertErr: any) {
      // Concurrent inserts can slip past the pre-check above and hit the
      // UNIQUE constraint on reddit_accounts.reddit_username. Map that to
      // a deterministic 409 instead of a 500 with raw DB text.
      const code = insertErr?.code ?? insertErr?.cause?.code;
      if (code === "23505") {
        return res.status(409).json({ error: `u/${redditUsername} is already linked to another account.` });
      }
      throw insertErr;
    }

    // If there's no primary yet, promote this one so legacy code paths
    // that read users.reddit_username keep working without manual cleanup.
    if (!user.redditUsername) {
      await db.update(users).set({ redditUsername }).where(eq(users.id, id));
    }

    invalidateUser(user.discordId);
    req.log.info(
      { userId: id, discordId: user.discordId, redditUsername, actor: (req as any).session?.adminUser?.username },
      "Admin linked Reddit account"
    );
    res.json({ ok: true, redditUsername });
  } catch (err: any) {
    req.log?.error?.({ err }, "POST /users/:id/reddit-accounts failed");
    res.status(500).json({ error: "Failed to link account" });
  }
});

// ── Unlink a single Reddit account ────────────────────────────────────────
// Delegates to the shared `unlinkRedditAccount` helper so the dashboard
// and the in-Discord "Unlink" button (on the additional-account log)
// share ONE code path — same DB writes, same primary-rotation, same
// worker-notification. Prevents the two paths from drifting apart.
router.delete("/reddit-accounts/:discordId/:redditUsername", requireAuth, async (req, res) => {
  const { discordId, redditUsername } = req.params;
  const nameLower = redditUsername.toLowerCase();
  const sessionUser = (req as any).session?.adminUser;
  try {
    const { unlinkRedditAccount } = await import("../bot/handlers/verification.js");
    const guild = (() => { try { return getPrimaryGuild(); } catch { return null; } })();
    const result = await unlinkRedditAccount({
      discordId,
      redditUsernameLower: nameLower,
      guild,
      actorLabel: sessionUser?.username ? `dashboard:${sessionUser.username}` : "dashboard",
    });
    req.log?.info({ discordId, redditUsername: nameLower, remainingCount: result.remainingCount }, "Admin unlinked Reddit account");
    res.json({ ok: true, remainingAccounts: result.remainingCount });
  } catch (err: any) {
    logger.error({ err }, "DELETE /reddit-accounts failed");
    res.status(500).json({ error: err?.message ?? "Failed to unlink account" });
  }
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body as { username: string; password: string };
  if (!username || !password) {
    res.status(400).json({ error: "Username and password required" });
    return;
  }
  try {
    const result = await pool.query<{
      id: number;
      username: string;
      role: string;
      status: string;
      has_pw: boolean;
      matches: boolean;
      first_login_unlocked: boolean;
    }>(
      `SELECT id, username, role, status, first_login_unlocked,
              (password_hash IS NOT NULL) as has_pw,
              (password_hash IS NOT NULL AND password_hash = crypt($2, password_hash)) as matches
       FROM admin_users WHERE username = $1`,
      [username, password]
    );
    const row = result.rows[0];
    if (!row) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    if (!row.has_pw) {
      // First-time login flow: pre-authorized accounts (jishand, damy) have
      // first_login_unlocked = true and no password yet. Whatever password
      // they type now becomes their permanent password.
      if (row.first_login_unlocked) {
        if (password.length < 6) {
          res.status(400).json({ error: "First-time password must be at least 6 characters." });
          return;
        }
        await pool.query(
          `UPDATE admin_users
           SET password_hash = crypt($1, gen_salt('bf')),
               first_login_unlocked = false
           WHERE id = $2`,
          [password, row.id]
        );
        req.log.info({ username }, "First-time password set");
        // fall through and treat as a successful login below
      } else {
        res.status(401).json({ error: "This account hasn't set a password yet. Use the setup link the admin gave you." });
        return;
      }
    } else if (!row.matches) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    if (row.status === "pending") {
      res.status(403).json({ error: "Your application is awaiting admin approval." });
      return;
    }
    if (row.status === "suspended") {
      res.status(403).json({ error: "Your account has been suspended. Contact an admin." });
      return;
    }
    const adminUser = { id: row.id, username: row.username, role: row.role };
    // Regenerate session ID on successful login to prevent session fixation.
    (req as any).session.regenerate((regenErr: Error | null) => {
      if (regenErr) {
        req.log.error({ err: regenErr }, "Session regenerate failed");
        res.status(500).json({ error: "Internal server error" });
        return;
      }
      (req as any).session.adminUser = adminUser;
      (req as any).session.save((saveErr: Error | null) => {
        if (saveErr) {
          req.log.error({ err: saveErr }, "Session save failed");
          res.status(500).json({ error: "Internal server error" });
          return;
        }
        res.json(adminUser);
      });
    });
  } catch (err) {
    req.log.error({ err }, "Login error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/logout", (req, res) => {
  (req as any).session.destroy(() => {
    res.clearCookie("outpost.sid");
    res.json({ ok: true });
  });
});

router.get("/me", requireAuth, async (req, res) => {
  // requireAuth has already refreshed session.adminUser from the DB.
  const u = (req as any).session.adminUser;
  try {
    const r = await pool.query<{ discord_id: string | null; discord_username: string | null; discord_avatar: string | null }>(
      `SELECT discord_id, discord_username, discord_avatar FROM admin_users WHERE id = $1`,
      [u.id]
    );
    const row = r.rows[0];
    res.json({
      ...u,
      discordId: row?.discord_id ?? null,
      discordUsername: row?.discord_username ?? null,
      discordAvatar: row?.discord_avatar ?? null,
    });
  } catch {
    res.json({ ...u, discordId: null, discordUsername: null, discordAvatar: null });
  }
});

router.get("/stats", requireAuth, async (req, res) => {
  try {
    const [
      totalUsersRow,
      verifiedUsersRow,
      totalTasksRow,
      openTasksRow,
      pendingSubmissionsRow,
      approvedSubmissionsRow,
      totalEarnedRow,
      pendingPayoutRow,
      activeCampaignsRow,
      flaggedUsersRow,
    ] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM users"),
      pool.query("SELECT COUNT(*) FROM users WHERE verified = true"),
      pool.query("SELECT COUNT(*) FROM tasks"),
      pool.query("SELECT COUNT(*) FROM tasks WHERE status = 'open'"),
      pool.query("SELECT COUNT(*) FROM submissions WHERE review_status IN ('pending', 'pending_hold')"),
      pool.query("SELECT COUNT(*) FROM submissions WHERE review_status = 'accepted'"),
      pool.query("SELECT COALESCE(SUM(total_earned), 0) FROM users"),
      pool.query("SELECT COALESCE(SUM(balance_pending), 0) FROM users"),
      pool.query("SELECT COUNT(*) FROM campaigns WHERE status = 'active'"),
      pool.query("SELECT COUNT(*) FROM users WHERE flagged = true"),
    ]);
    res.json({
      totalUsers: parseInt(totalUsersRow.rows[0].count),
      verifiedUsers: parseInt(verifiedUsersRow.rows[0].count),
      totalTasks: parseInt(totalTasksRow.rows[0].count),
      openTasks: parseInt(openTasksRow.rows[0].count),
      pendingSubmissions: parseInt(pendingSubmissionsRow.rows[0].count),
      approvedSubmissions: parseInt(approvedSubmissionsRow.rows[0].count),
      totalEarned: totalEarnedRow.rows[0].coalesce,
      pendingPayout: pendingPayoutRow.rows[0].coalesce,
      activeCampaigns: parseInt(activeCampaignsRow.rows[0].count),
      flaggedUsers: parseInt(flaggedUsersRow.rows[0].count),
    });
  } catch (err) {
    req.log.error({ err }, "Stats error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/users", requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1")));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"))));
  const search = req.query.search as string | undefined;
  const flaggedOnly = req.query.flagged === "true";
  const verifiedOnly = req.query.verified === "true";
  const offset = (page - 1) * limit;

  try {
    const conditions = [];
    if (search) {
      conditions.push(
        or(
          ilike(users.discordUsername, `%${search}%`),
          ilike(users.redditUsername ?? sql`''`, `%${search}%`)
        )
      );
    }
    if (flaggedOnly) {
      conditions.push(eq(users.flagged, true));
    }
    if (verifiedOnly) {
      conditions.push(eq(users.verified, true));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(whereClause),
    ]);

    res.json({
      users: rows,
      total: totalRows[0]?.count ?? 0,
      page,
      limit,
    });
  } catch (err) {
    req.log.error({ err }, "List users error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/users/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(user);
  } catch (err) {
    req.log.error({ err }, "Get user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Worker admin profile — aggregated lifetime view of a single user.
// /profile  → big bundle (stats, recent activity, withdrawals, rejection mix)
// /notes    → list/add admin notes attached to the user's discord_id
// ---------------------------------------------------------------------------
router.get("/users/:id/profile", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    const discordId = user.discordId;

    const [stats, recentSubs, recentClaims, recentWds, rejectionReasons, taskBlocks] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE review_status = 'accepted')             AS accepted,
          COUNT(*) FILTER (WHERE review_status = 'rejected')             AS rejected,
          COUNT(*) FILTER (WHERE review_status IN ('pending', 'pending_hold')) AS pending,
          COUNT(*)                                                       AS total,
          COALESCE(SUM(reward) FILTER (WHERE review_status = 'accepted'), 0) AS lifetime_earned,
          AVG(EXTRACT(EPOCH FROM (submitted_at - claimed_at))) FILTER (
            WHERE claimed_at IS NOT NULL
          )                                                              AS avg_submit_seconds
        FROM submissions s
        LEFT JOIN claims c ON c.id = s.claim_id
        WHERE s.discord_id = $1`,
        [discordId],
      ),
      pool.query(`
        SELECT s.id, s.task_id, t.title AS task_title, s.review_status,
               s.live_status, s.reward, s.proof_link, s.submitted_at,
               s.reviewed_at, s.review_reason,
               NULL::text AS campaign_title,
               t.creator_discord_id AS campaign_creator
          FROM submissions s
          LEFT JOIN tasks t ON t.id = s.task_id
         WHERE s.discord_id = $1
         ORDER BY s.submitted_at DESC LIMIT 50`,
        [discordId],
      ),
      pool.query(`
        SELECT c.id, c.task_id, t.title AS task_title, c.status,
               c.claimed_at, c.expires_at
          FROM claims c
          LEFT JOIN tasks t ON t.id = c.task_id
         WHERE c.discord_id = $1
         ORDER BY c.claimed_at DESC LIMIT 30`,
        [discordId],
      ),
      pool.query(`
        SELECT id, amount, method, status, requested_at, processed_at, reason
          FROM withdrawals
         WHERE discord_id = $1
         ORDER BY requested_at DESC LIMIT 30`,
        [discordId],
      ),
      pool.query(`
        SELECT COALESCE(NULLIF(review_reason, ''), 'no reason') AS reason,
               COUNT(*) AS count
          FROM submissions
         WHERE discord_id = $1 AND review_status = 'rejected'
         GROUP BY 1 ORDER BY count DESC LIMIT 10`,
        [discordId],
      ),
      pool.query(`
        SELECT b.task_id, t.title AS task_title, b.reason, b.blocked_at
          FROM task_claim_blocks b
          LEFT JOIN tasks t ON t.id = b.task_id
         WHERE b.discord_id = $1
         ORDER BY b.blocked_at DESC LIMIT 30`,
        [discordId],
      ),
    ]);

    const s = stats.rows[0] ?? {};
    const accepted = Number(s.accepted ?? 0);
    const total = Number(s.total ?? 0);
    res.json({
      user,
      stats: {
        accepted,
        rejected: Number(s.rejected ?? 0),
        pending: Number(s.pending ?? 0),
        total,
        lifetimeEarned: Number(s.lifetime_earned ?? 0).toFixed(2),
        approvalRate: total > 0 ? Math.round((accepted / total) * 1000) / 10 : 0,
        avgSubmitSeconds: s.avg_submit_seconds != null ? Math.round(Number(s.avg_submit_seconds)) : null,
      },
      recentSubmissions: recentSubs.rows,
      recentClaims: recentClaims.rows,
      withdrawals: recentWds.rows,
      rejectionReasons: rejectionReasons.rows,
      taskBlocks: taskBlocks.rows,
    });
  } catch (err) {
    req.log?.error?.({ err }, "GET /users/:id/profile failed");
    res.status(500).json({ error: "Failed to load profile" });
  }
});

router.get("/users/:id/reddit-accounts", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    // UNION the primary `users.reddit_username` with rows in
    // `reddit_accounts`. Some legacy users (verified before the
    // multi-account schema landed, or where the boot-time backfill hit a
    // UNIQUE conflict) have their primary username ONLY in the users
    // table and NO row in reddit_accounts — without this UNION the
    // dashboard shows "No linked accounts" for them, making it look like
    // their Reddit accounts were wiped. They weren't; the table just
    // missed a row. DISTINCT ON keeps one row per reddit_username,
    // preferring the reddit_accounts row (richer metadata) when present.
    // Ordering contract the operator depends on:
    //   slot 1 = PRIMARY account (the one stored in users.reddit_username,
    //           which is also the first one the user ever linked / the one
    //           that owns the verified flag)
    //   slot 2..N = additional linked accounts in the order they were
    //           added (oldest verified_at first), matching how the embed
    //           and the bot itself surface them.
    // The previous version sorted alphabetically because the outer
    // ORDER BY had `reddit_username` as its first key — that broke the
    // "first connected = slot 1" invariant the operator was used to.
    // New approach:
    //   1. Inner subquery dedupes on reddit_username (keeps the
    //      reddit_accounts row over the users-table fallback when both
    //      exist, because reddit_accounts has the real verified_at).
    //   2. Outer SELECT joins users so we can flag the primary, then
    //      orders by is_primary DESC, then verified_at ASC (oldest first),
    //      with reddit_username as a stable tiebreaker for NULL timestamps.
    // IMPORTANT: `reddit_accounts` has NO `verified_at` column in this
    // schema — only `created_at` (set on insert = the moment the account
    // was linked, which IS the verification time). The previous version
    // SELECTed verified_at and threw a 500, which the dashboard caught
    // as "data?.accounts ?? []" → showing "No linked accounts" for
    // EVERY user. We use created_at as the verified-time proxy.
    const r = await pool.query(
      `WITH merged AS (
         SELECT DISTINCT ON (reddit_username)
                reddit_username, last_used_at, verified_at
           FROM (
             SELECT reddit_username, last_used_at, created_at AS verified_at
               FROM reddit_accounts WHERE discord_id = $1
             UNION ALL
             SELECT reddit_username,
                    NULL::timestamptz AS last_used_at,
                    NULL::timestamptz AS verified_at
               FROM users
               WHERE discord_id = $1
                 AND reddit_username IS NOT NULL
                 AND reddit_username <> ''
           ) raw
           ORDER BY reddit_username, verified_at NULLS LAST
       )
       SELECT m.reddit_username,
              m.last_used_at,
              m.verified_at,
              (LOWER(m.reddit_username) = LOWER(COALESCE(u.reddit_username, '')))
                AS is_primary
         FROM merged m
         LEFT JOIN users u ON u.discord_id = $1
         ORDER BY is_primary DESC,
                  m.verified_at ASC NULLS LAST,
                  m.reddit_username ASC`,
      [user.discordId],
    );
    res.json({ accounts: r.rows });
  } catch (err) {
    req.log?.error?.({ err }, "GET /users/:id/reddit-accounts failed");
    res.status(500).json({ error: "Failed to load accounts" });
  }
});

router.get("/users/:id/notes", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    const r = await pool.query(
      `SELECT id, author_username, body, created_at
         FROM admin_notes WHERE discord_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [user.discordId],
    );
    res.json({ notes: r.rows });
  } catch (err) {
    req.log?.error?.({ err }, "GET /users/:id/notes failed");
    res.status(500).json({ error: "Failed to load notes" });
  }
});

router.post("/users/:id/notes", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const sessionUser = (req as any).session?.adminUser;
  const body = String((req.body as any)?.body ?? "").trim();
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  if (!body) return res.status(400).json({ error: "Note body required" });
  if (body.length > 4000) return res.status(400).json({ error: "Note too long (max 4000 chars)" });
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    const r = await pool.query(
      `INSERT INTO admin_notes (discord_id, author_username, body) VALUES ($1, $2, $3)
       RETURNING id, author_username, body, created_at`,
      [user.discordId, sessionUser?.username ?? "unknown", body],
    );
    res.json(r.rows[0]);
  } catch (err) {
    req.log?.error?.({ err }, "POST /users/:id/notes failed");
    res.status(500).json({ error: "Failed to save note" });
  }
});

router.delete("/users/notes/:noteId", requireAdminRole, async (req, res) => {
  const noteId = parseInt(req.params.noteId);
  if (!Number.isFinite(noteId)) return res.status(400).json({ error: "Invalid noteId" });
  try {
    const r = await pool.query(`DELETE FROM admin_notes WHERE id = $1`, [noteId]);
    res.json({ ok: true, removed: r.rowCount ?? 0 });
  } catch (err) {
    req.log?.error?.({ err }, "DELETE /users/notes/:noteId failed");
    res.status(500).json({ error: "Failed to delete note" });
  }
});

// Send a single user's paginated stats card to their workspace channel.
// Triggered from the dashboard "Send Stats" button on a worker profile.
// Always posts a fresh message at page 0; the user themselves flips
// pages via ◀/▶ buttons. Read-only with respect to balances and DB
// state — only side-effect is a Discord message in the user's private
// workspace channel.
router.post("/users/:id/send-stats", requireAdminRole, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  let guild;
  try {
    guild = getPrimaryGuild();
    if (!guild) {
      res.status(502).json({ error: "Discord bot not connected to a server right now." });
      return;
    }
  } catch (err) {
    req.log?.error?.({ err }, "send-stats: no primary guild");
    res.status(502).json({ error: "Discord bot not connected to a server right now." });
    return;
  }

  try {
    // Lazy-imported to keep the bot module out of the route-loading hot
    // path (matches how other Discord-touching admin actions defer their
    // imports to avoid pulling in discord.js at module init).
    const { sendSingleUserStatsCard } = await import("../bot/handlers/sendStats.js");
    const result = await sendSingleUserStatsCard(guild, id);

    if (!result.ok) {
      const reasonMap: Record<string, { status: number; msg: string }> = {
        no_user:         { status: 404, msg: "User not found." },
        no_workspace:    { status: 400, msg: "This user doesn't have a workspace channel yet. They need to verify in Discord first." },
        channel_missing: { status: 400, msg: "The user's workspace channel was deleted or is no longer accessible." },
        stats_missing:   { status: 404, msg: "No stats available for this user." },
        send_failed:     { status: 502, msg: "Discord rejected the message. The bot may have lost access to the channel." },
      };
      const mapped = reasonMap[result.reason ?? ""] ?? { status: 500, msg: "Failed to send stats." };
      res.status(mapped.status).json({ error: mapped.msg, reason: result.reason });
      return;
    }

    req.log?.info?.({ userId: id, totalPages: result.totalPages, totalSubs: result.totalSubs }, "Sent single-user stats card");
    res.json({ ok: true, totalPages: result.totalPages, totalSubs: result.totalSubs });
  } catch (err) {
    req.log?.error?.({ err, userId: id }, "send-stats: unexpected failure");
    res.status(500).json({ error: "Failed to send stats." });
  }
});

router.post("/users/:id/adjust-balance", requireAdminRole, async (req, res) => {
  const id = parseInt(req.params.id);
  const { delta, reason } = req.body as { delta?: number; reason?: string };
  const sessionUser = (req as any).session?.adminUser;

  const numericDelta = Number(delta);
  if (!Number.isFinite(numericDelta) || numericDelta === 0) {
    res.status(400).json({ error: "delta must be a non-zero number" });
    return;
  }
  if (Math.abs(numericDelta) > 10000) {
    res.status(400).json({ error: "delta absolute value must be <= 10000" });
    return;
  }

  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const result = await adjustUserBalance({
      discordId: user.discordId,
      delta: numericDelta,
      reason: reason?.trim() || "No reason provided",
      actor: `dashboard:${sessionUser?.username ?? "unknown"}`,
    });

    if (!result) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    req.log.info(
      {
        userId: id,
        requestedDelta: numericDelta,
        appliedDelta: result.appliedDelta,
        clamped: result.clamped,
        by: sessionUser?.username,
        newBalance: result.newBalance,
      },
      "Balance adjusted via dashboard",
    );
    res.json({
      ...result.user,
      _adjustment: {
        requestedDelta: result.requestedDelta,
        appliedDelta: result.appliedDelta,
        previousBalance: result.previousBalance,
        newBalance: result.newBalance,
        clamped: result.clamped,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Adjust balance error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/users/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { flagged, isMod, trustScore } = req.body as {
    flagged?: boolean;
    isMod?: boolean;
    trustScore?: number;
  };
  try {
    const updates: Partial<typeof users.$inferInsert> = {};
    if (flagged !== undefined) updates.flagged = flagged;
    if (isMod !== undefined) updates.isMod = isMod;
    if (trustScore !== undefined) updates.trustScore = trustScore;

    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Patch user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/users/:id/reddit-accounts", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const [user] = await db.select({ discordId: users.discordId }).from(users).where(eq(users.id, id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const rows = await pool.query(
      `SELECT id, reddit_username, account_age_days, post_karma, comment_karma, created_at
       FROM reddit_accounts
       WHERE discord_id = $1
       ORDER BY created_at ASC`,
      [user.discordId]
    );
    res.json(rows.rows.map((r: any) => ({
      id: r.id,
      redditUsername: r.reddit_username,
      accountAgeDays: r.account_age_days,
      postKarma: r.post_karma,
      commentKarma: r.comment_karma,
      createdAt: r.created_at,
    })));
  } catch (err) {
    req.log.error({ err }, "Get reddit accounts error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/users/:id/unverify", requireAdminRole, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (!user.verified) {
      res.status(400).json({ error: "User is not verified" });
      return;
    }

    let discordRoleRemoved = false;
    let discordWarning: string | null = null;
    try {
      const guild = getPrimaryGuild();
      if (guild) {
        const { verifiedRole } = await setupGuild(guild);
        const member = await guild.members.fetch(user.discordId).catch(() => null);
        if (member) {
          await member.roles.remove(verifiedRole).catch(() => {});
          discordRoleRemoved = true;
        } else {
          discordWarning = "Member is no longer in the Discord server.";
        }
      } else {
        discordWarning = "Discord bot is not connected; role was not removed.";
      }
    } catch (err) {
      req.log.error({ err, userId: id }, "Failed to remove verified Discord role");
      discordWarning = "Database updated, but removing the Discord role failed.";
    }

    const [updated] = await db
      .update(users)
      .set({ verified: false })
      .where(eq(users.id, id))
      .returning();

    req.log.info(
      {
        userId: id,
        discordId: user.discordId,
        discordRoleRemoved,
        actor: (req as any).session?.adminUser?.username,
      },
      "Admin unverified user"
    );

    invalidateUser(user.discordId, updated.id);
    res.json({ user: updated, discordRoleRemoved, warning: discordWarning });
  } catch (err) {
    req.log.error({ err }, "Unverify user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/users/:id/verify", requireAdminRole, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const { reddit_username } = req.body as { reddit_username?: string };
  const redditUsername = (reddit_username ?? "").trim().toLowerCase().replace(/^u\//i, "");

  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (user.verified) {
      res.status(400).json({ error: "User is already verified" });
      return;
    }

    const finalReddit = redditUsername || user.redditUsername || null;
    if (!finalReddit) {
      res.status(400).json({ error: "reddit_username is required — user has no Reddit account on file" });
      return;
    }

    // ---- Discord side-effects --------------------------------------------
    // Mirror what the /verifyuser slash command does so a dashboard verify
    // and a slash-command verify produce IDENTICAL results: role added,
    // workspace channel created, user DMed, log channel post sent.
    //
    // EVERY step here is wrapped so any failure (member not in guild, role
    // hierarchy issue for new accounts, Discord API hiccup, DMs disabled,
    // log channel missing, etc.) NEVER blocks the DB update. Worst case
    // we fall back to the previous "lite" behaviour: row marked verified.
    let discordRoleAdded = false;
    let workspaceChannelId: string | null = null;
    const discordWarnings: string[] = [];
    const guild = getPrimaryGuild();
    let member: any = null;
    let setup: Awaited<ReturnType<typeof setupGuild>> | null = null;

    if (!guild) {
      discordWarnings.push("Discord bot is not connected; role was not added.");
    } else {
      try {
        setup = await setupGuild(guild);
      } catch (err) {
        req.log.error({ err, userId: id }, "setupGuild failed during dashboard verify");
        discordWarnings.push("Discord server setup failed; role was not added.");
      }

      if (setup) {
        try {
          member = await guild.members.fetch(user.discordId).catch(() => null);
        } catch {
          member = null;
        }

        if (!member) {
          discordWarnings.push("Member is no longer in the Discord server.");
        } else {
          // Role add — the most common failure point for brand-new accounts
          // is role hierarchy (verified role above the bot's role). Capture
          // the actual error so the dashboard can show a meaningful message.
          try {
            await member.roles.add(setup.verifiedRole);
            discordRoleAdded = true;
          } catch (err: any) {
            req.log.error({ err: err?.message ?? String(err), userId: id, discordId: user.discordId }, "Failed to add verified role");
            discordWarnings.push("Could not add Verified role (check that the bot's role is above the Verified role).");
          }

          // Workspace channel — independent of role add success. A user
          // without a workspace channel can't pick up tasks, so this is
          // the most important side-effect to get right.
          try {
            const ws = await getOrCreateWorkspaceChannel(guild, member);
            workspaceChannelId = ws.id;
          } catch (err: any) {
            const msg = err?.message ?? String(err);
            req.log.error({ err: msg, userId: id, discordId: user.discordId }, "Workspace channel creation failed");
            // Surface the real reason so admins know whether it's a Discord
            // permission/limit problem (Manage Channels missing, 50-per-
            // category limit hit, 500-per-guild limit hit, etc.) vs a bug.
            discordWarnings.push(`Workspace channel could not be created: ${msg}`);
          }
        }
      }
    }

    const [updated] = await db
      .update(users)
      .set({
        verified: true,
        redditUsername: finalReddit,
        ...(workspaceChannelId ? { workspaceChannelId } : {}),
      })
      .where(eq(users.id, id))
      .returning();

    await db.insert(redditAccounts).values({
      discordId: user.discordId,
      redditUsername: finalReddit,
    }).onConflictDoNothing();

    req.log.info(
      {
        userId: id,
        discordId: user.discordId,
        redditUsername: finalReddit,
        discordRoleAdded,
        actor: (req as any).session?.adminUser?.username,
      },
      "Dashboard: admin verified user"
    );

    invalidateUser(user.discordId, updated.id);

    // ---- Notify the user (DM) -------------------------------------------
    // DM is best-effort: many users have DMs disabled. Never block on this.
    if (member && workspaceChannelId) {
      try {
        await member.send({
          embeds: [makeEmbed(COLORS.SUCCESS)
            .setTitle("You've been verified! 🎉")
            .setDescription(`An admin verified your account on **${guild!.name}**.\n\n📂 Workspace: <#${workspaceChannelId}>`)],
        });
      } catch {
        /* DMs disabled — ignore */
      }
    }

    // ---- Verification log channel post ----------------------------------
    // Mirrors the /verifyuser slash command's log post so admins always see
    // a record of dashboard verifications too.
    if (setup?.verificationLogChannel && member) {
      try {
        await setup.verificationLogChannel.send({
          embeds: [makeEmbed(COLORS.SUCCESS)
            .setTitle("✅ User Verified (Dashboard)")
            .addFields(
              { name: "Discord User", value: `<@${user.discordId}> (${member.user?.username ?? "unknown"})`, inline: true },
              { name: "Reddit Account", value: `u/${finalReddit}`, inline: true },
              { name: "Verified By", value: `${(req as any).session?.adminUser?.username ?? "dashboard admin"}`, inline: true },
            )],
        });
      } catch (err) {
        req.log.warn({ err, userId: id }, "Verification log post failed");
      }
    }

    res.json({
      user: updated,
      discordRoleAdded,
      workspaceChannelId,
      warning: discordWarnings.length ? discordWarnings.join(" ") : null,
    });
  } catch (err) {
    req.log.error({ err }, "Verify user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/tasks/:id/cancel", requireAdminRole, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const reason = ((req.body as any)?.reason ?? "Cancelled via dashboard").trim();

  try {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (task.status === "closed") {
      res.status(400).json({ error: "Task is already closed" });
      return;
    }

    await db.update(tasks).set({ status: "closed" }).where(eq(tasks.id, id));

    const expiredClaims = await db.execute<{ id: number; discord_id: string; workspace_message_id: string | null }>(
      sql`UPDATE claims SET status = 'expired' WHERE task_id = ${id} AND status = 'claimed' RETURNING id, discord_id, workspace_message_id`
    );

    try {
      const guild = getPrimaryGuild();
      if (guild) {
        // DM affected claimers and lock their workspace embeds
        for (const c of expiredClaims.rows) {
          const u = await guild.client.users.fetch(c.discord_id).catch(() => null);
          if (u) {
            await u.send({
              embeds: [
                makeEmbed(COLORS.WARNING)
                  .setTitle("⚠️ Task Cancelled")
                  .setDescription(`**Task #${id}** was cancelled by an admin. Your claim has been released.\n\n**Reason:** ${reason}`)
              ],
            }).catch(() => {});
          }

          // Remove Submit Proof button from the user's workspace embed
          if (c.workspace_message_id) {
            try {
              const userRow = await db.execute<{ workspace_channel_id: string | null }>(
                sql`SELECT workspace_channel_id FROM users WHERE discord_id = ${c.discord_id} LIMIT 1`
              );
              const wsChannelId = userRow.rows[0]?.workspace_channel_id;
              if (wsChannelId) {
                const ch = await guild.channels.fetch(wsChannelId).catch(() => null);
                if (ch && "messages" in ch) {
                  const wsMsg = await (ch as any).messages.fetch(c.workspace_message_id).catch(() => null);
                  if (wsMsg) {
                    await wsMsg.edit({
                      embeds: [
                        makeEmbed(COLORS.MUTED)
                          .setTitle(`❌ Task #${id} — CANCELLED`)
                          .setDescription(`This task was cancelled by an admin.\n\n**Reason:** ${reason}`)
                      ],
                      components: [],
                    });
                  }
                }
              }
            } catch (err) {
              logger.warn({ err, claimId: c.id }, "Could not lock workspace embed on dashboard task cancel");
            }
          }
        }

        // Edit the public task message in #tasks to remove the Claim button
        if (task.channelMessageId) {
          try {
            const { tasksChannel } = await setupGuild(guild);
            const msg = await tasksChannel.messages.fetch(task.channelMessageId).catch(() => null);
            if (msg) {
              await msg.edit({
                embeds: [
                  makeEmbed(COLORS.MUTED)
                    .setTitle(`❌ Task #${id} — CANCELLED`)
                    .setDescription(`This task was cancelled.\n\n**Reason:** ${reason}`)
                ],
                components: [],
              });
            }
          } catch (err) {
            logger.warn({ err, taskId: id }, "Could not edit task message on dashboard cancel");
          }
        }
      }
    } catch { /* Discord edits best-effort */ }

    req.log.info(
      { taskId: id, claimsReleased: expiredClaims.rows.length, actor: (req as any).session?.adminUser?.username },
      "Dashboard: task cancelled"
    );

    res.json({ ok: true, taskId: id, claimsReleased: expiredClaims.rows.length });
  } catch (err) {
    req.log.error({ err }, "Cancel task error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /admin/campaigns/:id/sheets-webhook
// Set (or clear) the per-campaign Google Sheets webhook URL. Body shape:
//   { sheetsWebhookUrl: "https://script.google.com/.../exec" | "" | null }
// Empty string or null → clears the override so the campaign falls back to
// the global GOOGLE_SHEETS_WEBHOOK_URL env var.
// ---------------------------------------------------------------------------
router.patch("/campaigns/:id/sheets-webhook", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid campaign id" });
    return;
  }
  const raw = (req.body as { sheetsWebhookUrl?: unknown })?.sheetsWebhookUrl;
  let normalized: string | null = null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      // Light validation — must look like a URL. Apps Script /exec is the
      // canonical shape but we don't hard-require it (the user might use a
      // proxy). Reject anything that obviously isn't an http(s) URL.
      if (!/^https?:\/\//i.test(trimmed)) {
        res.status(400).json({ error: "Webhook URL must start with http:// or https://" });
        return;
      }
      if (trimmed.length > 2048) {
        res.status(400).json({ error: "Webhook URL is unreasonably long (max 2048 chars)" });
        return;
      }
      normalized = trimmed;
    }
  }
  try {
    const r = await db.execute<{ id: string }>(
      sql`UPDATE campaigns SET sheets_webhook_url = ${normalized} WHERE id = ${id} RETURNING id`
    );
    if (r.rows.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    // Bust the in-memory cache so the new URL takes effect on the very next
    // submission instead of waiting up to 60s for the TTL to expire.
    try {
      const { invalidateSheetsConfigCache } = await import("../lib/sheetsLogger.js");
      invalidateSheetsConfigCache();
    } catch { /* swallow — cache will refresh on TTL anyway */ }
    res.json({ ok: true, sheetsWebhookUrl: normalized });
  } catch (err) {
    req.log.error({ err, id }, "Set campaign sheets webhook failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/campaigns/:id/create-sheet
// One-click "Create Sheet" button. Uses the service account to create a
// brand new Google Sheet (owned by the bot), writes headers, makes it
// shareable, saves the spreadsheet_id to the campaign, and returns the URL.
//
// Replaces the manual Apps Script setup entirely for this campaign — the
// next submission will land in the new sheet via Sheets API directly.
// ---------------------------------------------------------------------------
router.post("/campaigns/:id/create-sheet", requireAuth, async (req, res) => {
  // Strict digits-only ID validation — refuse "12abc", "1.5", "-3", etc.
  if (!/^\d+$/.test(req.params.id)) {
    res.status(400).json({ error: "Invalid campaign id" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  try {
    const gs = await import("../lib/googleSheets.js");
    const oauthConnected = await gs.isOAuthConnected();
    if (!oauthConnected && !gs.isGoogleSheetsConfigured()) {
      res.status(503).json({
        error:
          "Google not connected. Go to Settings → Google Sheets and click 'Connect Google' (recommended — uses your own 15 GB Drive, no subscription). " +
          "Advanced alternative: set GOOGLE_SERVICE_ACCOUNT_JSON env var on Render. " +
          gs.getServiceAccountError(),
      });
      return;
    }
    // Look up the campaign title for the sheet name AND check if a sheet
    // already exists. Pulling spreadsheet_id in the same query avoids a
    // second round-trip on the common "first-time create" path.
    const camp = await db.execute<{ title: string; sheets_spreadsheet_id: string | null }>(
      sql`SELECT title, sheets_spreadsheet_id FROM campaigns WHERE id = ${id} LIMIT 1`
    );
    if (camp.rows.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    // "Already exists" guard: if this campaign is already linked to a sheet,
    // refuse to create a duplicate unless the caller explicitly opts in via
    // body.force=true. This prevents an accidental second click (by the same
    // or a different admin) from orphaning the existing sheet in Drive and
    // silently switching the campaign's link. The dashboard shows a confirm
    // dialog and retries with force:true if the operator agrees.
    const existingId = camp.rows[0].sheets_spreadsheet_id?.trim();
    const force = (req.body as { force?: unknown })?.force === true;
    if (existingId && !force) {
      res.status(409).json({
        error: "Sheet already exists for this campaign.",
        existsSheetId: existingId,
        existsUrl: `https://docs.google.com/spreadsheets/d/${existingId}/edit`,
        hint: "Pass { force: true } to replace it with a new sheet. The old sheet stays in Drive but the campaign will point to the new one.",
      });
      return;
    }
    const title = `Outpost: ${camp.rows[0].title} (${new Date().toISOString().slice(0, 10)})`;

    const { spreadsheetId, url } = await gs.createCampaignSheet(title);

    // Save the ID and CLEAR any legacy webhook URL — new flow takes precedence.
    await db.execute(
      sql`UPDATE campaigns
          SET sheets_spreadsheet_id = ${spreadsheetId},
              sheets_webhook_url = NULL
          WHERE id = ${id}`
    );
    // Bust cache so next submission immediately uses the new sheet.
    try {
      const { invalidateSheetsConfigCache, backfillCampaignSheet } = await import("../lib/sheetsLogger.js");
      invalidateSheetsConfigCache();
      // Auto-backfill: if the campaign already has submissions (e.g. operator
      // created the sheet AFTER the campaign was running / completed), dump
      // them all into the new sheet so it isn't empty. Non-fatal on failure
      // — the sheet is still valid; just log + surface count in the response.
      const bf = await backfillCampaignSheet(id, spreadsheetId);
      if (!bf.ok) {
        req.log.warn({ err: bf.error, id }, "create-sheet: auto-backfill failed (sheet still usable)");
        res.json({ ok: true, spreadsheetId, url, backfilled: 0, backfillError: bf.error });
        return;
      }
      res.json({ ok: true, spreadsheetId, url, backfilled: bf.written });
      return;
    } catch { /* swallow */ }

    res.json({ ok: true, spreadsheetId, url });
  } catch (err) {
    // Extract the deepest Google API error message so the dashboard surfaces
    // the actual root cause (e.g. "Drive API not enabled in project XYZ",
    // "OAuth consent screen not configured", "billing required").
    const anyErr = err as any;
    const gApi =
      anyErr?.response?.data?.error?.message ??
      anyErr?.errors?.[0]?.message ??
      anyErr?.message ??
      "Unknown error";
    const gReason =
      anyErr?.response?.data?.error?.errors?.[0]?.reason ??
      anyErr?.errors?.[0]?.reason ??
      anyErr?.code ??
      "";
    const projectHint =
      anyErr?.response?.data?.error?.details?.[0]?.metadata?.consumer ??
      anyErr?.response?.data?.error?.details?.[0]?.metadata?.service ??
      "";
    req.log.error(
      { err, id, gApi, gReason, projectHint, fullGoogleError: anyErr?.response?.data?.error },
      "Create campaign sheet failed"
    );
    // Expose which project_id + service-account email the bot is actually
    // using — this lets the operator visually confirm that the JSON pasted
    // into the env var matches the project where APIs are enabled.
    const { getServiceAccountProjectId, getServiceAccountEmail, isOAuthConnected } = await import("../lib/googleSheets.js");
    const activeProjectId = getServiceAccountProjectId() ?? "(unknown)";
    const activeEmail = getServiceAccountEmail() ?? "(unknown)";
    const oauthOn = await isOAuthConnected();
    const hint = oauthOn
      ? "Your Google account is connected via OAuth. If you keep seeing errors, try Settings → Google Sheets → Disconnect, then Connect Google again. The token may have expired or been revoked at myaccount.google.com."
      : `EASIEST FIX (free, ~30s): Go to Settings → Google Sheets → click "Connect Google". The bot will use your own Drive (15 GB free) instead of the broken service account path. No subscription, no folder setup. Advanced legacy fallback: create a folder in your Drive, share with ${activeEmail} as Editor, copy folder ID into SHEETS_PARENT_FOLDER_ID env var on Render.`;
    res.status(500).json({
      error: `Google API: ${gApi}${gReason ? ` [${gReason}]` : ""}${projectHint ? ` (${projectHint})` : ""}`,
      activeProjectId,
      activeEmail,
      hint,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/campaigns/:id/backfill-sheet
// Re-runs the backfill on an EXISTING linked sheet. Useful when the operator
// created the sheet AFTER the campaign already had submissions, so the sheet
// started out empty. Idempotent in the "Google appends rows" sense — calling
// this twice will duplicate rows, so the dashboard confirms before running.
// ---------------------------------------------------------------------------
router.post("/campaigns/:id/backfill-sheet", requireAuth, async (req, res) => {
  if (!db) {
    res.status(503).json({ error: "Database not available" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  try {
    const camp = await db.execute<{ sheets_spreadsheet_id: string | null; title: string }>(
      sql`SELECT sheets_spreadsheet_id, title FROM campaigns WHERE id = ${id} LIMIT 1`
    );
    if (camp.rows.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    const spreadsheetId = camp.rows[0].sheets_spreadsheet_id?.trim();
    if (!spreadsheetId) {
      res.status(400).json({
        error: "No Google Sheet linked to this campaign yet. Click 'Create New Google Sheet' first.",
      });
      return;
    }
    const { backfillCampaignSheet } = await import("../lib/sheetsLogger.js");
    const result = await backfillCampaignSheet(id, spreadsheetId);
    if (!result.ok) {
      res.status(500).json({ error: result.error ?? "Backfill failed", written: 0 });
      return;
    }
    res.json({ ok: true, written: result.written });
  } catch (err) {
    req.log.error({ err, id }, "Backfill sheet failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/campaigns/:id/unlink-sheet
// Clear both spreadsheet_id AND webhook_url for a campaign so it falls back
// to the global env fallback (or nothing). Sheet itself is NOT deleted from
// Google — operator can keep using it independently.
// ---------------------------------------------------------------------------
router.post("/campaigns/:id/unlink-sheet", requireAuth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) {
    res.status(400).json({ error: "Invalid campaign id" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  try {
    const r = await db.execute<{ id: string }>(
      sql`UPDATE campaigns
          SET sheets_spreadsheet_id = NULL, sheets_webhook_url = NULL
          WHERE id = ${id}
          RETURNING id`
    );
    if (r.rows.length === 0) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    try {
      const { invalidateSheetsConfigCache } = await import("../lib/sheetsLogger.js");
      invalidateSheetsConfigCache();
    } catch { /* swallow */ }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err, id }, "Unlink campaign sheet failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/sheets/backfill
// Re-push every submission within a date range (and optional campaign filter)
// to its Google Sheet. Use when you set up a sheet AFTER the fact, or to
// rebuild a sheet for a specific date range for the accountant. Body shape:
//   { from: "YYYY-MM-DD", to: "YYYY-MM-DD", campaignId?: number }
// Returns { ok, queued, capped } — capped=true if more than the per-call
// MAX matched (cron-style: split into multiple calls).
// ---------------------------------------------------------------------------
router.post("/sheets/backfill", requireAuth, async (req, res) => {
  const BACKFILL_MAX = 500;
  const body = (req.body ?? {}) as { from?: unknown; to?: unknown; campaignId?: unknown };
  const fromStr = typeof body.from === "string" ? body.from : "";
  const toStr = typeof body.to === "string" ? body.to : "";
  const campaignId = typeof body.campaignId === "number" && Number.isFinite(body.campaignId)
    ? Math.trunc(body.campaignId) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
    res.status(400).json({ error: "from / to must be YYYY-MM-DD dates" });
    return;
  }
  try {
    const { logSubmissionEvent } = await import("../lib/sheetsLogger.js");
    let rows;
    if (campaignId !== null) {
      rows = (await db.execute<{ id: string; review_status: string; live_status: string }>(
        sql`SELECT s.id, s.review_status, s.live_status
            FROM submissions s
            JOIN tasks t ON t.id = s.task_id
            WHERE s.submitted_at >= ${fromStr}::date
              AND s.submitted_at <  (${toStr}::date + interval '1 day')
              AND t.campaign_id = ${campaignId}
            ORDER BY s.submitted_at ASC
            LIMIT ${BACKFILL_MAX + 1}`
      )).rows;
    } else {
      rows = (await db.execute<{ id: string; review_status: string; live_status: string }>(
        sql`SELECT id, review_status, live_status
            FROM submissions
            WHERE submitted_at >= ${fromStr}::date
              AND submitted_at <  (${toStr}::date + interval '1 day')
            ORDER BY submitted_at ASC
            LIMIT ${BACKFILL_MAX + 1}`
      )).rows;
    }
    const capped = rows.length > BACKFILL_MAX;
    const slice = capped ? rows.slice(0, BACKFILL_MAX) : rows;
    // Use a generic "submitted" event for the backfill so the sheet shows
    // the canonical row state. Fire-and-forget for each — the loop returns
    // immediately so the dashboard request doesn't hang.
    for (const r of slice) {
      logSubmissionEvent(parseInt(r.id), "submitted");
    }
    res.json({ ok: true, queued: slice.length, capped });
  } catch (err) {
    req.log.error({ err }, "Sheets backfill failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/campaigns/:id/cancel", requireAdminRole, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const reason = ((req.body as any)?.reason ?? "Cancelled via dashboard").trim();

  try {
    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }
    if (campaign.status === "cancelled") {
      res.status(400).json({ error: "Campaign is already cancelled" });
      return;
    }

    await db.execute(sql`UPDATE campaigns SET status = 'cancelled' WHERE id = ${id}`);

    // BUG FIX: the prior filter — creator_discord_id + created_at>=campaign
    // start — would close EVERY open task that creator started after the
    // campaign began, including tasks belonging to other campaigns or
    // standalone /task posts. Filter strictly by campaign_id so cancelling
    // one campaign only touches its own tasks.
    const openTasks = await db.execute<{ id: number; title: string; channel_message_id: string | null }>(
      sql`UPDATE tasks SET status = 'closed'
          WHERE campaign_id = ${id}
            AND status = 'open'
          RETURNING id, title, channel_message_id`
    );

    let releasedClaims = 0;
    try {
      const guild = getPrimaryGuild();
      for (const t of openTasks.rows) {
        const expired = await db.execute<{ id: number; discord_id: string; workspace_message_id: string | null }>(
          sql`UPDATE claims SET status = 'expired' WHERE task_id = ${t.id} AND status = 'claimed' RETURNING id, discord_id, workspace_message_id`
        );
        releasedClaims += expired.rows.length;
        if (guild) {
          for (const c of expired.rows) {
            const u = await guild.client.users.fetch(c.discord_id).catch(() => null);
            if (u) {
              await u.send({
                embeds: [
                  makeEmbed(COLORS.WARNING)
                    .setTitle("⚠️ Campaign Cancelled")
                    .setDescription(`Campaign **"${campaign.title}"** was cancelled. **Task #${t.id}** has been closed and your claim released.\n\n**Reason:** ${reason}`)
                ],
              }).catch(() => {});
            }

            // Remove Submit Proof button from the user's workspace embed
            if (c.workspace_message_id) {
              try {
                const userRow = await db.execute<{ workspace_channel_id: string | null }>(
                  sql`SELECT workspace_channel_id FROM users WHERE discord_id = ${c.discord_id} LIMIT 1`
                );
                const wsChannelId = userRow.rows[0]?.workspace_channel_id;
                if (wsChannelId) {
                  const ch = await guild.channels.fetch(wsChannelId).catch(() => null);
                  if (ch && "messages" in ch) {
                    const wsMsg = await (ch as any).messages.fetch(c.workspace_message_id).catch(() => null);
                    if (wsMsg) {
                      await wsMsg.edit({
                        embeds: [
                          makeEmbed(COLORS.MUTED)
                            .setTitle(`❌ Task #${t.id} — CAMPAIGN CANCELLED`)
                            .setDescription(`Campaign **"${campaign.title}"** was cancelled.\n\n**Reason:** ${reason}`)
                        ],
                        components: [],
                      });
                    }
                  }
                }
              } catch (err) {
                logger.warn({ err, claimId: c.id }, "Could not lock workspace embed on dashboard campaign cancel");
              }
            }
          }

          // Edit the public task message in #tasks to remove the Claim button
          if (t.channel_message_id) {
            try {
              const { tasksChannel } = await setupGuild(guild);
              const msg = await tasksChannel.messages.fetch(t.channel_message_id).catch(() => null);
              if (msg) {
                await msg.edit({
                  embeds: [
                    makeEmbed(COLORS.MUTED)
                      .setTitle(`❌ Task #${t.id} — CAMPAIGN CANCELLED`)
                      .setDescription(`This task was part of campaign **"${campaign.title}"** which was cancelled.\n\n**Reason:** ${reason}`)
                  ],
                  components: [],
                });
              }
            } catch (err) {
              logger.warn({ err, taskId: t.id }, "Could not edit task message on dashboard campaign cancel");
            }
          }
        }
      }
    } catch { /* Discord edits best-effort */ }

    await db.execute(
      sql`UPDATE campaign_queue SET status = 'cancelled' WHERE campaign_id = ${id} AND status = 'pending'`
    );

    req.log.info(
      { campaignId: id, tasksClosed: openTasks.rows.length, releasedClaims, actor: (req as any).session?.adminUser?.username },
      "Dashboard: campaign cancelled"
    );

    res.json({ ok: true, campaignId: id, tasksClosed: openTasks.rows.length, releasedClaims });
  } catch (err) {
    req.log.error({ err }, "Cancel campaign error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/submissions", requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1")));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"))));
  const status = req.query.status as string | undefined;
  const offset = (page - 1) * limit;

  try {
    const statusFilter = status ? eq(submissions.reviewStatus, status) : undefined;

    const rows = await pool.query(
      `SELECT s.*, u.discord_username,
              t.title AS task_title,
              t.creator_discord_id AS task_creator_discord_id,
              cu.discord_username AS task_creator_username,
              ra.username AS reviewer_admin_username,
              ra.discord_username AS reviewer_discord_username,
              ra.discord_avatar AS reviewer_discord_avatar
       FROM submissions s
       LEFT JOIN users u ON s.user_id = u.id
       LEFT JOIN tasks t ON t.id = s.task_id
       LEFT JOIN users cu ON cu.discord_id = t.creator_discord_id
       LEFT JOIN admin_users ra ON (
         ra.discord_id = s.reviewer_discord_id
         OR (s.reviewer_discord_id LIKE 'dashboard:%' AND ra.username = substring(s.reviewer_discord_id from 11))
       )
       ${status ? `WHERE s.review_status = $3` : ""}
       ORDER BY s.submitted_at DESC
       LIMIT $1 OFFSET $2`,
      status ? [limit, offset, status] : [limit, offset]
    );

    const countRow = await pool.query(
      `SELECT COUNT(*) FROM submissions ${status ? `WHERE review_status = $1` : ""}`,
      status ? [status] : []
    );

    const mapped = rows.rows.map((r: any) => {
      // Derive a friendly reviewer display name regardless of source.
      let reviewerName: string | null = null;
      if (r.reviewer_discord_username) reviewerName = r.reviewer_discord_username;
      else if (r.reviewer_admin_username) reviewerName = r.reviewer_admin_username;
      else if (typeof r.reviewer_discord_id === "string") {
        reviewerName = r.reviewer_discord_id.startsWith("dashboard:")
          ? r.reviewer_discord_id.slice("dashboard:".length)
          : r.reviewer_discord_id;
      }
      // Friendly task-creator display: dashboard pseudo-id → "Dashboard · alice",
      // real id → looked-up Discord username (falls back to id).
      let taskCreatorName: string | null = null;
      const creatorId: string | null = r.task_creator_discord_id ?? null;
      if (creatorId) {
        if (creatorId.startsWith("dashboard:")) {
          taskCreatorName = `Dashboard · ${creatorId.slice("dashboard:".length)}`;
        } else {
          taskCreatorName = r.task_creator_username ?? creatorId;
        }
      }
      return {
        id: r.id,
        claimId: r.claim_id,
        taskId: r.task_id,
        userId: r.user_id,
        discordId: r.discord_id,
        discordUsername: r.discord_username ?? null,
        proofLink: r.proof_link,
        reward: r.reward,
        reviewStatus: r.review_status,
        reviewReason: r.review_reason ?? null,
        submittedAt: r.submitted_at,
        reviewedAt: r.reviewed_at ?? null,
        liveStatus: r.live_status ?? "unknown",
        lastCheckedAt: r.last_checked_at ?? null,
        removalReason: r.removal_reason ?? null,
        liveStatusChangedAt: r.live_status_changed_at ?? null,
        reviewerDiscordId: r.reviewer_discord_id ?? null,
        reviewerName,
        reviewerAvatar: r.reviewer_discord_avatar ?? null,
        taskTitle: r.task_title ?? null,
        taskCreatorDiscordId: creatorId,
        taskCreatorName,
      };
    });

    res.json({
      submissions: mapped,
      total: parseInt(countRow.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    req.log.error({ err }, "List submissions error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/submissions/:id", requireAdminRole, async (req, res) => {
  const id = parseInt(req.params.id);
  const { reviewStatus: rawStatus, reviewReason } = req.body as {
    reviewStatus: string;
    reviewReason?: string;
  };
  // Normalize dashboard "approved" → bot-canonical "accepted" so the two systems stay in sync.
  const reviewStatus = rawStatus === "approved" ? "accepted" : rawStatus;
  const sessionUser = (req as any).session?.adminUser;

  try {
    const [prevSub] = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);

    // Prefer the linked Discord ID for this admin if they've connected via OAuth.
    // Falls back to the legacy "dashboard:<username>" sentinel when unlinked.
    let reviewerDiscordId = `dashboard:${sessionUser?.username ?? "unknown"}`;
    if (sessionUser?.id) {
      try {
        const r = await pool.query<{ discord_id: string | null }>(
          `SELECT discord_id FROM admin_users WHERE id = $1`,
          [sessionUser.id]
        );
        if (r.rows[0]?.discord_id) reviewerDiscordId = r.rows[0].discord_id;
      } catch { /* keep fallback */ }
    }

    // ATOMIC CAS — the eq(id) update alone is TOCTOU vs the bot's
    // handleSubAccept / handleSubReviewReason (and vs another dashboard
    // tab) — two reviewers approving the same submission would each fall
    // into the justAccepted branch below and credit balance_pending twice.
    // Pin the previous review_status into the WHERE so only one of the
    // racing updates wins; the other gets rowCount=0 and we bail out.
    const prevStatus = prevSub?.reviewStatus ?? null;
    const [updated] = await db
      .update(submissions)
      .set({
        reviewStatus,
        reviewReason: reviewReason ?? null,
        reviewedAt: new Date(),
        reviewerDiscordId,
      })
      .where(prevStatus === null
        ? and(eq(submissions.id, id), sql`review_status IS NULL`)
        : and(eq(submissions.id, id), eq(submissions.reviewStatus, prevStatus)))
      .returning();
    if (!updated) {
      // Either the submission doesn't exist, or its review_status changed
      // between the read above and this write (another reviewer raced us).
      const [stillThere] = await db.select({ id: submissions.id }).from(submissions).where(eq(submissions.id, id)).limit(1);
      if (!stillThere) {
        res.status(404).json({ error: "Submission not found" });
      } else {
        res.status(409).json({ error: "Submission was just reviewed by someone else. Refresh and try again." });
      }
      return;
    }

    // If submission was just accepted and wasn't accepted before, credit the user's balance.
    const justAccepted = reviewStatus === "accepted" && prevSub?.reviewStatus !== "accepted";
    if (justAccepted) {
      // Guard: if the payout was already cleared by the pendingProcessor
      // (moved_to_available = 1), do NOT re-queue it or double-credit
      // balance_pending. This handles the reject → re-accept cycle on the
      // dashboard where justAccepted fires again even though the submission
      // was already paid out, which previously caused a second "Payout
      // Cleared" notification and inflated the user's balance.
      if (prevSub?.movedToAvailable === 1) {
        req.log.warn(
          { submissionId: updated.id, userId: updated.userId },
          "Dashboard: re-accept on already-cleared submission — skipping balance credit and queue reset to prevent double-payout"
        );
      } else {
        // Enforce a 10-minute minimum hold on all first-time accepts so the
        // early liveness check (fires at 5 min post-accept) always runs before
        // the pending processor can release funds. Without this, accepting a
        // submission with available_at in the past (e.g. 0-delay tasks) would
        // immediately credit balance_available and set moved_to_available=1,
        // making the deletion check say "already processed" when the post is gone.
        const MIN_HOLD_MS = 10 * 60 * 1000;
        const rawAvailableAt = updated.availableAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
        const safeAvailableAt = rawAvailableAt.getTime() < Date.now() + MIN_HOLD_MS
          ? new Date(Date.now() + MIN_HOLD_MS)
          : rawAvailableAt;

        // Always route through the pending queue — never immediate balance_available
        // credit on a first-time accept. The pendingProcessor will release funds
        // once safeAvailableAt arrives and the early liveness check has had a
        // chance to catch deletions.
        await pool.query(
          `UPDATE users SET balance_pending = balance_pending + $1 WHERE id = $2`,
          [updated.reward, updated.userId]
        );
        await pool.query(
          `UPDATE submissions SET available_at = $1, moved_to_available = 0 WHERE id = $2`,
          [safeAvailableAt, updated.id]
        );
        req.log.info({ submissionId: updated.id, userId: updated.userId, reward: updated.reward, safeAvailableAt }, "Dashboard: submission accepted, queued for pending release");
      }
    }

    // ----- Dashboard reject/flag mirror -----
    // The bot's handleSubReviewReason does FOUR things on reject/flag:
    //   1. Flip the claim status (so the worker's workspace card unlocks).
    //   2. Decrement tasks.slots_filled so the slot returns to #tasks.
    //   3. Penalize trust (-3 reject, -10 flag) + flag user on "flag".
    //   4. Notify the worker (DM + reply on their workspace task card).
    // Before this block the dashboard PATCH only persisted reviewStatus on
    // the submission row, leaving the claim stuck in "submitted", the slot
    // permanently consumed, and the worker in the dark. Mirror all four
    // here, but only on the FIRST transition from non-rejected/flagged
    // into rejected/flagged so retries can't double-penalize.
    const justRejected = (reviewStatus === "rejected" || reviewStatus === "flagged")
      && prevSub?.reviewStatus !== "rejected"
      && prevSub?.reviewStatus !== "flagged";
    if (justRejected) {
      const trustDelta = reviewStatus === "flagged" ? -10 : -3;
      await db.update(claims).set({ status: reviewStatus }).where(eq(claims.id, updated.claimId));
      await pool.query(
        `UPDATE tasks SET slots_filled = GREATEST(0, slots_filled - 1) WHERE id = $1`,
        [updated.taskId]
      );
      await pool.query(
        `UPDATE users SET trust_score = GREATEST(0, trust_score + $1) WHERE id = $2`,
        [trustDelta, updated.userId]
      );
      if (reviewStatus === "flagged") {
        await pool.query(`UPDATE users SET flagged = true WHERE id = $1`, [updated.userId]);
      }
      // Fire-and-forget: DM the worker + reply on their workspace task card.
      // Failures here (closed DM, deleted workspace channel) must NOT roll
      // back the DB state above — the verdict is already recorded.
      (async () => {
        try {
          const guild = getPrimaryGuild();
          if (!guild) return;
          const [u] = await db.select().from(users).where(eq(users.id, updated.userId)).limit(1);
          if (!u) return;
          const [t] = await db.select().from(tasks).where(eq(tasks.id, updated.taskId)).limit(1);
          const title = t?.title ?? `Task #${updated.taskId}`;
          const reason = updated.reviewReason ?? "(no reason provided)";
          const verdictEmbed = makeEmbed(reviewStatus === "flagged" ? COLORS.MUTED : COLORS.DANGER)
            .setTitle(reviewStatus === "flagged" ? "🚩 Submission Flagged" : "❌ Submission Rejected")
            .setDescription(
              `Your submission for **${title}** was ${reviewStatus}.\n\n` +
              `**Reason:** ${reason}\n\n` +
              (reviewStatus === "rejected"
                ? `The slot has been reopened in #tasks — you can grab a fresh task there.`
                : `Your account has been flagged for review. Reach out to staff if you think this is a mistake.`)
            );
          try {
            const member = await guild.members.fetch(u.discordId);
            await member.send({ embeds: [verdictEmbed] }).catch(() => {});
          } catch { /* user left guild */ }
          const [c] = await db.select().from(claims).where(eq(claims.id, updated.claimId)).limit(1);
          const wsMessageId = c?.workspaceMessageId;
          const wsChannelId = u.workspaceChannelId;
          if (wsMessageId && wsChannelId) {
            const ch = await guild.channels.fetch(wsChannelId).catch(() => null);
            if (ch && "messages" in ch) {
              const original = await (ch as any).messages.fetch(wsMessageId).catch(() => null);
              if (original) {
                await original.reply({ embeds: [verdictEmbed], allowedMentions: { repliedUser: false } });
              } else {
                await (ch as any).send({ content: `<@${u.discordId}>`, embeds: [verdictEmbed] });
              }
            }
          }
        } catch (err) {
          req.log.warn({ err, subId: updated.id }, "Dashboard reject/flag: worker notify failed");
        }
      })();
      req.log.info({ submissionId: updated.id, userId: updated.userId, taskId: updated.taskId, reviewStatus }, "Dashboard: submission rejected/flagged, slot reopened");
    }

    invalidateUser(updated.discordId, updated.userId);

    const [user] = await db.select().from(users).where(eq(users.id, updated.userId)).limit(1);
    res.json({
      id: updated.id,
      claimId: updated.claimId,
      taskId: updated.taskId,
      userId: updated.userId,
      discordId: updated.discordId,
      discordUsername: user?.discordUsername ?? null,
      proofLink: updated.proofLink,
      reward: updated.reward,
      reviewStatus: updated.reviewStatus,
      reviewReason: updated.reviewReason ?? null,
      submittedAt: updated.submittedAt,
      reviewedAt: updated.reviewedAt ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Patch submission error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// CSV export helpers. Kept local because the existing `csvField` in
// sheetImporter.ts is tuned for *parsing* import CSVs and we only need a tiny
// quoter here for *generating* export CSVs.
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/\r?\n/g, " ").replace(/\t/g, " ");
  if (/[",]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRows(headers: string[], rows: unknown[][]): string {
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return lines.join("\n") + "\n";
}
function dateStamp(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function safeFilename(name: string): string {
  return (name || "untitled").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);
}

// Per-campaign report: every task in the campaign + roll-up submission counts.
router.get("/campaigns/:id/export.csv", requireAuth, async (req, res) => {
  const campaignId = Number(req.params.id);
  if (!Number.isFinite(campaignId)) {
    res.status(400).json({ error: "Invalid campaign id" });
    return;
  }
  try {
    const campRes = await db.execute<{ id: number; title: string; status: string; created_at: string; total_tasks: number; tasks_created: number }>(
      sql`SELECT id, title, status, created_at, total_tasks, tasks_created FROM campaigns WHERE id = ${campaignId} LIMIT 1`
    );
    const camp = campRes.rows[0];
    if (!camp) {
      res.status(404).json({ error: "Campaign not found" });
      return;
    }

    // Tasks linked via campaign_queue.posted_task_id, plus a left-joined
    // submission count broken down by review_status. One row per task.
    const taskRows = await db.execute<{
      task_id: number; title: string; type: string; reward: string;
      reddit_link: string; status: string; slots_filled: number; max_slots: number;
      created_at: string; closes_at: string | null;
      subs_total: string; subs_accepted: string; subs_rejected: string; subs_pending: string;
    }>(sql`
      SELECT
        t.id AS task_id, t.title, t.type, t.reward, t.reddit_link, t.status,
        t.slots_filled, t.max_slots, t.created_at, t.closes_at,
        COALESCE((SELECT COUNT(*)::text FROM submissions s WHERE s.task_id = t.id), '0') AS subs_total,
        COALESCE((SELECT COUNT(*)::text FROM submissions s WHERE s.task_id = t.id AND s.review_status = 'accepted'), '0') AS subs_accepted,
        COALESCE((SELECT COUNT(*)::text FROM submissions s WHERE s.task_id = t.id AND s.review_status = 'rejected'), '0') AS subs_rejected,
        COALESCE((SELECT COUNT(*)::text FROM submissions s WHERE s.task_id = t.id AND s.review_status IN ('pending', 'pending_hold')), '0') AS subs_pending
      FROM campaign_queue cq
      JOIN tasks t ON t.id = cq.posted_task_id
      WHERE cq.campaign_id = ${campaignId} AND cq.posted_task_id IS NOT NULL
      ORDER BY t.id ASC;
    `);

    const csv = csvRows(
      ["Task ID", "Title", "Type", "Reward", "Reddit Link", "Status", "Slots Filled", "Max Slots", "Submissions Total", "Approved", "Rejected", "Pending", "Created At", "Closes At"],
      taskRows.rows.map((r) => [
        r.task_id, r.title, r.type, r.reward, r.reddit_link, r.status,
        r.slots_filled, r.max_slots,
        r.subs_total, r.subs_accepted, r.subs_rejected, r.subs_pending,
        r.created_at, r.closes_at ?? "",
      ]),
    );

    const filename = `campaign-${camp.id}-${safeFilename(camp.title)}-${dateStamp()}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error({ err, campaignId }, "campaign CSV export failed");
    res.status(500).json({ error: (err as Error)?.message ?? "Export failed" });
  }
});

// Per-task report: full task details + every submission with worker + status.
router.get("/tasks/:id/export.csv", requireAuth, async (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isFinite(taskId)) {
    res.status(400).json({ error: "Invalid task id" });
    return;
  }
  try {
    const taskRes = await db.execute<{
      id: number; title: string; type: string; reward: string;
      reddit_link: string; status: string; slots_filled: number; max_slots: number;
      created_at: string; closes_at: string | null;
    }>(sql`
      SELECT id, title, type, reward, reddit_link, status, slots_filled, max_slots, created_at, closes_at
      FROM tasks WHERE id = ${taskId} LIMIT 1
    `);
    const task = taskRes.rows[0];
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const subRows = await db.execute<{
      submission_id: number; discord_id: string; discord_username: string | null;
      reddit_username: string | null; proof_link: string; reward: string;
      review_status: string; review_reason: string | null;
      submitted_at: string; reviewed_at: string | null;
      live_status: string | null; removal_reason: string | null;
    }>(sql`
      SELECT
        s.id AS submission_id, s.discord_id, u.discord_username, u.reddit_username,
        s.proof_link, s.reward, s.review_status, s.review_reason,
        s.submitted_at, s.reviewed_at, s.live_status, s.removal_reason
      FROM submissions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.task_id = ${taskId}
      ORDER BY s.submitted_at ASC;
    `);

    // Two-section CSV: a one-row task summary on top, then a blank line, then
    // the submissions table. Spreadsheets read this fine and it keeps
    // everything in one downloadable file.
    const summary = csvRows(
      ["Task ID", "Title", "Type", "Reward", "Reddit Link", "Status", "Slots Filled", "Max Slots", "Created At", "Closes At"],
      [[task.id, task.title, task.type, task.reward, task.reddit_link, task.status, task.slots_filled, task.max_slots, task.created_at, task.closes_at ?? ""]],
    );
    const submissionsCsv = csvRows(
      ["Submission ID", "Discord ID", "Discord Username", "Reddit Username", "Proof Link", "Reward", "Review Status", "Review Reason", "Submitted At", "Reviewed At", "Live Status", "Removal Reason"],
      subRows.rows.map((r) => [
        r.submission_id, r.discord_id, r.discord_username ?? "", r.reddit_username ?? "",
        r.proof_link, r.reward, r.review_status, r.review_reason ?? "",
        r.submitted_at, r.reviewed_at ?? "", r.live_status ?? "", r.removal_reason ?? "",
      ]),
    );
    const csv = `${summary}\nSubmissions\n${submissionsCsv}`;

    const filename = `task-${task.id}-${safeFilename(task.title)}-${dateStamp()}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    logger.error({ err, taskId }, "task CSV export failed");
    res.status(500).json({ error: (err as Error)?.message ?? "Export failed" });
  }
});

router.get("/campaigns", requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*,
              ca.username AS creator_admin_username,
              ca.discord_username AS creator_discord_username,
              ca.discord_avatar AS creator_discord_avatar
       FROM campaigns c
       LEFT JOIN admin_users ca ON (
         ca.discord_id = c.creator_discord_id
         OR (c.creator_discord_id LIKE 'dashboard:%' AND ca.username = substring(c.creator_discord_id from 11))
       )
       ORDER BY c.created_at DESC`
    );
    const mapped = r.rows.map((row: any) => {
      let creatorName: string | null = null;
      if (row.creator_discord_username) creatorName = row.creator_discord_username;
      else if (row.creator_admin_username) creatorName = row.creator_admin_username;
      else if (typeof row.creator_discord_id === "string") {
        creatorName = row.creator_discord_id.startsWith("dashboard:")
          ? row.creator_discord_id.slice("dashboard:".length)
          : row.creator_discord_id;
      }
      return {
        id: row.id,
        title: row.title,
        sourceType: row.source_type,
        sourceUrl: row.source_url,
        totalTasks: row.total_tasks,
        tasksCreated: row.tasks_created,
        status: row.status,
        createdAt: row.created_at,
        creatorDiscordId: row.creator_discord_id ?? null,
        creatorName,
        creatorAvatar: row.creator_discord_avatar ?? null,
        // Per-campaign Google Sheets webhook URL (NULL → uses env fallback).
        sheetsWebhookUrl: row.sheets_webhook_url ?? null,
        // Per-campaign Sheets API spreadsheet ID (NEW "Create Sheet" flow).
        sheetsSpreadsheetId: row.sheets_spreadsheet_id ?? null,
        sheetsUrl: row.sheets_spreadsheet_id
          ? `https://docs.google.com/spreadsheets/d/${row.sheets_spreadsheet_id}/edit`
          : null,
      };
    });
    // Also expose whether Google is configured (so the dashboard
    // can grey-out the "Create Sheet" button with a helpful message).
    let sheetsServiceConfigured = false;
    let sheetsServiceEmail: string | null = null;
    let sheetsOAuthConnected = false;
    try {
      const gs = await import("../lib/googleSheets.js");
      sheetsServiceConfigured = gs.isGoogleSheetsConfigured();
      sheetsServiceEmail = gs.getServiceAccountEmail();
      sheetsOAuthConnected = await gs.isOAuthConnected();
    } catch { /* swallow */ }
    res.json({ campaigns: mapped, sheetsServiceConfigured, sheetsServiceEmail, sheetsOAuthConnected });
  } catch (err) {
    req.log.error({ err }, "List campaigns error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/tasks", requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1")));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"))));
  const status = req.query.status as string | undefined;
  const offset = (page - 1) * limit;

  try {
    const rows = await pool.query(
      `SELECT * FROM tasks ${status ? `WHERE status = $3` : ""}
       ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      status ? [limit, offset, status] : [limit, offset]
    );
    const countRow = await pool.query(
      `SELECT COUNT(*) FROM tasks ${status ? `WHERE status = $1` : ""}`,
      status ? [status] : []
    );
    const mapped = rows.rows.map((r: any) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      reward: r.reward,
      maxSlots: r.max_slots,
      slotsFilled: r.slots_filled,
      status: r.status,
      createdAt: r.created_at,
    }));
    res.json({ tasks: mapped, total: parseInt(countRow.rows[0].count), page, limit });
  } catch (err) {
    req.log.error({ err }, "List tasks error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/liveness/run-now", requireAuth, async (req, res) => {
  const result = await runLivenessTickNow();
  if (!result.ok) return res.status(503).json(result);
  res.json(result);
});

// Bulk all-time liveness scan — checks every accepted live submission regardless
// of age. Starts in the background and returns immediately with the total count.
router.post("/liveness/bulk-scan-all", requireAdminRole, async (_req, res) => {
  const result = await startBulkLivenessScanAllTime();
  if (!result.ok) return res.status(503).json(result);
  res.json(result);
});

// Returns whether a bulk scan is currently running.
router.get("/liveness/bulk-scan-status", requireAuth, (_req, res) => {
  res.json({ running: isBulkScanRunning() });
});

router.post("/sweep/run-now", requireAuth, async (req, res) => {
  const { runPendingSweepNow } = await import("../bot/pendingReviewSweeper.js");
  const result = await runPendingSweepNow();
  if (!result.ok) return res.status(503).json(result);
  res.json(result);
});

// Manually trigger one pass of the post-payout checker (24h paid-out comment scan).
router.post("/post-payout/run-now", requireAdminRole, async (req, res) => {
  const guild = getPrimaryGuild();
  if (!guild) return res.status(503).json({ error: "Bot not connected" });
  const result = await runPostPayoutCheckNow(guild.client);
  if (!result.ok) return res.status(503).json(result);
  res.json(result);
});

// Slow sweep — 5 submissions at a time, 3s gap between each.
// Safe for clearing a backlog without hammering Reddit proxies.
// Returns { decided, skipped, pendingTotal, pendingOutsideWindow } so the UI can show progress.
router.post("/sweep/run-slow", requireAuth, async (req, res) => {
  const { runPendingSlowSweepNow } = await import("../bot/pendingReviewSweeper.js");
  const forceBacklog = req.body?.forceBacklog === true;
  const result = await runPendingSlowSweepNow(forceBacklog);
  if (!result.ok) return res.status(503).json(result);
  res.json(result);
});


router.post("/reddit-test", requireAuth, async (req, res) => {
  const { url, expectedAuthor, expectedSubreddit } = req.body as {
    url: string;
    expectedAuthor?: string;
    expectedSubreddit?: string;
  };
  if (!url) {
    res.status(400).json({ error: "URL required" });
    return;
  }
  try {
    const authorParam = expectedAuthor ? [expectedAuthor] : [];
    const taskRedditLink = expectedSubreddit 
      ? `r/${expectedSubreddit.replace(/^\/?r\//i, "")}`
      : "";

    const validation = await validateRedditProof(url, authorParam, taskRedditLink);

    res.json({
      valid: validation.passed,
      author: validation.authorFound ?? null,
      subreddit: validation.subredditFound ?? null,
      title: validation.title ?? null,
      error: validation.failures.join("; ") || null,
    });
  } catch (err: any) {
    res.json({ valid: false, error: err?.message ?? "Fetch error" });
  }
});

// Bulk Reddit URL liveness checker. Accepts a list of URLs, fetches each one
// directly from Reddit (same JSON endpoint /reddit-test uses) in parallel
// with a small concurrency cap, and returns liveness/author/subreddit/posted
// timestamp/removal reason for each. Read-only — does not touch the DB.
router.post("/reddit-bulk-check", requireAuth, async (req, res) => {
  const body = req.body as { urls?: unknown };
  const rawUrls = Array.isArray(body?.urls) ? body!.urls : [];
  const urls = rawUrls
    .filter((u): u is string => typeof u === "string")
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
    .slice(0, 100);

  if (urls.length === 0) {
    res.status(400).json({ error: "Provide at least one URL in `urls` (max 100)." });
    return;
  }

  type Row = {
    url: string;
    ok: boolean;
    liveStatus: "live" | "removed" | "deleted" | "not_found" | "error" | "no_comment";
    author: string | null;
    subreddit: string | null;
    title: string | null;
    createdAt: string | null;
    removalReason: string | null;
    removalBy: string | null;
    error: string | null;
  };

  const REMOVAL_BY_LABEL: Record<string, string> = {
    deleted_by_author: "Deleted by author",
    removed_by_mod: "Removed by mod",
    removed_by_reddit: "Removed by Reddit",
    removed_by_automod: "Filtered by AutoMod",
    comment_deleted: "Comment deleted",
    not_found: "Not found (404)",
  };

  async function checkOne(rawUrl: string): Promise<Row> {
    const base: Row = {
      url: rawUrl, ok: false, liveStatus: "error",
      author: null, subreddit: null, title: null, createdAt: null,
      removalReason: null, removalBy: null, error: null,
    };
    try {
      // Resolve share links (reddit.com/r/sub/s/XXXX) before parsing.
      let url = rawUrl;
      const appKind = detectAppUrl(rawUrl);
      if (appKind === "share_link_resolvable") {
        const resolved = await resolveShareLink(rawUrl);
        if (resolved) url = resolved;
      }

      // ── Early exit: post URL with no comment ID ───────────────────────────
      // If the URL points to a post but has no specific comment ID, we cannot
      // verify any comment. Return "no_comment" immediately so it is clearly
      // flagged rather than silently reported as "live" (the post being live
      // tells us nothing about whether a comment exists or was removed).
      const parsed = parseRedditProofUrl(url);
      if (parsed && !parsed.commentId) {
        return {
          ...base,
          url,
          liveStatus: "no_comment",
          error: "Post URL — no comment ID. A valid comment proof URL should contain the comment ID, e.g. reddit.com/r/sub/comments/POST_ID/title/COMMENT_ID/",
        };
      }

      const result = await recheckRedditLiveness(url);

      if (result.liveStatus === "unknown") {
        return { ...base, url, liveStatus: "error", error: result.reason ?? result.statusLabel ?? "Reddit unreachable — could not determine status" };
      }

      const liveStatus: Row["liveStatus"] = result.liveStatus as Row["liveStatus"];
      const isRemoved = result.liveStatus === "removed" || result.liveStatus === "deleted";
      const removalReason = isRemoved ? (result.reason ?? null) : null;
      const removalBy = isRemoved && result.detailedStatus
        ? (REMOVAL_BY_LABEL[result.detailedStatus] ?? result.statusLabel ?? null)
        : null;

      return {
        url,
        ok: true,
        liveStatus,
        author: null,
        subreddit: null,
        title: null,
        createdAt: null,
        removalReason,
        removalBy,
        error: null,
      };
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      return { ...base, error: msg };
    }
  }

  // Concurrency cap = 5 to avoid hammering Reddit and tripping rate limits.
  const results: Row[] = new Array(urls.length);
  const CONCURRENCY = 5;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= urls.length) return;
        results[idx] = await checkOne(urls[idx]!);
      }
    }),
  );

  const summary = {
    total: results.length,
    live: results.filter((r) => r.liveStatus === "live").length,
    removed: results.filter((r) => r.liveStatus === "removed" || r.liveStatus === "deleted").length,
    noComment: results.filter((r) => r.liveStatus === "no_comment").length,
    errored: results.filter((r) => r.liveStatus === "error" || r.liveStatus === "not_found").length,
  };

  res.json({ results, summary });
});

// ---------------------------------------------------------------------------
// POST /admin/reddit-post-check
// Bulk-checks whether Reddit POST URLs (not comment URLs) are live, removed,
// deleted, or not found.  Accepts up to 100 post URLs per request.
// ---------------------------------------------------------------------------
router.post("/reddit-post-check", requireAuth, async (req, res) => {
  const body = req.body as { urls?: unknown };
  const rawUrls = Array.isArray(body?.urls) ? body!.urls : [];
  const urls = rawUrls
    .filter((u): u is string => typeof u === "string")
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
    .slice(0, 100);

  if (urls.length === 0) {
    res.status(400).json({ error: "Provide at least one URL in `urls` (max 100)." });
    return;
  }

  type PostRow = {
    url: string;
    ok: boolean;
    liveStatus: "live" | "removed" | "deleted" | "not_found" | "error";
    subreddit: string | null;
    postId: string | null;
    removalReason: string | null;
    removalBy: string | null;
    error: string | null;
  };

  const REMOVAL_BY_LABEL: Record<string, string> = {
    deleted_by_author: "Deleted by author",
    removed_by_mod: "Removed by mod",
    removed_by_reddit: "Removed by Reddit",
    removed_by_automod: "Filtered by AutoMod",
    not_found: "Not found (404)",
  };

  async function checkPost(rawUrl: string): Promise<PostRow> {
    const base: PostRow = {
      url: rawUrl, ok: false, liveStatus: "error",
      subreddit: null, postId: null,
      removalReason: null, removalBy: null, error: null,
    };
    try {
      let url = rawUrl;

      // Resolve share links (reddit.com/r/sub/s/XXXX)
      const appKind = detectAppUrl(rawUrl);
      if (appKind === "share_link_resolvable") {
        const resolved = await resolveShareLink(rawUrl);
        if (resolved) url = resolved;
      }

      const parsed = parseRedditProofUrl(url);
      if (!parsed) {
        return { ...base, error: "Not a valid Reddit post URL." };
      }

      // If this is actually a comment URL, strip the comment part and check
      // the post itself.
      const postUrl = `https://www.reddit.com/r/${parsed.subreddit}/comments/${parsed.postId}/`;

      const result = await recheckRedditLiveness(postUrl);

      if (result.liveStatus === "unknown") {
        return {
          ...base, url,
          liveStatus: "error",
          subreddit: parsed.subreddit,
          postId: parsed.postId,
          error: result.reason ?? result.statusLabel ?? "Reddit unreachable — could not determine status",
        };
      }

      const liveStatus: PostRow["liveStatus"] =
        result.liveStatus === "live" ? "live"
        : result.liveStatus === "removed" ? "removed"
        : result.liveStatus === "deleted" ? "deleted"
        : result.liveStatus === "not_found" ? "not_found"
        : "error";

      const isRemoved = liveStatus === "removed" || liveStatus === "deleted";
      const removalBy = isRemoved && result.detailedStatus
        ? (REMOVAL_BY_LABEL[result.detailedStatus] ?? result.statusLabel ?? null)
        : null;

      return {
        url,
        ok: true,
        liveStatus,
        subreddit: parsed.subreddit,
        postId: parsed.postId,
        removalReason: isRemoved ? (result.reason ?? null) : null,
        removalBy,
        error: null,
      };
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      return { ...base, error: msg };
    }
  }

  const results: PostRow[] = new Array(urls.length);
  const CONCURRENCY = 5;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= urls.length) return;
        results[idx] = await checkPost(urls[idx]!);
      }
    }),
  );

  const summary = {
    total: results.length,
    live: results.filter((r) => r.liveStatus === "live").length,
    removed: results.filter((r) => r.liveStatus === "removed" || r.liveStatus === "deleted").length,
    notFound: results.filter((r) => r.liveStatus === "not_found").length,
    errored: results.filter((r) => r.liveStatus === "error").length,
  };

  res.json({ results, summary });
});

router.get("/console-logs", requireAuth, async (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? "100"))));
  res.json({ logs: getInMemoryLogs().slice(-limit) });
});

router.post("/set-password", async (req, res) => {
  const { username, token, newPassword } = req.body as {
    username: string;
    token: string;
    newPassword: string;
  };
  if (!username || !token || !newPassword) {
    res.status(400).json({ error: "username, token, newPassword required" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }
  try {
    const check = await pool.query(
      `SELECT id FROM admin_users WHERE username = $1 AND setup_token = $2 AND password_hash IS NULL`,
      [username, token]
    );
    if (!check.rows[0]) {
      res.status(400).json({ error: "Invalid token or account already set up" });
      return;
    }
    await pool.query(
      `UPDATE admin_users SET password_hash = crypt($1, gen_salt('bf')), setup_token = NULL WHERE username = $2`,
      [newPassword, username]
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Set password error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Read-only list of users who have set at least one payment method
// via /setupi, /setpaypal, or /setwallet. Safe additive endpoint —
// does not modify any existing route.
router.get("/payment-methods", requireAdminRole, async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page ?? "1")));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"))));
  const search = (req.query.search as string | undefined)?.trim();
  const method = (req.query.method as string | undefined)?.trim().toLowerCase();
  const offset = (page - 1) * limit;

  try {
    const conditions: any[] = [];

    // Only include users with at least one payment method set.
    conditions.push(
      or(
        sql`${users.upiId} IS NOT NULL AND ${users.upiId} <> ''`,
        sql`${users.paypalEmail} IS NOT NULL AND ${users.paypalEmail} <> ''`,
        sql`${users.cryptoWallets} <> '{}'::jsonb`,
      )
    );

    if (search) {
      conditions.push(
        or(
          ilike(users.discordUsername, `%${search}%`),
          ilike(users.redditUsername ?? sql`''`, `%${search}%`),
          ilike(users.upiId ?? sql`''`, `%${search}%`),
          ilike(users.paypalEmail ?? sql`''`, `%${search}%`),
        )
      );
    }

    if (method === "upi") {
      conditions.push(sql`${users.upiId} IS NOT NULL AND ${users.upiId} <> ''`);
    } else if (method === "paypal") {
      conditions.push(sql`${users.paypalEmail} IS NOT NULL AND ${users.paypalEmail} <> ''`);
    } else if (method === "crypto") {
      conditions.push(sql`${users.cryptoWallets} <> '{}'::jsonb`);
    }

    const whereClause = and(...conditions);

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: users.id,
          discordId: users.discordId,
          discordUsername: users.discordUsername,
          redditUsername: users.redditUsername,
          verified: users.verified,
          flagged: users.flagged,
          upiId: users.upiId,
          paypalEmail: users.paypalEmail,
          cryptoWallets: users.cryptoWallets,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(whereClause),
    ]);

    res.json({
      users: rows,
      total: totalRows[0]?.count ?? 0,
      page,
      limit,
    });
  } catch (err) {
    req.log.error({ err }, "List payment methods error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /admin/tasks/:taskId/proofs
 * Returns all submissions for a single task (with proof links and live status).
 * Used by the "Tasks by Creator" page so creators can view proofs for their own tasks
 * without sifting through the global Submissions page.
 */
router.get("/tasks/:taskId/proofs", requireAuth, async (req, res) => {
  const taskId = parseInt(req.params.taskId);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: "Invalid task id" });
  try {
    const r = await pool.query(
      `SELECT s.id, s.discord_id, u.reddit_username, u.discord_username,
              s.review_status, s.live_status, s.reward, s.proof_link,
              s.submitted_at, s.reviewed_at, s.review_reason
         FROM submissions s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.task_id = $1
        ORDER BY s.submitted_at DESC
        LIMIT 500`,
      [taskId],
    );
    res.json({ taskId, submissions: r.rows });
  } catch (err) {
    req.log?.error?.({ err }, "GET /tasks/:taskId/proofs failed");
    res.status(500).json({ error: "Failed to load proofs" });
  }
});

/**
 * GET /admin/tasks-by-creator
 * Returns each task creator with their tasks and the users who completed them.
 * Used by the dashboard "Tasks by Creator" page.
 *
 * Response shape:
 *   { creators: Array<{
 *       creatorDiscordId, creatorName, totalTasks, totalAcceptedSubs, totalPaid,
 *       tasks: Array<{
 *         id, title, type, reward, status, createdAt,
 *         submitters: Array<{ discordId, discordUsername, count, totalEarned }>
 *       }>
 *     }> }
 */
router.get("/tasks-by-creator", requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        t.id              AS task_id,
        t.creator_discord_id,
        t.title           AS task_title,
        t.type            AS task_type,
        t.reward          AS task_reward,
        t.status          AS task_status,
        t.created_at      AS task_created_at,
        cu.discord_username AS creator_username,
        s.discord_id      AS submitter_discord_id,
        su.discord_username AS submitter_username,
        s.review_status   AS submission_status,
        s.reward          AS submission_reward
      FROM tasks t
      LEFT JOIN users cu ON cu.discord_id = t.creator_discord_id
      LEFT JOIN submissions s ON s.task_id = t.id
      LEFT JOIN users su ON su.id = s.user_id
      WHERE COALESCE(t.creator_discord_id, '') <> ''
      ORDER BY t.creator_discord_id, t.created_at DESC, s.submitted_at DESC
    `);

    type Submitter = { discordId: string; discordUsername: string | null; count: number; totalEarned: number };
    type Task = {
      id: number; title: string; type: string; reward: string; status: string; createdAt: string;
      submitters: Map<string, Submitter>;
    };
    type Creator = {
      creatorDiscordId: string;
      creatorName: string;
      tasks: Map<number, Task>;
    };

    const creators = new Map<string, Creator>();
    for (const row of r.rows) {
      const cid: string = row.creator_discord_id;
      if (!cid) continue;
      const cname = cid.startsWith("dashboard:")
        ? `Dashboard · ${cid.slice("dashboard:".length)}`
        : (row.creator_username ?? cid);
      let creator = creators.get(cid);
      if (!creator) {
        creator = { creatorDiscordId: cid, creatorName: cname, tasks: new Map() };
        creators.set(cid, creator);
      }
      let task = creator.tasks.get(row.task_id);
      if (!task) {
        task = {
          id: row.task_id,
          title: row.task_title,
          type: row.task_type,
          reward: row.task_reward,
          status: row.task_status,
          createdAt: row.task_created_at,
          submitters: new Map(),
        };
        creator.tasks.set(row.task_id, task);
      }
      if (row.submitter_discord_id && row.submission_status === "accepted") {
        const sid: string = row.submitter_discord_id;
        let sub = task.submitters.get(sid);
        if (!sub) {
          sub = { discordId: sid, discordUsername: row.submitter_username ?? null, count: 0, totalEarned: 0 };
          task.submitters.set(sid, sub);
        }
        sub.count += 1;
        sub.totalEarned += parseFloat(row.submission_reward) || 0;
      }
    }

    const out = Array.from(creators.values()).map((c) => {
      const tasks = Array.from(c.tasks.values()).map((t) => {
        const submitters = Array.from(t.submitters.values()).sort((a, b) => b.totalEarned - a.totalEarned);
        const totalAccepted = submitters.reduce((s, x) => s + x.count, 0);
        const totalPaid = submitters.reduce((s, x) => s + x.totalEarned, 0);
        return { ...t, submitters: submitters.map((s) => ({ ...s, totalEarned: s.totalEarned.toFixed(2) })), totalAccepted, totalPaid: totalPaid.toFixed(2) };
      });
      const totalAcceptedSubs = tasks.reduce((s, t) => s + t.totalAccepted, 0);
      const totalPaid = tasks.reduce((s, t) => s + parseFloat(t.totalPaid), 0).toFixed(2);
      return {
        creatorDiscordId: c.creatorDiscordId,
        creatorName: c.creatorName,
        totalTasks: tasks.length,
        totalAcceptedSubs,
        totalPaid,
        tasks,
      };
    }).sort((a, b) => parseFloat(b.totalPaid) - parseFloat(a.totalPaid));

    res.json({ creators: out });
  } catch (err) {
    (_req as any).log?.error?.({ err }, "tasks-by-creator error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /admin/tasks/:id/auto-bump
 * Configure Dutch auction auto-bump per-task. Admin opt-in (feature #9
 * is OFF by default for every task).
 *
 * Body:
 *   { enabled: boolean,
 *     percent?: number,       // % to raise per bump (1–50)
 *     intervalMin?: number,   // minutes between bumps (15–1440)
 *     capPercent?: number }   // max cumulative % above original (10–200)
 *
 * Setting enabled=false sets percent=0 (cron skips). Existing reward is
 * preserved as original_reward on the first bump.
 */
router.post("/tasks/:id/auto-bump", requireAdminRole, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
  const body = (req.body ?? {}) as { enabled?: boolean; percent?: number; intervalMin?: number; capPercent?: number };
  const enabled = !!body.enabled;
  const percent = enabled ? Math.max(1, Math.min(50, Number(body.percent ?? 10))) : 0;
  const intervalMin = Math.max(15, Math.min(1440, Number(body.intervalMin ?? 60)));
  const capPercent = Math.max(10, Math.min(200, Number(body.capPercent ?? 50)));
  try {
    const r = await pool.query(
      `UPDATE tasks
          SET auto_bump_percent      = $2,
              auto_bump_interval_min = $3,
              auto_bump_cap_percent  = $4
        WHERE id = $1
        RETURNING id, reward, original_reward, auto_bump_percent,
                  auto_bump_interval_min, auto_bump_cap_percent,
                  auto_bump_count, last_bump_at`,
      [id, percent, intervalMin, capPercent],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Task not found" });
    req.log?.info?.({ taskId: id, enabled, percent, intervalMin, capPercent }, "Auto-bump configured");
    res.json({ ok: true, task: r.rows[0] });
  } catch (err) {
    req.log?.error?.({ err }, "POST /tasks/:id/auto-bump failed");
    res.status(500).json({ error: "Failed to configure auto-bump" });
  }
});

/**
 * GET /admin/fraud-signals
 * Read-only fraud heuristics — surfaces suspicious worker patterns.
 * Five independent buckets, computed in parallel.
 *
 * Thresholds are intentionally conservative — these are *signals*, not bans.
 * Every result includes the user's discord_id + username so admins can drill
 * into the worker profile page.
 */
router.get("/fraud-signals", requireAuth, async (_req, res) => {
  try {
    const [highReject, fastSubs, sharedReddit, ghostClaims, fastWithdraws] = await Promise.all([
      // (1) High rejection rate — >=5 reviewed subs, rejection rate > 50%.
      pool.query(`
        SELECT u.id, u.discord_id, u.discord_username, u.trust_score, u.flagged,
               COUNT(s.id)                                              AS reviewed,
               COUNT(s.id) FILTER (WHERE s.review_status = 'rejected')  AS rejected,
               ROUND(100.0 * COUNT(s.id) FILTER (WHERE s.review_status = 'rejected')
                     / NULLIF(COUNT(s.id), 0), 1)                       AS rejection_pct
          FROM users u
          JOIN submissions s ON s.user_id = u.id
         WHERE s.review_status IN ('accepted', 'rejected')
         GROUP BY u.id
        HAVING COUNT(s.id) >= 5
           AND COUNT(s.id) FILTER (WHERE s.review_status = 'rejected') * 2 > COUNT(s.id)
         ORDER BY rejection_pct DESC LIMIT 50`),

      // (2) Suspiciously fast submitters — avg time-to-submit < 30s across >=5 subs.
      pool.query(`
        SELECT u.id, u.discord_id, u.discord_username, u.trust_score, u.flagged,
               COUNT(s.id)                                              AS subs,
               ROUND(AVG(EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at)))::numeric, 1) AS avg_seconds
          FROM users u
          JOIN submissions s ON s.user_id = u.id
          JOIN claims      c ON c.id = s.claim_id
         WHERE c.claimed_at IS NOT NULL
         GROUP BY u.id
        HAVING COUNT(s.id) >= 5
           AND AVG(EXTRACT(EPOCH FROM (s.submitted_at - c.claimed_at))) < 30
         ORDER BY avg_seconds ASC LIMIT 50`),

      // (3) Shared Reddit account — same reddit_username verified on multiple discord IDs.
      pool.query(`
        SELECT reddit_username,
               COUNT(*)                                                 AS user_count,
               ARRAY_AGG(json_build_object(
                 'id', id, 'discordId', discord_id, 'username', discord_username, 'flagged', flagged
               ) ORDER BY created_at) AS users
          FROM users
         WHERE reddit_username IS NOT NULL AND reddit_username <> ''
         GROUP BY reddit_username
        HAVING COUNT(*) > 1
         ORDER BY user_count DESC LIMIT 50`),

      // (4) Ghost claimers — claim a lot, rarely submit (>=5 claims, submit rate < 30%).
      pool.query(`
        SELECT u.id, u.discord_id, u.discord_username, u.trust_score, u.flagged,
               COUNT(c.id)                                              AS claims,
               COUNT(s.id)                                              AS submissions,
               ROUND(100.0 * COUNT(s.id) / NULLIF(COUNT(c.id), 0), 1)   AS submit_pct
          FROM users u
          JOIN claims      c ON c.user_id = u.id
          LEFT JOIN submissions s ON s.claim_id = c.id
         GROUP BY u.id
        HAVING COUNT(c.id) >= 5
           AND COUNT(s.id) * 10 < COUNT(c.id) * 3
         ORDER BY claims DESC LIMIT 50`),

      // (5) Fast cash-out — withdrew >=80% of lifetime earned in the last 7 days.
      pool.query(`
        SELECT u.id, u.discord_id, u.discord_username, u.trust_score, u.flagged,
               u.total_earned,
               COALESCE(SUM(w.amount) FILTER (
                 WHERE w.requested_at > NOW() - INTERVAL '7 days'
               ), 0)                                                    AS withdrawn_7d
          FROM users u
          JOIN withdrawals w ON w.discord_id = u.discord_id
         WHERE u.total_earned > 0
         GROUP BY u.id
        HAVING COALESCE(SUM(w.amount) FILTER (
                 WHERE w.requested_at > NOW() - INTERVAL '7 days'
               ), 0) >= u.total_earned * 0.8
           AND COALESCE(SUM(w.amount) FILTER (
                 WHERE w.requested_at > NOW() - INTERVAL '7 days'
               ), 0) >= 5
         ORDER BY withdrawn_7d DESC LIMIT 50`),
    ]);

    res.json({
      highRejection: highReject.rows,
      fastSubmissions: fastSubs.rows,
      sharedReddit: sharedReddit.rows,
      ghostClaims: ghostClaims.rows,
      fastWithdrawals: fastWithdraws.rows,
    });
  } catch (err) {
    (_req as any).log?.error?.({ err }, "fraud-signals error");
    res.status(500).json({ error: "Failed to load fraud signals" });
  }
});

/**
 * GET /admin/creator-earnings
 * Per-creator financial summary — total spent, tasks created, fill rate,
 * avg cost per accepted submission, etc. Different angle from
 * /admin/tasks-by-creator (which is a drill-down view).
 */
router.get("/creator-earnings", requireAuth, async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        t.creator_discord_id,
        cu.discord_username                                              AS creator_username,
        COUNT(DISTINCT t.id)                                             AS total_tasks,
        COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'open')            AS open_tasks,
        COUNT(DISTINCT t.id) FILTER (WHERE t.status != 'open')           AS closed_tasks,
        COALESCE(SUM(t.max_slots), 0)                                    AS total_slots,
        COALESCE(SUM(t.slots_filled), 0)                                 AS total_slots_filled,
        COALESCE(SUM(s.reward) FILTER (WHERE s.review_status = 'accepted'), 0) AS total_paid,
        COUNT(s.id) FILTER (WHERE s.review_status = 'accepted')          AS total_accepted,
        COUNT(s.id) FILTER (WHERE s.review_status = 'rejected')          AS total_rejected,
        COUNT(s.id) FILTER (WHERE s.review_status IN ('pending', 'pending_hold')) AS total_pending,
        AVG(t.reward)::numeric(12,2)                                     AS avg_reward,
        MAX(t.created_at)                                                AS last_task_at,
        MIN(t.created_at)                                                AS first_task_at
      FROM tasks t
      LEFT JOIN users cu ON cu.discord_id = t.creator_discord_id
      LEFT JOIN submissions s ON s.task_id = t.id
      WHERE COALESCE(t.creator_discord_id, '') <> ''
      GROUP BY t.creator_discord_id, cu.discord_username
      ORDER BY total_paid DESC, total_tasks DESC
    `);

    const creators = r.rows.map((row: any) => {
      const cid: string = row.creator_discord_id;
      const cname = cid.startsWith("dashboard:")
        ? `Dashboard · ${cid.slice("dashboard:".length)}`
        : (row.creator_username ?? cid);
      const totalAccepted = Number(row.total_accepted ?? 0);
      const totalPaid = Number(row.total_paid ?? 0);
      const totalSlots = Number(row.total_slots ?? 0);
      const totalSlotsFilled = Number(row.total_slots_filled ?? 0);
      return {
        creatorDiscordId: cid,
        creatorName: cname,
        totalTasks: Number(row.total_tasks ?? 0),
        openTasks: Number(row.open_tasks ?? 0),
        closedTasks: Number(row.closed_tasks ?? 0),
        totalSlots,
        totalSlotsFilled,
        fillRate: totalSlots > 0 ? Math.round((totalSlotsFilled / totalSlots) * 1000) / 10 : 0,
        totalPaid: totalPaid.toFixed(2),
        totalAccepted,
        totalRejected: Number(row.total_rejected ?? 0),
        totalPending: Number(row.total_pending ?? 0),
        avgReward: row.avg_reward != null ? Number(row.avg_reward).toFixed(2) : "0.00",
        avgCostPerSub: totalAccepted > 0 ? (totalPaid / totalAccepted).toFixed(2) : "0.00",
        firstTaskAt: row.first_task_at,
        lastTaskAt: row.last_task_at,
      };
    });

    res.json({ creators });
  } catch (err) {
    (_req as any).log?.error?.({ err }, "creator-earnings error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// CSV exports — date-range scoped dumps of submissions, withdrawals,
// per-creator payouts, and claims audit. All read-only. Streams a text/csv
// response with Content-Disposition so the dashboard `downloadFile` helper
// pops a native browser download. Date range is inclusive on both ends and
// defaults to "all time" if omitted.
// ---------------------------------------------------------------------------

// Export-CSV helpers (object-keyed). Distinct from the array-based csvRows
// helper above which is used by the dashboard table-export path.
function exportCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function exportCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => exportCell(row[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}
function parseDateRange(req: any): { from: Date; to: Date; fromISO: string; toISO: string } {
  const fromStr = String(req.query.from ?? "").trim();
  const toStr = String(req.query.to ?? "").trim();
  // Defaults: from = 1970-01-01, to = now+1day so today is included end-of-day.
  const from = fromStr ? new Date(fromStr) : new Date(0);
  const to = toStr ? new Date(`${toStr}T23:59:59.999Z`) : new Date(Date.now() + 86_400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new Error("Invalid date range");
  }
  return { from, to, fromISO: from.toISOString().slice(0, 10), toISO: to.toISOString().slice(0, 10) };
}
function sendCsv(res: any, filename: string, body: string) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(body);
}

router.get("/exports/submissions.csv", requireAuth, async (req, res) => {
  try {
    const { from, to, fromISO, toISO } = parseDateRange(req);
    const r = await pool.query(
      `SELECT s.id, s.task_id, t.title AS task_title, t.type AS task_type,
              s.discord_id, u.discord_username, s.reward,
              s.review_status, s.reviewer_discord_id, s.review_reason,
              s.live_status, s.proof_link, s.screenshot_url,
              s.submitted_at, s.reviewed_at, s.available_at
         FROM submissions s
         LEFT JOIN tasks t ON t.id = s.task_id
         LEFT JOIN users u ON u.discord_id = s.discord_id
        WHERE s.submitted_at >= $1 AND s.submitted_at <= $2
        ORDER BY s.submitted_at DESC`,
      [from, to],
    );
    const csv = exportCsv(
      ["id","task_id","task_title","task_type","discord_id","discord_username","reward","review_status","reviewer_discord_id","review_reason","live_status","proof_link","screenshot_url","submitted_at","reviewed_at","available_at"],
      r.rows,
    );
    sendCsv(res, `submissions_${fromISO}_to_${toISO}.csv`, csv);
  } catch (err) {
    (req as any).log?.error?.({ err }, "exports/submissions.csv failed");
    res.status(500).json({ error: (err as Error).message || "Export failed" });
  }
});

router.get("/exports/withdrawals.csv", requireAuth, async (req, res) => {
  try {
    const { from, to, fromISO, toISO } = parseDateRange(req);
    const r = await pool.query(
      `SELECT w.id, w.discord_id, u.discord_username, w.amount, w.method,
              w.destination, w.status, w.reviewer_discord_id, w.reason,
              w.requested_at, w.processed_at
         FROM withdrawals w
         LEFT JOIN users u ON u.discord_id = w.discord_id
        WHERE w.requested_at >= $1 AND w.requested_at <= $2
        ORDER BY w.requested_at DESC`,
      [from, to],
    );
    const csv = exportCsv(
      ["id","discord_id","discord_username","amount","method","destination","status","reviewer_discord_id","reason","requested_at","processed_at"],
      r.rows,
    );
    sendCsv(res, `withdrawals_${fromISO}_to_${toISO}.csv`, csv);
  } catch (err) {
    (req as any).log?.error?.({ err }, "exports/withdrawals.csv failed");
    res.status(500).json({ error: (err as Error).message || "Export failed" });
  }
});

router.get("/exports/creator-payouts.csv", requireAuth, async (req, res) => {
  try {
    const { from, to, fromISO, toISO } = parseDateRange(req);
    const r = await pool.query(
      // Join users on creator_discord_id to surface a display name —
      // withdrawal_creator_payouts does not store one itself.
      `SELECT wcp.id, wcp.withdrawal_id, wcp.creator_discord_id,
              u.discord_username AS creator_username,
              wcp.amount, wcp.status, wcp.paid_by, wcp.paid_at, wcp.created_at,
              w.discord_id AS earner_discord_id, w.amount AS withdrawal_amount,
              w.status AS withdrawal_status
         FROM withdrawal_creator_payouts wcp
         LEFT JOIN withdrawals w ON w.id = wcp.withdrawal_id
         LEFT JOIN users       u ON u.discord_id = wcp.creator_discord_id
        WHERE wcp.created_at >= $1 AND wcp.created_at <= $2
        ORDER BY wcp.created_at DESC`,
      [from, to],
    );
    const csv = exportCsv(
      ["id","withdrawal_id","creator_discord_id","creator_username","amount","status","paid_by","paid_at","created_at","earner_discord_id","withdrawal_amount","withdrawal_status"],
      r.rows,
    );
    sendCsv(res, `creator-payouts_${fromISO}_to_${toISO}.csv`, csv);
  } catch (err) {
    (req as any).log?.error?.({ err }, "exports/creator-payouts.csv failed");
    res.status(500).json({ error: (err as Error).message || "Export failed" });
  }
});

router.get("/exports/claims.csv", requireAuth, async (req, res) => {
  try {
    const { from, to, fromISO, toISO } = parseDateRange(req);
    const r = await pool.query(
      `SELECT c.id, c.task_id, t.title AS task_title, c.discord_id,
              u.discord_username, c.status, c.claimed_at, c.expires_at
         FROM claims c
         LEFT JOIN tasks t ON t.id = c.task_id
         LEFT JOIN users u ON u.discord_id = c.discord_id
        WHERE c.claimed_at >= $1 AND c.claimed_at <= $2
        ORDER BY c.claimed_at DESC`,
      [from, to],
    );
    const csv = exportCsv(
      ["id","task_id","task_title","discord_id","discord_username","status","claimed_at","expires_at"],
      r.rows,
    );
    sendCsv(res, `claims_${fromISO}_to_${toISO}.csv`, csv);
  } catch (err) {
    (req as any).log?.error?.({ err }, "exports/claims.csv failed");
    res.status(500).json({ error: (err as Error).message || "Export failed" });
  }
});

// ---------------------------------------------------------------------------
// Re-claim blocks. When a user lets the 15-min claim window expire,
// claimExpirer writes a permanent block row. These endpoints let admins see
// and override those blocks (in case it was a network glitch / mistake).
// ---------------------------------------------------------------------------

// GET /admin/claim-blocks?taskId=&discordId=  → optional filters
router.get("/claim-blocks", requireAuth, async (req, res) => {
  const taskId = req.query.taskId ? parseInt(String(req.query.taskId)) : null;
  const discordId = req.query.discordId ? String(req.query.discordId) : null;
  try {
    let rows;
    if (taskId && discordId) {
      rows = await pool.query(
        `SELECT b.task_id, b.discord_id, b.reason, b.blocked_at,
                t.title AS task_title, u.discord_username
           FROM task_claim_blocks b
           LEFT JOIN tasks t ON t.id = b.task_id
           LEFT JOIN users u ON u.discord_id = b.discord_id
          WHERE b.task_id = $1 AND b.discord_id = $2
          ORDER BY b.blocked_at DESC LIMIT 500`,
        [taskId, discordId],
      );
    } else if (taskId) {
      rows = await pool.query(
        `SELECT b.task_id, b.discord_id, b.reason, b.blocked_at,
                t.title AS task_title, u.discord_username
           FROM task_claim_blocks b
           LEFT JOIN tasks t ON t.id = b.task_id
           LEFT JOIN users u ON u.discord_id = b.discord_id
          WHERE b.task_id = $1
          ORDER BY b.blocked_at DESC LIMIT 500`,
        [taskId],
      );
    } else if (discordId) {
      rows = await pool.query(
        `SELECT b.task_id, b.discord_id, b.reason, b.blocked_at,
                t.title AS task_title, u.discord_username
           FROM task_claim_blocks b
           LEFT JOIN tasks t ON t.id = b.task_id
           LEFT JOIN users u ON u.discord_id = b.discord_id
          WHERE b.discord_id = $1
          ORDER BY b.blocked_at DESC LIMIT 500`,
        [discordId],
      );
    } else {
      rows = await pool.query(
        `SELECT b.task_id, b.discord_id, b.reason, b.blocked_at,
                t.title AS task_title, u.discord_username
           FROM task_claim_blocks b
           LEFT JOIN tasks t ON t.id = b.task_id
           LEFT JOIN users u ON u.discord_id = b.discord_id
          ORDER BY b.blocked_at DESC LIMIT 500`,
      );
    }
    res.json({ blocks: rows.rows });
  } catch (err) {
    (req as any).log?.error?.({ err }, "GET /claim-blocks failed");
    res.status(500).json({ error: "Failed to load claim blocks" });
  }
});

// DELETE /admin/claim-blocks/:taskId/:discordId  → admin unblock
router.delete("/claim-blocks/:taskId/:discordId", requireAdminRole, async (req, res) => {
  const taskId = parseInt(req.params.taskId);
  const discordId = req.params.discordId;
  if (!Number.isFinite(taskId) || !discordId) {
    return res.status(400).json({ error: "Invalid taskId or discordId" });
  }
  try {
    const r = await pool.query(
      `DELETE FROM task_claim_blocks WHERE task_id = $1 AND discord_id = $2`,
      [taskId, discordId],
    );
    res.json({ ok: true, removed: r.rowCount ?? 0 });
  } catch (err) {
    (req as any).log?.error?.({ err }, "DELETE /claim-blocks failed");
    res.status(500).json({ error: "Failed to remove claim block" });
  }
});

export default router;
