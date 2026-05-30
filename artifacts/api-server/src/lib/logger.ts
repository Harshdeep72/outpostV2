import pino from "pino";
import { Writable } from "node:stream";

const isProduction = process.env.NODE_ENV === "production";

// ── In-memory ring buffer ────────────────────────────────────────────────────
// Every log line written by the pino logger is also captured here so that the
// /admin/console-logs endpoint can serve them to the dashboard in real time.

export interface LogEntry {
  level: string;
  message: string;
  time: string;
}

const MAX_LOG_ENTRIES = 500;
const IN_MEMORY_LOGS: LogEntry[] = [];

export function getInMemoryLogs(): LogEntry[] {
  return IN_MEMORY_LOGS;
}

export function pushLog(level: string, message: string) {
  IN_MEMORY_LOGS.push({ level, message, time: new Date().toISOString() });
  if (IN_MEMORY_LOGS.length > MAX_LOG_ENTRIES) {
    IN_MEMORY_LOGS.splice(0, IN_MEMORY_LOGS.length - MAX_LOG_ENTRIES);
  }
}

// pino level numbers → human-readable names
const LEVEL_LABELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

// Custom Writable stream that parses each newline-delimited JSON log record
// and pushes it into the ring buffer.
const memoryStream = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const levelLabel = LEVEL_LABELS[obj.level as number] ?? "info";
        // Prefer msg, fall back to message
        const msg: string = obj.msg ?? obj.message ?? line;
        pushLog(levelLabel, msg);
      } catch {
        // Not valid JSON (e.g. pino-pretty output) — store raw
        pushLog("info", line.trim());
      }
    }
    callback();
  },
});

// ── Logger construction ──────────────────────────────────────────────────────

// In development, send pretty output to stdout AND raw JSON to memoryStream.
// In production, send raw JSON to both stdout and memoryStream.
const streams: pino.StreamEntry[] = [
  {
    stream: process.stdout,
    level: (process.env.LOG_LEVEL ?? "info") as pino.Level,
  },
  {
    stream: memoryStream,
    level: (process.env.LOG_LEVEL ?? "info") as pino.Level,
  },
];

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
    ],
  },
  pino.multistream(streams)
);
