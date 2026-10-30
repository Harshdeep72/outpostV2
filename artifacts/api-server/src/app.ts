import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import path from "node:path";
import fs from "node:fs";
import { pool } from "@workspace/db";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: Express = express();

// Trust Replit's reverse proxy so secure cookies work behind HTTPS.
// Without this, express-session refuses to set Set-Cookie when secure: true,
// silently breaking dashboard login (every request after login returns 401).
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// CORS allowlist — credentialed cross-origin requests must come from a
// known dashboard host. We assemble an exact-match allowlist of hostnames
// from three trusted sources:
//   1. DASHBOARD_ORIGIN env (comma-separated full origins, e.g.
//      "https://dash.example.com,https://staging.dash.example.com")
//   2. REPLIT_DOMAINS env — comma-separated list of THIS project's
//      Replit-issued domains (deployment + preview), e.g.
//      "create-buddy.replit.app,xxx.riker.replit.dev"
//   3. REPLIT_DEV_DOMAIN env — the workspace preview domain
// We do NOT trust *.replit.app / *.replit.dev as a wildcard, because that
// would let any other Replit user's app issue credentialed requests against
// us and read responses (cookie session theft). Only this project's own
// Replit-issued hostnames are accepted.
const explicitOrigins = new Set(
  (process.env.DASHBOARD_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const trustedHostnames = new Set<string>([
  // User's custom domain (dashboard).
  "inferynx.xyz",
  "www.inferynx.xyz",
  // API subdomain — same-origin requests from the dashboard once we move
  // dashboard → inferynx.xyz and API → api.inferynx.xyz won't hit CORS at
  // all (no Origin), but listing here is harmless and future-proof.
  "api.inferynx.xyz",
  // GitHub Pages free hosting for the dashboard (per-user subdomain),
  // kept as fallback so the github.io URL keeps working.
  "gauravksharma099-boop.github.io",
]);
for (const env of [process.env.REPLIT_DOMAINS, process.env.REPLIT_DEV_DOMAIN]) {
  if (!env) continue;
  for (const host of env.split(",").map((s) => s.trim()).filter(Boolean)) {
    trustedHostnames.add(host.toLowerCase());
  }
}

// Support Render external URL if available
if (process.env.RENDER_EXTERNAL_URL) {
  try {
    const renderHostname = new URL(process.env.RENDER_EXTERNAL_URL).hostname.toLowerCase();
    trustedHostnames.add(renderHostname);
  } catch (err) {
    logger.error({ err, url: process.env.RENDER_EXTERNAL_URL }, "Failed to parse RENDER_EXTERNAL_URL");
  }
}

app.use(
  cors((req, cb) => {
    const origin = req.header("Origin");
    const corsOptions = { credentials: true, origin: false as boolean | string | string[] };

    if (!origin) {
      corsOptions.origin = true;
      return cb(null, corsOptions);
    }

    if (explicitOrigins.has(origin)) {
      corsOptions.origin = origin;
      return cb(null, corsOptions);
    }

    let hostname = "";
    try {
      hostname = new URL(origin).hostname.toLowerCase();
    } catch {
      return cb(new Error(`CORS: invalid origin ${origin}`));
    }

    // Dynamic same-origin check:
    // Compare Origin hostname with req.hostname. Under "trust proxy",
    // Express automatically parses X-Forwarded-Host to get the correct external host.
    const requestHostname = req.hostname?.toLowerCase();

    if (
      trustedHostnames.has(hostname) ||
      (requestHostname && hostname === requestHostname) ||
      (process.env.NODE_ENV !== "production" && /^(localhost|127\.0\.0\.1)$/.test(hostname))
    ) {
      corsOptions.origin = origin;
      return cb(null, corsOptions);
    }

    return cb(new Error(`CORS: origin ${origin} is not allowed`));
  })
);

// Scoped large-body parser — applied ONLY to the task-create upload endpoint
// (which may carry up to 10 base64-encoded media files). Must be mounted
// before the global parser so it wins for this specific path. Every other
// route uses the small 12mb global parser below, which keeps the rest of the
// API immune to large-body memory pressure / DoS.
app.use("/api/admin/tasks/create", express.json({ limit: "120mb" }));
// Global parser for everything else (kept at 12mb — same as pre-multi-file).
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error("SESSION_SECRET environment variable is required");
}

// Persist sessions in Postgres so logins survive server restarts and page
// refreshes. Without a persistent store, express-session falls back to an
// in-memory MemoryStore that wipes every login on each restart/deploy.
//
// We provision the `user_sessions` table ourselves at startup (fire-and-forget)
// because connect-pg-simple's `createTableIfMissing` reads a `table.sql` file
// that the esbuild bundler does not include in dist/. Doing it here means a
// fresh database (e.g. brand-new environment) auto-bootstraps without manual
// SQL.
void pool
  .query(
    `CREATE TABLE IF NOT EXISTS user_sessions (
       sid varchar NOT NULL PRIMARY KEY,
       sess json NOT NULL,
       expire timestamp(6) NOT NULL
     );
     CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON user_sessions (expire);`
  )
  .catch((err: unknown) => logger.error({ err }, "Failed to bootstrap user_sessions table"));

// Add applications/management columns to admin_users (existing rows treated as
// active so the founding admin keeps logging in).
void pool
  .query(
    `CREATE EXTENSION IF NOT EXISTS pgcrypto;
     CREATE TABLE IF NOT EXISTS admin_users (
       id serial PRIMARY KEY,
       username text NOT NULL UNIQUE,
       password_hash text,
       role text NOT NULL DEFAULT 'client',
       setup_token text,
       created_at timestamptz NOT NULL DEFAULT now()
     );
     ALTER TABLE admin_users
       ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
       ADD COLUMN IF NOT EXISTS display_name text,
       ADD COLUMN IF NOT EXISTS email text,
       ADD COLUMN IF NOT EXISTS notes text,
       ADD COLUMN IF NOT EXISTS applied_at timestamptz NOT NULL DEFAULT now(),
       ADD COLUMN IF NOT EXISTS approved_at timestamptz,
       ADD COLUMN IF NOT EXISTS approved_by integer,
       ADD COLUMN IF NOT EXISTS first_login_unlocked boolean NOT NULL DEFAULT false,
       ADD COLUMN IF NOT EXISTS discord_id text,
       ADD COLUMN IF NOT EXISTS discord_username text,
       ADD COLUMN IF NOT EXISTS discord_avatar text,
       ADD COLUMN IF NOT EXISTS discord_linked_at timestamptz;
     CREATE INDEX IF NOT EXISTS idx_admin_users_discord_id ON admin_users (discord_id);`
  )
  .then(async () => {
    // Seed the founder (dev) and pre-authorized admins. They can log in by
    // typing their username + any password the FIRST time — that becomes their
    // password and is locked in. Subsequent logins require that exact password.
    // smurf_xz: dev role, password preset to the one the founder gave us.
    await pool.query(
      `INSERT INTO admin_users (username, role, status, password_hash, first_login_unlocked, display_name)
       VALUES ('smurf_xz', 'dev', 'active', crypt($1, gen_salt('bf')), false, 'Smurf (Founder)')
       ON CONFLICT (username) DO UPDATE
         SET role = 'dev',
             status = 'active',
             password_hash = COALESCE(admin_users.password_hash, EXCLUDED.password_hash),
             display_name = COALESCE(admin_users.display_name, EXCLUDED.display_name)`,
      ["smurf123987897@"]
    );
    // jishan / jishand / damy: admin role, NO password yet. On first login,
    // whatever password they type becomes their permanent password.
    // 'jishan' is the canonical spelling; 'jishand' is kept as an alias for
    // anyone who already memorized the old name.
    //
    // ONE-SHOT RESET: if 'jishan' doesn't exist yet (i.e. this is the first
    // deploy after the username-fix), also clear password_hash on the legacy
    // 'jishand' and 'damy' rows so they can re-set their password if they
    // accidentally locked themselves out with a typo on the very first login.
    const jishanExists = await pool.query(
      `SELECT 1 FROM admin_users WHERE username = 'jishan' LIMIT 1`
    );
    if (jishanExists.rowCount === 0) {
      await pool.query(
        `UPDATE admin_users
            SET password_hash = NULL, first_login_unlocked = true, status = 'active'
          WHERE username IN ('jishand', 'damy')`
      );
      logger.info("One-shot reset: cleared passwords for jishand/damy so they can re-set on next login");
    }

    for (const username of ["jishan", "jishand", "damy"]) {
      await pool.query(
        `INSERT INTO admin_users (username, role, status, password_hash, first_login_unlocked)
         VALUES ($1, 'admin', 'active', NULL, true)
         ON CONFLICT (username) DO UPDATE
           SET role = CASE WHEN admin_users.role IN ('dev') THEN admin_users.role ELSE 'admin' END,
               status = 'active',
               first_login_unlocked = (admin_users.password_hash IS NULL)`,
        [username]
      );
    }
    logger.info("Seeded founder/admin accounts (smurf_xz=dev, jishan/jishand/damy=admin)");
  })
  .catch((err: unknown) => logger.error({ err }, "Failed to bootstrap admin_users columns / seed accounts"));

// Add karma + account-age gates to tasks so creators can require, e.g.,
// "≥100 karma" or "≥30-day-old Reddit account".
void pool
  .query(
    `ALTER TABLE tasks
       ADD COLUMN IF NOT EXISTS min_karma integer NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS min_account_age_days integer NOT NULL DEFAULT 0;`
  )
  .catch((err: unknown) => logger.error({ err }, "Failed to bootstrap task gating columns"));

// Add live-status tracking columns to submissions for the Reddit liveness checker.
void pool
  .query(
    `ALTER TABLE submissions
       ADD COLUMN IF NOT EXISTS live_status text NOT NULL DEFAULT 'unknown',
       ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
       ADD COLUMN IF NOT EXISTS removal_reason text,
       ADD COLUMN IF NOT EXISTS live_status_changed_at timestamptz;
     CREATE INDEX IF NOT EXISTS idx_submissions_liveness
       ON submissions (review_status, last_checked_at)
       WHERE review_status = 'accepted';`
  )
  .catch((err: unknown) => logger.error({ err }, "Failed to bootstrap submissions liveness columns"));

// Track which changelog version each guild has been notified about so that
// patch notes only get posted once per release.
void pool
  .query(
    `ALTER TABLE server_config
       ADD COLUMN IF NOT EXISTS last_changelog_version text;`
  )
  .catch((err: unknown) => logger.error({ err }, "Failed to bootstrap server_config last_changelog_version"));

const PgSession = connectPgSimple(session);
const sessionStore = new PgSession({
  pool,
  tableName: "user_sessions",
  createTableIfMissing: false,
  pruneSessionInterval: 60 * 60, // prune expired rows every hour
});

app.use(
  session({
    store: sessionStore,
    name: "outpost.sid",
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // refresh maxAge on every authenticated request
    cookie: {
      httpOnly: true,
      // When the dashboard is hosted on a different domain than the API
      // (e.g. Vercel/Netlify dashboard + Render API), cookies must be
      // SameSite=None;Secure for the browser to send them cross-site.
      // Set CROSS_SITE_COOKIES=true in that case. Default stays "lax"
      // for same-origin or proxied setups.
      secure:
        (process.env.NODE_ENV === "production" || process.env.CROSS_SITE_COOKIES === "true") &&
        process.env.LOCAL_DEV !== "true",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      // In production we always use SameSite=None so the standalone
      // dashboard hosted on a different domain (e.g. inferynx.xyz on
      // Hostinger) can send the session cookie cross-site to this API.
      // Same-origin requests (the bundled dashboard) still work because
      // SameSite=None doesn't restrict same-site requests, it just permits
      // cross-site ones.
      sameSite:
        (process.env.NODE_ENV === "production" || process.env.CROSS_SITE_COOKIES === "true") &&
        process.env.LOCAL_DEV !== "true"
          ? "none"
          : "lax",
      // When dashboard and API are on different subdomains of the same
      // registrable domain (e.g. inferynx.xyz + api.inferynx.xyz), set
      // COOKIE_DOMAIN=.inferynx.xyz so the browser treats the session cookie
      // as first-party and shares it across both. Leave unset for same-origin
      // or fully cross-site setups.
      ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
    },
  })
);

app.use("/api", router);

// Optional: serve the built dashboard from this same Node process.
// If DASHBOARD_DIST_PATH is not explicitly set, auto-detect from known locations.
let dashboardDistPath = process.env.DASHBOARD_DIST_PATH;
if (!dashboardDistPath) {
  const candidates = [
    path.resolve(process.cwd(), "artifacts/dashboard/dist/public"),
    path.resolve(process.cwd(), "../dashboard/dist/public"),
    path.resolve(process.cwd(), "dashboard/dist/public"),
    path.resolve(__dirname, "../../dashboard/dist/public"),
    path.resolve(__dirname, "../../../artifacts/dashboard/dist/public"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) {
      dashboardDistPath = c;
      break;
    }
  }
}

if (dashboardDistPath) {
  if (!fs.existsSync(path.join(dashboardDistPath, "index.html")) && dashboardDistPath.includes("Outpost-sucks1-main/")) {
    const parts = dashboardDistPath.split("Outpost-sucks1-main/");
    if (parts[1]) {
      const candidate = path.resolve(process.cwd(), parts[1]);
      if (fs.existsSync(path.join(candidate, "index.html"))) {
        dashboardDistPath = candidate;
      }
    }
  }
  const resolvedDist = path.resolve(dashboardDistPath);
  const indexHtmlPath = path.join(resolvedDist, "index.html");
  if (fs.existsSync(indexHtmlPath)) {
    logger.info({ dashboardDistPath: resolvedDist }, "Serving dashboard SPA from API server");
    app.use(express.static(resolvedDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/).*/, (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET") return next();
      res.sendFile(indexHtmlPath);
    });
  } else {
    logger.warn({ dashboardDistPath: resolvedDist }, "Dashboard dist path found but index.html missing");
    mountFallbackLandingPage(app);
  }
} else {
  mountFallbackLandingPage(app);
}

function mountFallbackLandingPage(app: express.Express) {
  app.get(/^\/(?!api\/).*/, (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reddit Microtasks</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0b0e14; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #151922; border: 1px solid #232936; border-radius: 12px; padding: 32px; max-width: 480px; width: 100%; text-align: center; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }
    .icon { font-size: 32px; margin-bottom: 12px; }
    h1 { font-size: 20px; margin: 0 0 8px 0; color: #fff; }
    .status { color: #10b981; font-weight: 600; font-size: 14px; margin: 0 0 16px 0; }
    p { color: #9ca3af; font-size: 14px; line-height: 1.5; margin: 0 0 24px 0; }
    a { display: inline-block; background: #3b82f6; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚡</div>
    <h1>Reddit Microtasks Bot</h1>
    <p class="status">● System Operational & Connected</p>
    <p>The Discord bot backend and API server are live. Tasks, claims, and automated verification are running in Discord.</p>
    <a href="/api/healthz">API Health Status</a>
  </div>
</body>
</html>`);
  });
}

export default app;
