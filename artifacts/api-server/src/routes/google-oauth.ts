// ===========================================================================
// /api/admin/google/*  — operator OAuth flow for Sheets/Drive.
// Mirrors the Discord OAuth pattern in discord-oauth.ts.
// ===========================================================================

import { Router } from "express";
import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import { requireAuth } from "./admin.js";
import {
  GOOGLE_OAUTH_SCOPES,
  buildGoogleRedirectUri,
  isGoogleOAuthConfigured,
  loadStoredOAuth,
  makeOAuth2Client,
  saveStoredOAuth,
  clearStoredOAuth,
} from "../lib/googleOAuth.js";
import { logger } from "../lib/logger.js";

const router: Router = Router();

function dashboardReturnUrl(req: any, query = ""): string {
  const explicit = process.env.DASHBOARD_PUBLIC_URL;
  if (explicit) return `${explicit.replace(/\/$/, "")}/admin/settings${query}`;
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = req.get("host");
  return `${proto}://${host}/admin/settings${query}`;
}

// ---------------------------------------------------------------------------
// GET /admin/google/status — JSON { configured, connected, email }
// `configured` = env vars present; `connected` = an operator has linked.
// ---------------------------------------------------------------------------
router.get("/google/status", requireAuth, async (_req, res) => {
  const configured = isGoogleOAuthConfigured();
  const stored = configured ? await loadStoredOAuth() : null;
  res.json({
    configured,
    connected: !!stored,
    email: stored?.email ?? null,
    connectedAt: stored?.connected_at ?? null,
  });
});

// ---------------------------------------------------------------------------
// GET /admin/google/oauth/start — top-level navigation route (user lands
// here via <a href> click). Bounces to login page if no session.
// ---------------------------------------------------------------------------
router.get("/google/oauth/start", async (req, res, next) => {
  const sessionUser = (req as any).session?.adminUser;
  if (!sessionUser) {
    const dashUrl = process.env.DASHBOARD_PUBLIC_URL?.replace(/\/$/, "") ?? "";
    if (dashUrl) {
      res.redirect(`${dashUrl}/login?next=connect_google`);
      return;
    }
    res.status(401).send("You need to log in to the admin dashboard before connecting Google.");
    return;
  }
  return (requireAuth as any)(req, res, next);
}, async (req, res) => {
  if (!isGoogleOAuthConfigured()) {
    res.status(500).send(
      "Google OAuth not configured. The operator must set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars and redeploy."
    );
    return;
  }
  const redirectUri = buildGoogleRedirectUri(req);
  const client = makeOAuth2Client(redirectUri);
  if (!client) {
    res.status(500).send("Failed to build OAuth client.");
    return;
  }
  const state = randomBytes(16).toString("hex");
  (req as any).session.googleOAuthState = state;

  const url = client.generateAuthUrl({
    access_type: "offline",
    // Force consent so Google ALWAYS returns a refresh_token. Without this,
    // Google may omit the refresh_token on re-authorizations, leaving us
    // unable to act on the operator's behalf.
    prompt: "consent",
    include_granted_scopes: true,
    scope: GOOGLE_OAUTH_SCOPES,
    state,
  });

  // connect-pg-simple persists sessions asynchronously — we MUST await the
  // save before redirecting, otherwise state can be missing on callback.
  (req as any).session.save((err: any) => {
    if (err) {
      req.log.error({ err }, "Failed to persist Google OAuth state to session");
      res.status(500).send("Could not start Google connect. Please retry.");
      return;
    }
    res.redirect(url);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/google/callback — Google bounces back here with ?code & ?state.
// ---------------------------------------------------------------------------
router.get("/google/callback", async (req, res) => {
  const sessionUser = (req as any).session?.adminUser;
  if (!sessionUser) {
    res.status(401).send("You must be logged in to the dashboard before connecting Google.");
    return;
  }
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const expected = (req as any).session?.googleOAuthState;
  if (!code || !state || !expected || state !== expected) {
    req.log.warn(
      { hasCode: !!code, hasState: !!state, hasExpected: !!expected, match: state === expected },
      "Google OAuth state mismatch"
    );
    res.status(400).send("OAuth state mismatch — please retry from Settings.");
    return;
  }
  delete (req as any).session.googleOAuthState;

  if (!isGoogleOAuthConfigured()) {
    res.status(500).send("Google OAuth env vars are not configured.");
    return;
  }
  const redirectUri = buildGoogleRedirectUri(req);
  const client = makeOAuth2Client(redirectUri);
  if (!client) {
    res.status(500).send("Failed to build OAuth client.");
    return;
  }

  try {
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      // Google sometimes omits refresh_token if the user has already granted
      // consent to this client before. Telling them to disconnect at
      // myaccount.google.com → Security → Third-party access is the fix.
      req.log.warn({ hasAccess: !!tokens.access_token }, "Google returned no refresh_token");
      res.status(400).send(
        "Google did not return a refresh token. Go to https://myaccount.google.com/connections, " +
        "remove this app's existing access, then click Connect Google again."
      );
      return;
    }
    client.setCredentials(tokens);

    // Fetch the user's email so we can show "Connected as foo@gmail.com".
    let email = "";
    try {
      const oauth2 = google.oauth2({ version: "v2", auth: client });
      const me = await oauth2.userinfo.get();
      email = me.data.email ?? "";
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Google userinfo fetch failed (saving anyway)");
    }

    await saveStoredOAuth({
      refresh_token: tokens.refresh_token,
      email,
      connected_by_admin_id: sessionUser.id ?? null,
    });

    // Bust the sheetsLogger cache so the new path activates instantly.
    try {
      const { invalidateSheetsConfigCache } = await import("../lib/sheetsLogger.js");
      invalidateSheetsConfigCache();
    } catch { /* swallow */ }

    req.log.info({ adminId: sessionUser.id, email }, "Google account connected");
    res.redirect(dashboardReturnUrl(req, "?google=connected"));
  } catch (err) {
    req.log.error({ err }, "Google OAuth callback failed");
    res.status(500).send("Google connect failed: " + (err as Error).message);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/google/disconnect — clear stored token + revoke on Google.
// ---------------------------------------------------------------------------
router.post("/google/disconnect", requireAuth, async (req, res) => {
  try {
    await clearStoredOAuth();
    try {
      const { invalidateSheetsConfigCache } = await import("../lib/sheetsLogger.js");
      invalidateSheetsConfigCache();
    } catch { /* swallow */ }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Google disconnect failed");
    res.status(500).json({ error: "Failed to disconnect Google" });
  }
});

export default router;
