# Hosting Outpost Bot — Render (API + Bot) and a separate host for the Dashboard

This guide deploys the project the way you asked: **Discord bot + API on Render**, **dashboard on a different platform** (Vercel / Netlify / Cloudflare Pages / Hostinger). The two halves stay loosely coupled through one env var, so you can swap either host later without touching the other.

```
                ┌──────────────────────────────┐
                │  Dashboard (React/Vite SPA)  │   ← Vercel / Netlify / etc.
                │   https://dash.example.com   │
                └──────────────┬───────────────┘
                               │ fetch(VITE_API_BASE_URL + "/api/...")
                               │ credentials: include  (session cookie)
                               ▼
                ┌──────────────────────────────┐
                │  Outpost API + Discord Bot   │   ← Render Web Service
                │   https://api.example.com    │
                └──────────────┬───────────────┘
                               │
                  ┌────────────┴────────────┐
                  ▼                         ▼
           Postgres (Neon /          Discord Gateway
           Render Postgres)          (bot session)
```

---

## Part 1 — Deploy the bot + API on Render

### 1.1  Create the Postgres database
Either:
- **Render Postgres** (free 1 GB, in the same region as your service), or
- **Neon** (already used in dev — copy the pooled connection string).

You only need `DATABASE_URL` (must support SSL).

### 1.2  Create the Web Service

1. <https://dashboard.render.com> → **New** → **Web Service** → connect your GitHub repo.
2. Settings:

   | Field | Value |
   |---|---|
   | **Name** | `outpost-api` |
   | **Region** | Same as your DB |
   | **Branch** | `main` |
   | **Runtime** | Node |
   | **Build Command** | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @workspace/api-server run build` |
   | **Start Command** | `pnpm --filter @workspace/api-server run start` |
   | **Instance Type** | Free works; Starter ($7/mo) avoids 15-min cold starts |

3. **Environment Variables** — Advanced section:
   ```
   DATABASE_URL          = postgres://…?sslmode=require
   DISCORD_BOT_TOKEN     = <bot token>
   DISCORD_CLIENT_ID     = <application id>
   DISCORD_GUILD_ID      = <your server id>
   SESSION_SECRET        = <openssl rand -hex 32>
   NODE_ENV              = production
   CROSS_SITE_COOKIES    = true        ← REQUIRED if dashboard is on a different domain
   DASHBOARD_ORIGIN      = https://dash.example.com   ← REQUIRED for cross-origin (CORS allowlist)
   ```
   Don't set `PORT` — Render injects it automatically and the server reads `process.env.PORT`.

4. **Create Web Service** → wait ~3-5 min → note the public URL (e.g. `https://outpost-api.onrender.com`).

### 1.3  Invite the bot to Discord
Open this URL once (replace `<DISCORD_CLIENT_ID>`):
```
https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&permissions=8&scope=bot+applications.commands
```

Watch Render's **Logs**:
```
Server listening (port 10000)
Database probe successful
Seeded founder/admin accounts (smurf_xz=dev, jishand/damy=admin)
Schema bootstrap complete
Discord bot ready (v2 Flash Edition)  tag: Outpost bot#XXXX
25 slash commands registered
```

---

## Part 2 — Deploy the dashboard on Vercel (recommended)

> Same steps work for Netlify, Cloudflare Pages, or any static host. Just translate the field names.

### 2.1  Vercel

1. <https://vercel.com/new> → import the same GitHub repo.
2. **Framework Preset:** Vite
3. **Root Directory:** `artifacts/dashboard`
4. **Build Command:** `pnpm install --frozen-lockfile && pnpm run build`
   *(Vercel auto-detects pnpm via the workspace lockfile.)*
5. **Output Directory:** `dist/public`
6. **Environment Variables**:
   ```
   VITE_API_BASE_URL = https://outpost-api.onrender.com
   ```
   (No trailing slash. The dashboard adds `/api` itself.)
7. **Deploy** → note the URL (e.g. `https://dash.example.com`).

### 2.2  Tell the API who's allowed to talk to it — REQUIRED for cross-origin
Back on Render, set **`DASHBOARD_ORIGIN`** to the dashboard URL (e.g. `https://dash.example.com`) and redeploy. **This is mandatory** when the dashboard lives on a different domain — the API's CORS allowlist will reject any other origin from making credentialed requests. This prevents random third-party sites from being able to call your admin API using a logged-in user's cookie.

You can pass multiple origins as a comma-separated list:
```
DASHBOARD_ORIGIN = https://dash.example.com,https://staging-dash.example.com
```

In `NODE_ENV=development` the API also auto-allows any `localhost`, `127.0.0.1`, and `*.replit.dev` origin so local work just runs.

