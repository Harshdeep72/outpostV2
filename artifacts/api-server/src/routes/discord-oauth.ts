import { Router } from "express";
import { randomBytes } from "node:crypto";
import { pool } from "@workspace/db";
import { requireAuth } from "./admin.js";

const router: Router = Router();

const DISCORD_API = "https://discord.com/api";

function buildRedirectUri(req: any): string {
  const explicit = process.env.DISCORD_OAUTH_REDIRECT_URI;
  if (explicit) return explicit;
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = req.get("host");
  return `${proto}://${host}/api/admin/discord/callback`;
}

function dashboardReturnUrl(req: any, query = ""): string {
  const explicit = process.env.DASHBOARD_PUBLIC_URL;
  if (explicit) return `${explicit.replace(/\/$/, "")}/admin${query}`;
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = req.get("host");
  return `${proto}://${host}/admin${query}`;
}

// Top-level navigation route: cannot return JSON 401 because the user lands
// here via an <a href> click, not an XHR. If the session isn't present we
// bounce them to the dashboard login page with a return-to hint, instead of
// the cryptic "Unauthorized" they were seeing before.
router.get("/discord/oauth/start", async (req, res, next) => {
  const sessionUser = (req as any).session?.adminUser;
  if (!sessionUser) {
    const dashUrl = process.env.DASHBOARD_PUBLIC_URL?.replace(/\/$/, "") ?? "";
    if (dashUrl) {
      res.redirect(`${dashUrl}/login?next=connect_discord`);
      return;
    }
    res.status(401).send(
      "You need to log in to the admin dashboard before linking Discord. Open the dashboard, log in, then try Connect Discord again."
    );
    return;
  }
  return (requireAuth as any)(req, res, next);
}, async (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: "DISCORD_CLIENT_ID not configured" });
    return;
  }
  const state = randomBytes(16).toString("hex");
  (req as any).session.discordOAuthState = state;
  const redirectUri = buildRedirectUri(req);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify",
    state,
    prompt: "consent",
  });
  // CRITICAL: connect-pg-simple persists the session asynchronously. We MUST
  // await the save before redirecting to Discord, otherwise the state row
  // isn't in Postgres yet when Discord bounces the user back to /callback,
  // producing "OAuth state mismatch".
  (req as any).session.save((err: any) => {
    if (err) {
      req.log.error({ err }, "Failed to persist OAuth state to session");
      res.status(500).send("Could not start Discord linking. Please retry.");
      return;
    }
    res.redirect(`${DISCORD_API}/oauth2/authorize?${params.toString()}`);
  });
});

router.get("/discord/oauth/url", requireAuth, async (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: "DISCORD_CLIENT_ID not configured" });
    return;
  }
  res.json({ url: `/api/admin/discord/oauth/start` });
});

router.post("/discord/unlink", requireAuth, async (req, res) => {
  const sessionUser = (req as any).session?.adminUser;
  try {
    await pool.query(
      `UPDATE admin_users
         SET discord_id = NULL, discord_username = NULL, discord_avatar = NULL, discord_linked_at = NULL
       WHERE id = $1`,
      [sessionUser.id]
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Discord unlink failed");
    res.status(500).json({ error: "Failed to unlink Discord" });
  }
});

router.get("/discord/callback", async (req, res) => {
  const sessionUser = (req as any).session?.adminUser;
  if (!sessionUser) {
    res.status(401).send("You must be logged in to the dashboard before linking Discord.");
    return;
  }
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const expected = (req as any).session?.discordOAuthState;
  if (!code || !state || !expected || state !== expected) {
    req.log.warn(
      { hasCode: !!code, hasState: !!state, hasExpected: !!expected, match: state === expected, sid: (req as any).sessionID },
      "OAuth state mismatch on Discord callback"
    );
    res.status(400).send("OAuth state mismatch — please retry from the dashboard.");
    return;
  }
  delete (req as any).session.discordOAuthState;

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.status(500).send("DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET not configured.");
    return;
  }

  const redirectUri = buildRedirectUri(req);
  try {
    const tokenResp = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!tokenResp.ok) {
      const t = await tokenResp.text();
      req.log.error({ status: tokenResp.status, body: t }, "Discord token exchange failed");
      res.status(502).send("Discord token exchange failed.");
      return;
    }
    const tok = (await tokenResp.json()) as { access_token: string };

    const meResp = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!meResp.ok) {
      res.status(502).send("Failed to read your Discord profile.");
      return;
    }
    const me = (await meResp.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };

    const avatarUrl = me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128`
      : null;
    const displayName = me.global_name || me.username;

    // Detach this discord_id from any other admin row first (one Discord = one admin).
    await pool.query(
      `UPDATE admin_users
         SET discord_id = NULL, discord_username = NULL, discord_avatar = NULL, discord_linked_at = NULL
       WHERE discord_id = $1 AND id <> $2`,
      [me.id, sessionUser.id]
    );

    await pool.query(
      `UPDATE admin_users
         SET discord_id = $1, discord_username = $2, discord_avatar = $3, discord_linked_at = now()
       WHERE id = $4`,
      [me.id, displayName, avatarUrl, sessionUser.id]
    );

    req.log.info({ adminId: sessionUser.id, discordId: me.id }, "Discord linked to admin user");
    res.redirect(dashboardReturnUrl(req, "?discord=linked"));
  } catch (err) {
    req.log.error({ err }, "Discord OAuth callback error");
    res.status(500).send("Discord linking failed. Please try again.");
  }
});

export default router;
