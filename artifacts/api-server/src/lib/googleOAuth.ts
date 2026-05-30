// ===========================================================================
// Google OAuth (user-account) flow for Sheets/Drive.
// ---------------------------------------------------------------------------
// WHY this exists alongside the service-account path in googleSheets.ts:
//   Service accounts attached to personal-Gmail Cloud projects have 0 GB
//   Drive storage, so sheets.spreadsheets.create() returns a misleading 403
//   "permission denied" instead of a proper quota error. Workspace fixes
//   this but costs money. OAuth lets the operator connect their OWN Google
//   account once from the dashboard; the bot then creates sheets that count
//   against the operator's personal 15 GB Drive quota — zero subscription.
//
// FLOW (one-time setup):
//   1. Operator clicks "Connect Google" on Settings page.
//   2. We redirect to Google consent screen with offline access + spreadsheets
//      + drive.file scopes.
//   3. Google bounces back to /admin/google/callback with ?code=...
//   4. We exchange the code for { access_token, refresh_token }, fetch the
//      operator's email, and store the refresh_token in system_settings
//      (singleton row keyed "google_oauth_user").
//   5. From now on, getGoogleOAuthClient() returns a fully-loaded OAuth2 client
//      that the googleapis library will auto-refresh access tokens for.
//
// STORAGE:
//   system_settings row, key="google_oauth_user", value JSONB:
//     { refresh_token, email, connected_at, connected_by_admin_id }
//
// SAFETY:
//   * Tokens never logged.
//   * Disconnect simply nukes the row → future calls fall back to SA path.
//   * If GOOGLE_OAUTH_CLIENT_ID/SECRET are missing, getOAuthClient() returns
//     null so the rest of the system keeps working with the SA path.
// ===========================================================================

import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

export const GOOGLE_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  // drive.file = "files the app creates" — minimum privilege.
  "https://www.googleapis.com/auth/drive.file",
  // To fetch user's email for the "Connected as foo@gmail.com" display.
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

const SETTINGS_KEY = "google_oauth_user";

export interface StoredGoogleOAuth {
  refresh_token: string;
  email: string;
  connected_at: string;
  connected_by_admin_id: number | null;
}

let cachedRow: StoredGoogleOAuth | null = null;
let cacheStamp = 0;
const CACHE_TTL_MS = 60_000;

function clientCreds(): { id: string; secret: string } | null {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  return { id, secret };
}

/** True iff env vars for OAuth are configured. Independent of whether any
 *  user has actually connected yet. */
export function isGoogleOAuthConfigured(): boolean {
  return clientCreds() !== null;
}

/** Build the OAuth redirect URL the same way as Discord OAuth: prefer an
 *  explicit env, otherwise derive from the inbound request. */
export function buildGoogleRedirectUri(req: any): string {
  const explicit = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = req.get("host");
  return `${proto}://${host}/api/admin/google/callback`;
}

/** Build a bare OAuth2 client (no credentials loaded) for the consent URL. */
export function makeOAuth2Client(redirectUri: string): OAuth2Client | null {
  const creds = clientCreds();
  if (!creds) return null;
  return new google.auth.OAuth2(creds.id, creds.secret, redirectUri);
}

/** Read the stored connection (with 60s in-memory cache). */
export async function loadStoredOAuth(force = false): Promise<StoredGoogleOAuth | null> {
  const now = Date.now();
  if (!force && cachedRow !== null && now - cacheStamp < CACHE_TTL_MS) return cachedRow;
  // Allow explicit "not present" caching via a sentinel: we cache null too.
  if (!force && cachedRow === null && cacheStamp > 0 && now - cacheStamp < CACHE_TTL_MS) return null;
  try {
    const r = await db.execute<{ value: any }>(
      sql`SELECT "value" FROM "system_settings" WHERE "key" = ${SETTINGS_KEY} LIMIT 1`
    );
    const raw = r.rows[0]?.value;
    if (
      raw && typeof raw === "object" &&
      typeof (raw as any).refresh_token === "string" &&
      typeof (raw as any).email === "string"
    ) {
      cachedRow = raw as StoredGoogleOAuth;
    } else {
      cachedRow = null;
    }
    cacheStamp = now;
    return cachedRow;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "loadStoredOAuth failed");
    return null;
  }
}

export function invalidateGoogleOAuthCache(): void {
  cachedRow = null;
  cacheStamp = 0;
}

/** Returns a ready-to-use OAuth2 client (credentials set) if an operator
 *  has connected, otherwise null. Library auto-refreshes access tokens. */
export async function getGoogleOAuthClient(): Promise<OAuth2Client | null> {
  if (!isGoogleOAuthConfigured()) return null;
  const stored = await loadStoredOAuth();
  if (!stored) return null;
  // Redirect URI is not used for refresh — pass empty string is fine, but
  // the library prefers a value. We pass a placeholder; it's only consulted
  // during the initial code exchange.
  const client = makeOAuth2Client("postmessage");
  if (!client) return null;
  client.setCredentials({ refresh_token: stored.refresh_token });
  return client;
}

/** Persist (or overwrite) the connected Google account. */
export async function saveStoredOAuth(input: {
  refresh_token: string;
  email: string;
  connected_by_admin_id: number | null;
}): Promise<StoredGoogleOAuth> {
  const next: StoredGoogleOAuth = {
    refresh_token: input.refresh_token,
    email: input.email,
    connected_at: new Date().toISOString(),
    connected_by_admin_id: input.connected_by_admin_id,
  };
  await db.execute(
    sql`INSERT INTO "system_settings" ("key", "value", "updated_at")
        VALUES (${SETTINGS_KEY}, ${JSON.stringify(next)}::jsonb, NOW())
        ON CONFLICT ("key") DO UPDATE
          SET "value" = EXCLUDED."value", "updated_at" = NOW()`
  );
  invalidateGoogleOAuthCache();
  return next;
}

/** Wipe the connection. Also attempts a best-effort revocation on Google's
 *  side so the token is invalidated immediately. */
export async function clearStoredOAuth(): Promise<void> {
  const existing = await loadStoredOAuth(true);
  await db.execute(sql`DELETE FROM "system_settings" WHERE "key" = ${SETTINGS_KEY}`);
  invalidateGoogleOAuthCache();
  if (existing?.refresh_token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(existing.refresh_token)}`, {
        method: "POST",
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Google token revoke failed (DB row already deleted)");
    }
  }
}