### 2.3  Netlify / Cloudflare Pages
Identical, just paste the same Build / Output / Env settings into their UI. For Netlify use **Functions: none** and **Publish directory:** `artifacts/dashboard/dist/public`.

### 2.4  Hostinger / cPanel / any "static file" host
1. Run locally: `cd artifacts/dashboard && VITE_API_BASE_URL=https://outpost-api.onrender.com pnpm build`
2. Upload `artifacts/dashboard/dist/public/*` to your `public_html`.
3. Add an `.htaccess` (Hostinger) or equivalent rewrite for SPA routing:
   ```apache
   RewriteEngine On
   RewriteBase /
   RewriteRule ^index\.html$ - [L]
   RewriteCond %{REQUEST_FILENAME} !-f
   RewriteCond %{REQUEST_FILENAME} !-d
   RewriteRule . /index.html [L]
   ```

---

## Part 3 — Verify it's wired correctly

1. Open `https://dash.example.com` → log in with `smurf_xz / smurf123987897@`.
2. Browser **DevTools → Network**: the login request should go to `https://outpost-api.onrender.com/api/admin/login`, return 200, and set a `Set-Cookie: outpost.sid=…; SameSite=None; Secure`.
3. Subsequent requests (`/api/admin/me`, `/api/admin/users`, …) should send that cookie and return 200.

If you see **"Unauthorized" loops** after login, it's almost always one of:
- `CROSS_SITE_COOKIES=true` not set on Render → cookie is `SameSite=Lax` → browser refuses to send it cross-site.
- Wrong `VITE_API_BASE_URL` (typo, trailing slash, http vs https mismatch) → SPA hits its own origin, which has no API.
- Browser blocking third-party cookies → use a custom domain on both sides (e.g. `app.smoky.dev` + `api.smoky.dev`) so they're same-site.

---

## Part 4 — Why these two pieces stay portable

| If you change… | What you have to update | What stays the same |
|---|---|---|
| The dashboard host (Vercel → Netlify → Hostinger) | Just rebuild and re-upload. No API change. | Same `VITE_API_BASE_URL`. The session cookie still works. |
| The API host (Render → Fly.io → Railway → VPS) | Update **one** env var on the dashboard host: `VITE_API_BASE_URL` → new URL → redeploy. | Dashboard code, schema, bot logic, Discord token. |
| The database (Neon → Render Postgres → Supabase) | Update `DATABASE_URL` on the API host. | Everything else. The bot's `Schema bootstrap complete` line means a fresh Postgres just works. |
| Both hosts at once | Both env vars above. The two services don't know each other's URLs except through env. | Application code. |

The contract between dashboard and API is **just two things**: the URL + the session cookie. That's it. No build-time linking, no shared infrastructure.

---

## Part 5 — Founder & dev role on the dashboard

| Username | Role | Initial password | Powers |
|---|---|---|---|
| `smurf_xz` | **dev** (highest) | `smurf123987897@` (locked) | Everything an admin can do, plus reserved for future dev-only routes. Sees a gold "DEV" badge. |
| `jishand` | admin | *first password you type sticks* | Full admin: applications, dashboard users, bulk task, all reads/writes. |
| `damy` | admin | *first password you type sticks* | Same as `jishand`. |

The role check `requireDevRole` on the API and `user.role === "dev"` on the dashboard already grant `smurf_xz` access to every route. You don't need to add anything else for "give the developer every right."

---

## Part 6 — Common gotchas

| Symptom | Fix |
|---|---|
| Login works but `/api/admin/me` returns 401 forever | `CROSS_SITE_COOKIES=true` missing on Render → set it, redeploy. |
| `CORS error: blocked by policy` in browser console | Either `VITE_API_BASE_URL` is missing/wrong on the dashboard build, **or** `DASHBOARD_ORIGIN` on the API doesn't include your dashboard URL exactly (scheme + host, no trailing slash). Check both. |
| `EADDRINUSE` on Render | Don't hard-code `PORT` in env vars. |
| Bot logs in but `/verify` doesn't appear in Discord | Wrong `DISCORD_GUILD_ID` or bot wasn't invited to that guild. |
| Free Render tier sleeps after 15 min idle | Either upgrade to Starter ($7/mo) or hit `https://outpost-api.onrender.com/api/health` from an uptime monitor. |
| `password authentication failed` for Postgres | URL-encode `@`, `:`, `/` in your DB password, or paste the connection string Render gives you verbatim. |

---

## Part 7 — Updating

Push to `main`. Both Render (API) and Vercel (dashboard) auto-redeploy. Slash commands re-register on every bot boot.
