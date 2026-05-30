import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "@workspace/db";
import { requireAdminRole as requireAdmin, requireDevRole as requireDev } from "./admin.js";

const router: Router = Router();

const ALLOWED_ROLES = new Set(["admin", "client"]);
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

// ---------- Public registration ----------
router.post("/register", async (req, res) => {
  const { username, password, displayName, email, reason } = req.body as {
    username?: string;
    password?: string;
    displayName?: string;
    email?: string;
    reason?: string;
  };
  if (!username || !password) {
    res.status(400).json({ error: "Username and password required." });
    return;
  }
  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ error: "Username must be 3–32 chars (letters, numbers, _ . -)." });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }
  if (email && email.length > 200) {
    res.status(400).json({ error: "Email too long." });
    return;
  }
  if (reason && reason.length > 500) {
    res.status(400).json({ error: "Reason too long (max 500 chars)." });
    return;
  }
  try {
    const exists = await pool.query("SELECT 1 FROM admin_users WHERE username = $1", [username]);
    if (exists.rows.length > 0) {
      res.status(409).json({ error: "That username is taken." });
      return;
    }
    await pool.query(
      `INSERT INTO admin_users (username, password_hash, role, status, display_name, email, notes, applied_at)
       VALUES ($1, crypt($2, gen_salt('bf')), 'client', 'pending', $3, $4, $5, now())`,
      [username, password, displayName || null, email || null, reason || null]
    );
    req.log.info({ username }, "New client application submitted");
    res.json({ ok: true, message: "Application submitted. An admin will review it shortly." });
  } catch (err) {
    req.log.error({ err }, "Register error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Applications (pending) ----------
router.get("/applications", requireAdmin, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT id, username, display_name, email, notes, applied_at
       FROM admin_users WHERE status = 'pending' ORDER BY applied_at ASC`
    );
    res.json({ applications: rows.rows });
  } catch (err) {
    req.log.error({ err }, "List applications error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/applications/:id/approve", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = (req as any).session?.adminUser;
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const result = await pool.query(
      `UPDATE admin_users SET status = 'active', approved_at = now(), approved_by = $1
       WHERE id = $2 AND status = 'pending' RETURNING id, username, role, status`,
      [session?.id ?? null, id]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Application not found or already processed" }); return; }
    req.log.info({ id, by: session?.username }, "Application approved");
    res.json(result.rows[0]);
  } catch (err) {
    req.log.error({ err }, "Approve error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/applications/:id/reject", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = (req as any).session?.adminUser;
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const result = await pool.query(
      `DELETE FROM admin_users WHERE id = $1 AND status = 'pending' RETURNING id, username`,
      [id]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Application not found or already processed" }); return; }
    req.log.info({ id, username: result.rows[0].username, by: session?.username }, "Application rejected");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Reject error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Dev-only: create an admin/client account directly ---------------
// Lets the dev (founder) account spin up new admin (or client) accounts with a
// chosen username + password — no application/approval flow, instantly active.
// Gated by requireDev so ONLY users whose role='dev' can call this.
router.post("/admin-users/create", requireDev, async (req, res) => {
  const session = (req as any).session?.adminUser;
  const { username, role, displayName } = req.body as {
    username?: string;
    role?: string;
    displayName?: string;
  };
  if (!username) {
    res.status(400).json({ error: "Username is required." });
    return;
  }
  if (!USERNAME_RE.test(username)) {
    res.status(400).json({ error: "Username must be 3–32 chars (letters, numbers, _ . -)." });
    return;
  }
  const targetRole = role === "client" ? "client" : "admin";
  if (displayName && displayName.length > 100) {
    res.status(400).json({ error: "Display name too long." });
    return;
  }
  try {
    const exists = await pool.query("SELECT 1 FROM admin_users WHERE username = $1", [username]);
    if (exists.rows.length > 0) {
      res.status(409).json({ error: "That username is already taken." });
      return;
    }
    // No password yet — admin will set it on FIRST LOGIN (same flow as
    // jishan/damy). first_login_unlocked=true means: any password they type
    // on their first login becomes their permanent password.
    // approved_by is an INTEGER (FK to admin_users.id), so we pass session.id.
    const result = await pool.query(
      `INSERT INTO admin_users (username, password_hash, role, status, display_name, first_login_unlocked, applied_at, approved_at, approved_by)
       VALUES ($1, NULL, $2, 'active', $3, true, now(), now(), $4)
       RETURNING id, username, role, status, display_name, created_at`,
      [username, targetRole, displayName || null, session?.id || null]
    );
    req.log.info({ id: result.rows[0].id, username, role: targetRole, by: session?.username }, "Admin account created by dev");
    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    req.log.error({ err }, "Create admin error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Admin user management (full list) ----------
router.get("/admin-users", requireAdmin, async (req, res) => {
  try {
    const rows = await pool.query(
      `SELECT id, username, role, status, display_name, email, notes, applied_at, approved_at,
              created_at, password_hash IS NOT NULL AS has_password,
              setup_token IS NOT NULL AS has_setup_token
       FROM admin_users
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, created_at DESC`
    );
    res.json({ users: rows.rows });
  } catch (err) {
    req.log.error({ err }, "List admin users error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin-users/:id/suspend", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = (req as any).session?.adminUser;
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (id === session?.id) { res.status(400).json({ error: "You cannot suspend yourself." }); return; }
  try {
    const result = await pool.query(
      `UPDATE admin_users SET status = 'suspended' WHERE id = $1 RETURNING id, username, status`,
      [id]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "User not found" }); return; }
    req.log.info({ id, by: session?.username }, "Admin user suspended");
    res.json(result.rows[0]);
  } catch (err) {
    req.log.error({ err }, "Suspend error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin-users/:id/unsuspend", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = (req as any).session?.adminUser;
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const result = await pool.query(
      `UPDATE admin_users SET status = 'active' WHERE id = $1 AND status = 'suspended' RETURNING id, username, status`,
      [id]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "User not found or not suspended" }); return; }
    req.log.info({ id, by: session?.username }, "Admin user unsuspended");
    res.json(result.rows[0]);
  } catch (err) {
    req.log.error({ err }, "Unsuspend error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin-users/:id/role", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = (req as any).session?.adminUser;
  const { role } = req.body as { role?: string };
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (!role || !ALLOWED_ROLES.has(role)) {
    res.status(400).json({ error: "Role must be 'admin' or 'client'." });
    return;
  }
  if (id === session?.id && role !== "admin") {
    res.status(400).json({ error: "You cannot demote yourself." });
    return;
  }
  try {
    const result = await pool.query(
      `UPDATE admin_users SET role = $1 WHERE id = $2 RETURNING id, username, role, status`,
      [role, id]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "User not found" }); return; }
    req.log.info({ id, role, by: session?.username }, "Admin user role changed");
    res.json(result.rows[0]);
  } catch (err) {
    req.log.error({ err }, "Role change error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/admin-users/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = (req as any).session?.adminUser;
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  if (id === session?.id) { res.status(400).json({ error: "You cannot delete yourself." }); return; }
  try {
    const result = await pool.query(
      `DELETE FROM admin_users WHERE id = $1 RETURNING id, username`,
      [id]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "User not found" }); return; }
    req.log.info({ id, username: result.rows[0].username, by: session?.username }, "Admin user deleted");
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Delete admin user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Issue a fresh setup token (admin can hand it to a user if they forgot password).
router.post("/admin-users/:id/reset-token", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  const session = (req as any).session?.adminUser;
  if (!Number.isInteger(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const token = crypto.randomBytes(24).toString("base64url");
    const result = await pool.query(
      `UPDATE admin_users SET setup_token = $1, password_hash = NULL WHERE id = $2 RETURNING id, username, setup_token`,
      [token, id]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "User not found" }); return; }
    req.log.info({ id, by: session?.username }, "Setup token reset");
    res.json(result.rows[0]);
  } catch (err) {
    req.log.error({ err }, "Reset token error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
