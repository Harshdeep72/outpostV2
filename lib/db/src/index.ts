import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  min: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

pool.on("error", (err) => {
  console.error("[db pool] unexpected idle client error:", err.message);
});

export const db = drizzle(pool, { schema });

let warmerStarted = false;

export function startDbWarmer(intervalMs = 25_000): void {
  if (warmerStarted) return;
  warmerStarted = true;
  const ping = async () => {
    try {
      await pool.query("SELECT 1");
    } catch (err) {
      console.warn("[db warmer] ping failed:", (err as Error).message);
    }
  };
  void ping();
  setInterval(ping, intervalMs).unref();
}

export async function measureDbLatency(): Promise<number> {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    return Date.now() - start;
  } catch {
    return -1;
  }
}

export * from "./schema";
