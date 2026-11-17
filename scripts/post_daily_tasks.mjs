#!/usr/bin/env node
/**
 * Daily Task Automation CLI
 * Usage:
 *   node scripts/post_daily_tasks.mjs [--date=DD.MM.YYYY] [--dry-run] [--force]
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");

if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const DEFAULT_SHEET_URL =
  process.env.DAILY_TASKS_SHEET_URL ||
  "https://docs.google.com/spreadsheets/d/1-xyVOJH3jPOXMdpEWPeExuelSpgvG23KLaatc9oyCNw/edit?gid=576030809#gid=576030809";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const isForce = args.includes("--force");
let targetDate = "";
for (const a of args) {
  if (a.startsWith("--date=")) {
    targetDate = a.split("=")[1].trim();
  }
}

const dateBannerRegex = /(?:Date\s+)?(\d{1,2}[\.\-\/]\d{1,2}[\.\-\/]\d{2,4})/i;
const redditUrlRegex = /https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/[^\s"]+/i;

function parseCsvRows(raw) {
  const rows = [];
  let currentRow = [];
  let currentField = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQuotes && raw[i + 1] === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      currentRow.push(currentField.trim());
      currentField = "";
    } else if ((ch === '\r' || ch === '\n') && !inQuotes) {
      if (ch === '\r' && raw[i + 1] === '\n') i++;
      currentRow.push(currentField.trim());
      currentField = "";
      if (currentRow.some((f) => f.length > 0)) rows.push(currentRow);
      currentRow = [];
    } else {
      if (ch === '\r') {
        if (raw[i + 1] === '\n') i++;
        currentField += '\n';
      } else {
        currentField += ch;
      }
    }
  }
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((f) => f.length > 0)) rows.push(currentRow);
  }
  return rows;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("🚀 Outpost Daily Task Automation");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`📄 Target Sheet: ${DEFAULT_SHEET_URL}`);

  // Fetch sheet CSV
  const match = DEFAULT_SHEET_URL.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error("Invalid Google Sheets URL");
  const sheetId = match[1];
  const gidMatch = DEFAULT_SHEET_URL.match(/gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : "576030809";

  const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
  console.log(`⏳ Fetching CSV export from Google (${exportUrl})...`);

  const res = await fetch(exportUrl, {
    headers: { "User-Agent": "Mozilla/5.0 OutpostTaskBot/1.0" },
  });
  if (!res.ok) throw new Error(`Google Sheets fetch failed with status HTTP ${res.status}`);
  const rawCsv = await res.text();

  const rowsData = parseCsvRows(rawCsv);
  console.log(`✅ Loaded ${rowsData.length} raw rows from sheet.`);

  // Parse daily sections
  const sections = [];
  let current = { date: "unknown", rows: [] };

  for (let i = 0; i < rowsData.length; i++) {
    const row = rowsData[i];
    let rowDate = null;
    for (const cell of row) {
      if (!redditUrlRegex.test(cell)) {
        const m = cell.match(dateBannerRegex);
        if (m) {
          rowDate = m[1];
          break;
        }
      }
    }

    if (rowDate) {
      if (current.rows.length > 0) sections.push(current);
      current = { date: rowDate, rows: [] };
      continue;
    }

    const hasReddit = row.some((c) => redditUrlRegex.test(c));
    if (hasReddit) {
      current.rows.push(row);
    }
  }
  if (current.rows.length > 0) sections.push(current);

  const availableDates = sections.map((s) => s.date).filter((d) => d !== "unknown");
  console.log(`📅 Found date sections in sheet: ${availableDates.join(", ")}`);

  let selected = sections[sections.length - 1];
  if (targetDate) {
    const normTarget = targetDate.trim().toLowerCase().replace(/[\-\/]/g, ".");
    const found = sections.find((s) => s.date.trim().toLowerCase().replace(/[\-\/]/g, ".") === normTarget);
    if (!found) {
      throw new Error(`Target date "${targetDate}" not found. Available: ${availableDates.join(", ")}`);
    }
    selected = found;
  }

  console.log(`🎯 Active Date Drop: ${selected.date} (${selected.rows.length} Tasks)`);

  const tasks = [];
  for (let idx = 0; idx < selected.rows.length; idx++) {
    const r = selected.rows[idx];
    let link = "";
    let linkIdx = -1;
    for (let c = 0; c < r.length; c++) {
      const m = r[c].match(redditUrlRegex);
      if (m) {
        link = m[0];
        linkIdx = c;
        break;
      }
    }
    if (!link) continue;

    let comment = "";
    if (linkIdx !== -1 && linkIdx + 1 < r.length && !redditUrlRegex.test(r[linkIdx + 1])) {
      comment = r[linkIdx + 1].trim();
    } else if (r[2] && !redditUrlRegex.test(r[2])) {
      comment = r[2].trim();
    }

    if (comment.startsWith('"') && comment.endsWith('"') && comment.length >= 2) {
      comment = comment.slice(1, -1).trim();
    }

    const subMatch = link.match(/\/r\/([a-zA-Z0-9_]+)/i);
    const sub = subMatch ? subMatch[1] : "reddit";

    tasks.push({
      sno: idx + 1,
      sub,
      title: `Reddit Comment - r/${sub}`,
      task_link: link,
      comment,
      reward: 1.00,
      slots: 1,
      hold_hours: 24,
    });
  }

  console.log(`\n📋 Preview of Parsed Tasks:`);
  tasks.slice(0, 5).forEach((t) => {
    console.log(`  [${t.sno}] r/${t.sub} | ${t.task_link}`);
    console.log(`      Comment: "${t.comment.slice(0, 80)}..."`);
  });
  if (tasks.length > 5) {
    console.log(`  ... and ${tasks.length - 5} more tasks.`);
  }

  if (isDryRun) {
    console.log("\n🔎 Dry run complete. No database changes were made.");
    return;
  }

  console.log("\n💡 Quick Discord Command:");
  console.log(`   /bulktask sheets_url: ${DEFAULT_SHEET_URL} date: ${selected.date}\n`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
