import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { TASK_COOLDOWN_MINUTES } from "../bot/constants.js";

export interface CooldownConfig {
  enabled: boolean;
  minutes: number;
}

const CACHE_TTL_MS = 30_000;
let cooldownCache: { value: CooldownConfig; at: number } | null = null;

const COOLDOWN_KEY = "cooldown";
const DEFAULT_COOLDOWN: CooldownConfig = {
  enabled: true,
  minutes: TASK_COOLDOWN_MINUTES,
};

function clampMinutes(n: unknown): number {
  const v = typeof n === "number" ? n : parseInt(String(n));
  if (!Number.isFinite(v)) return DEFAULT_COOLDOWN.minutes;
  return Math.max(0, Math.min(60 * 24 * 30, Math.round(v)));
}

export async function getCooldownConfig(): Promise<CooldownConfig> {
  const now = Date.now();
  if (cooldownCache && now - cooldownCache.at < CACHE_TTL_MS) {
    return cooldownCache.value;
  }
  try {
    const res = await db.execute<{ value: any }>(
      sql`SELECT "value" FROM "system_settings" WHERE "key" = ${COOLDOWN_KEY} LIMIT 1`
    );
    const raw = res.rows[0]?.value;
    let cfg: CooldownConfig = { ...DEFAULT_COOLDOWN };
    if (raw && typeof raw === "object") {
      const v = raw as Record<string, unknown>;
      if (typeof v.enabled === "boolean") cfg.enabled = v.enabled;
      cfg.minutes = clampMinutes(v.minutes ?? DEFAULT_COOLDOWN.minutes);
    }
    cooldownCache = { value: cfg, at: now };
    return cfg;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "getCooldownConfig fallback to default");
    cooldownCache = { value: DEFAULT_COOLDOWN, at: now };
    return DEFAULT_COOLDOWN;
  }
}

export async function setCooldownConfig(input: Partial<CooldownConfig>): Promise<CooldownConfig> {
  const current = await getCooldownConfig();
  const next: CooldownConfig = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    minutes: input.minutes != null ? clampMinutes(input.minutes) : current.minutes,
  };
  await db.execute(
    sql`INSERT INTO "system_settings" ("key", "value", "updated_at")
        VALUES (${COOLDOWN_KEY}, ${JSON.stringify(next)}::jsonb, NOW())
        ON CONFLICT ("key") DO UPDATE
          SET "value" = EXCLUDED."value", "updated_at" = NOW()`
  );
  cooldownCache = { value: next, at: Date.now() };
  return next;
}

