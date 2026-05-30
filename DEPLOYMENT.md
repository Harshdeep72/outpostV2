# Deployment Guide

This guide shows how to host Outpost Bot anywhere — Replit, a Contabo VPS,
Hostinger VPS, DigitalOcean droplet, or any other Linux server with Node.js.

The same code runs in all environments. Only the env vars and start command differ.

---

## Option 1 — Replit (current setup)

Already configured. Push your code and click **Publish**. Replit handles ports,
HTTPS, the reverse proxy, and the Postgres database for you. Secrets live in
the **Secrets** pane (no `.env` file needed).

The dashboard runs as its own artifact at `/` and the API at `/api`.

---

## Option 2 — VPS (Contabo, Hostinger VPS, DigitalOcean, etc.)

Below is a complete walk-through assuming a fresh Ubuntu 22.04 / 24.04 server.
Total time: ~20 minutes.

### Step 1 — Install Node.js 20+ and pnpm

```bash
# Install Node 20 via nodesource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pnpm (this project requires it — npm/yarn won't work)
sudo npm install -g pnpm
```

Verify:

```bash
node --version    # should print v20.x or higher
pnpm --version    # should print 9.x or higher
```

### Step 2 — Install Postgres

```bash
sudo apt-get install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql

# Create database + user
sudo -u postgres psql <<'SQL'
CREATE USER outpost WITH PASSWORD 'pick-a-strong-password-here';
CREATE DATABASE outpost OWNER outpost;
GRANT ALL PRIVILEGES ON DATABASE outpost TO outpost;
SQL
```

Your `DATABASE_URL` will be:

```
postgres://outpost:pick-a-strong-password-here@localhost:5432/outpost
```

### Step 3 — Clone your code

```bash
cd /var/www
sudo git clone https://github.com/your-username/your-repo.git outpost
sudo chown -R $USER:$USER outpost
cd outpost
```

(Or upload via SFTP / `scp` if you don't use Git.)

### Step 4 — Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in all values. At minimum:

- `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`
- `DATABASE_URL` (from Step 2)
- `SESSION_SECRET` — generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `NODE_ENV=production`
- `PORT=3000` (or any free port)
- Leave `DASHBOARD_DIST_PATH` commented out for now — the `start:vps` script sets it for you.

### Step 5 — Install deps and build

```bash
pnpm install
pnpm run build:all
```

This builds the dashboard (Vite) and the API server (esbuild) into their `dist/` folders.

### Step 6 — Run database migrations

```bash
pnpm --filter @workspace/db run db:push
```

### Step 7 — Start the app

For a quick test:

```bash
set -a && source .env && set +a
pnpm run start:vps
```

You should see:
```
Server listening port: 3000
Serving dashboard SPA from API server
Database probe successful
Discord bot ready
```

Open `http://YOUR_SERVER_IP:3000` — you should see the dashboard. Login with
your admin credentials. Stop with `Ctrl+C`.

### Step 8 — Run as a service with PM2 (so it survives reboots)

```bash
sudo npm install -g pm2

# Start under PM2 with all env vars from .env
pm2 start --name outpost --interpreter bash -- -c "set -a && source /var/www/outpost/.env && set +a && cd /var/www/outpost && pnpm run start:vps"

# Save the process list and enable auto-start on reboot
pm2 save
pm2 startup
# (run the command pm2 startup prints, e.g. `sudo env PATH=... pm2 startup ...`)
```

Useful PM2 commands:

```bash
pm2 status         # see if it's running
pm2 logs outpost   # tail logs
pm2 restart outpost
pm2 stop outpost
```

### Step 9 (optional) — Put nginx in front for HTTPS + a real domain

If you want `https://yourdomain.com` instead of `http://1.2.3.4:3000`:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/outpost`:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable + get HTTPS:

```bash
sudo ln -s /etc/nginx/sites-available/outpost /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com
```

Done — your bot + dashboard are now live at `https://yourdomain.com`.

---

## Option 3 — Hostinger Shared Hosting

**Don't.** Shared hosting cannot run a 24/7 Node.js process or a Discord
gateway connection. You need either:

- **Hostinger VPS** (KVM 1 or higher) — follow Option 2 above. It's just a Linux box.
- **Hostinger Cloud Hosting** — same story, follow Option 2.

---

## Updating the bot after deploy (VPS)

```bash
cd /var/www/outpost
git pull
pnpm install
pnpm run build:all
pm2 restart outpost
```

If you changed the database schema:
```bash
pnpm --filter @workspace/db run db:push
```

---

## Troubleshooting

**Bot starts but slash commands don't appear in Discord**
- Make sure `DISCORD_GUILD_ID` matches the server you invited the bot to.
- Check logs: `pm2 logs outpost` — look for "Slash commands registered count: 23".

**"Failed to load stats" on the dashboard**
- Confirm `SESSION_SECRET` is set and `NODE_ENV=production`.
- Confirm the `user_sessions` table exists: `psql $DATABASE_URL -c '\d user_sessions'`.

**"Cannot GET /"**
- `DASHBOARD_DIST_PATH` is unset or wrong. Use `pnpm run start:vps` (it sets it automatically), or set it manually to the absolute path of `artifacts/dashboard/dist/public`.

**Database connection errors**
- Double-check `DATABASE_URL` format and that Postgres is running: `sudo systemctl status postgresql`.

**Port already in use**
- Something else is on port 3000. Either kill it (`sudo lsof -i :3000`) or change `PORT` in `.env`.
