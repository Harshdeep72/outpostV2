import app from "./app.js";
import { logger } from "./lib/logger.js";
import { startBot } from "./bot/index.js";
import { pool } from "@workspace/db";
import { bootstrapSchema } from "./lib/bootstrapSchema.js";

const REQUIRED_ENV = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_CLIENT_ID",
  "DISCORD_GUILD_ID",
  "DATABASE_URL",
  "SESSION_SECRET",
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  if (process.env["NODE_ENV"] !== "production") {
    logger.warn({ missing }, "Missing required environment variables in development — server will still start");
  } else {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

const port = Number(process.env["PORT"] ?? 3000);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received — shutting down");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("SIGINT received — shutting down");
  process.exit(0);
});

pool.on("error", (err: Error) => {
  logger.error({ err }, "pg pool error");
});

async function probeDatabase(): Promise<void> {
  for (let i = 1; i <= 5; i++) {
    try {
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      logger.info("Database probe successful");
      return;
    } catch (err) {
      logger.error({ err, attempt: i }, "Database probe failed");
      if (i < 5) await new Promise((r) => setTimeout(r, i * 1000));
    }
  }
  logger.error("Database probe failed after 5 attempts — continuing anyway");
}

app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");

  await probeDatabase();
  try {
    await bootstrapSchema();
  } catch (err) {
    logger.error({ err }, "Schema bootstrap failed — bot may not function until DB is fixed");
  }
  await startBot();
});