export function invalidateSettingsCache(): void {
  cooldownCache = null;
  autoBumpCache = null;
  maxRedditAccountsCache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Max Reddit accounts per Discord user — configurable from dashboard.
// Default 3, range 1–20. Changing this never deletes existing accounts.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_REDDIT_ACCOUNTS_KEY = "max_reddit_accounts";
const DEFAULT_MAX_REDDIT_ACCOUNTS = 3;
let maxRedditAccountsCache: { value: number; at: number } | null = null;

export async function getMaxRedditAccounts(): Promise<number> {
  const now = Date.now();
  if (maxRedditAccountsCache && now - maxRedditAccountsCache.at < CACHE_TTL_MS) {
    return maxRedditAccountsCache.value;
  }
  try {
    const res = await db.execute<{ value: any }>(
      sql`SELECT "value" FROM "system_settings" WHERE "key" = ${MAX_REDDIT_ACCOUNTS_KEY} LIMIT 1`
    );
    const raw = res.rows[0]?.value;
    let v = DEFAULT_MAX_REDDIT_ACCOUNTS;
    if (raw && typeof raw === "object" && typeof (raw as any).max === "number") {
      v = Math.max(1, Math.min(20, Math.round((raw as any).max)));
    }
    maxRedditAccountsCache = { value: v, at: now };
    return v;
  } catch {
    return DEFAULT_MAX_REDDIT_ACCOUNTS;
  }
}

export async function setMaxRedditAccounts(max: number): Promise<number> {
  const v = Math.max(1, Math.min(20, Math.round(max)));
  await db.execute(
    sql`INSERT INTO "system_settings" ("key", "value", "updated_at")
        VALUES (${MAX_REDDIT_ACCOUNTS_KEY}, ${JSON.stringify({ max: v })}::jsonb, NOW())
        ON CONFLICT ("key") DO UPDATE
          SET "value" = EXCLUDED."value", "updated_at" = NOW()`
  );
  maxRedditAccountsCache = { value: v, at: Date.now() };
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature #9 — Dutch auction auto-bump master switch.
// Off by default. When disabled, the autoBumper cron does nothing even if
// individual tasks have auto_bump_percent > 0. Gives admins one "kill switch".
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoBumpConfig {
  enabled: boolean;
}

const AUTO_BUMP_KEY = "auto_bump";
const DEFAULT_AUTO_BUMP: AutoBumpConfig = { enabled: false };
let autoBumpCache: { value: AutoBumpConfig; at: number } | null = null;

export async function getAutoBumpConfig(): Promise<AutoBumpConfig> {
  const now = Date.now();
  if (autoBumpCache && now - autoBumpCache.at < CACHE_TTL_MS) {
    return autoBumpCache.value;
  }
  try {
    const res = await db.execute<{ value: any }>(
      sql`SELECT "value" FROM "system_settings" WHERE "key" = ${AUTO_BUMP_KEY} LIMIT 1`
    );
    const raw = res.rows[0]?.value;
    let cfg: AutoBumpConfig = { ...DEFAULT_AUTO_BUMP };
    if (raw && typeof raw === "object" && typeof (raw as any).enabled === "boolean") {
      cfg.enabled = (raw as any).enabled;
    }
    autoBumpCache = { value: cfg, at: now };
    return cfg;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "getAutoBumpConfig fallback to default");
    autoBumpCache = { value: DEFAULT_AUTO_BUMP, at: now };
    return DEFAULT_AUTO_BUMP;
  }
}

export async function setAutoBumpConfig(input: Partial<AutoBumpConfig>): Promise<AutoBumpConfig> {
  const current = await getAutoBumpConfig();
  const next: AutoBumpConfig = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
  };
  await db.execute(
    sql`INSERT INTO "system_settings" ("key", "value", "updated_at")
        VALUES (${AUTO_BUMP_KEY}, ${JSON.stringify(next)}::jsonb, NOW())
        ON CONFLICT ("key") DO UPDATE
          SET "value" = EXCLUDED."value", "updated_at" = NOW()`
  );
  autoBumpCache = { value: next, at: Date.now() };
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxy list — stored in DB instead of proxies.txt because Render's
// filesystem is ephemeral (resets on every deploy/restart). The dashboard
// UI saves here; proxy.ts reads from here on every reload tick.
//
// Value shape: { list: string[] } — one proxy URL per element.
// Format examples (per element):
//   user:pass@host:port
//   http://user:pass@host:port
//   socks5://user:pass@host:port
// Empty array = direct connection (no proxy) — bot still works, just no rotation.
// ─────────────────────────────────────────────────────────────────────────────
const PROXIES_KEY = "proxies";
// Cache stores BOTH the list and whether a DB row exists. This distinction
// matters: an admin saving `[]` (intentional "no proxies, use direct") must
// take precedence over any legacy proxies.txt on disk. A truly-absent row
// (`exists:false`) means the operator has never configured proxies in the
// dashboard, so the file fallback should kick in.
let proxiesCache: { value: { list: string[]; exists: boolean }; at: number } | null = null;

export interface ProxiesWithMeta {
  list: string[];
  /** true if a row exists in system_settings (even if list is []) */
  exists: boolean;
}

export async function getProxiesWithMeta(): Promise<ProxiesWithMeta> {
  const now = Date.now();
  if (proxiesCache && now - proxiesCache.at < CACHE_TTL_MS) {
    return proxiesCache.value;
  }
  try {
    const res = await db.execute<{ value: any }>(
      sql`SELECT "value" FROM "system_settings" WHERE "key" = ${PROXIES_KEY} LIMIT 1`
    );
    const exists = res.rows.length > 0;
    const raw = res.rows[0]?.value;
    let list: string[] = [];
    if (raw && typeof raw === "object" && Array.isArray((raw as any).list)) {
      list = (raw as any).list.filter((x: unknown) => typeof x === "string" && x.trim().length > 0);
    }
    const value = { list, exists };
    proxiesCache = { value, at: now };
    return value;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "getProxiesWithMeta fallback to empty/absent");
    const value = { list: [] as string[], exists: false };
    proxiesCache = { value, at: now };
    return value;
  }
}

export async function getProxies(): Promise<string[]> {
  return (await getProxiesWithMeta()).list;
}

export async function setProxies(list: string[]): Promise<string[]> {
  // De-duplicate + trim + drop empty/comments. Cap at 500 to keep the JSON
  // blob small and prevent accidental DoS via a 10k-line paste.
  const cleaned = Array.from(new Set(
    list
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter((s) => s.length > 0 && !s.startsWith("#"))
  )).slice(0, 500);
  await db.execute(
    sql`INSERT INTO "system_settings" ("key", "value", "updated_at")
        VALUES (${PROXIES_KEY}, ${JSON.stringify({ list: cleaned })}::jsonb, NOW())
        ON CONFLICT ("key") DO UPDATE
          SET "value" = EXCLUDED."value", "updated_at" = NOW()`
  );
  // After save, row definitely exists — set exists:true so the file fallback
  // is suppressed even when the operator explicitly chose an empty list.
  proxiesCache = { value: { list: cleaned, exists: true }, at: Date.now() };
  return cleaned;
}

export function invalidateProxiesCache(): void {
  proxiesCache = null;
}
