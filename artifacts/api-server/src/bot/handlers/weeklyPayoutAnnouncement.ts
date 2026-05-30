// Weekly Payout Announcement — posts a single PNG summary to #announcements
// once ALL of the current Wednesday's withdrawals have been finalized.
//
// SAFETY CONTRACT:
//  - Caller (handlers/withdrawals.ts) wraps this in try/catch.
//  - Any failure here MUST NOT block withdrawal finalization. We swallow and
//    log; the withdrawal is already approved in the DB at the call site.
//  - Idempotent: a successful post claims a row in system_settings; a second
//    invocation for the same Wednesday is a no-op.

import type { Guild } from "discord.js";
import { AttachmentBuilder } from "discord.js";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { setupGuild } from "../setup.js";
import { logger } from "../../lib/logger.js";
import { formatMoney } from "../util.js";
import { renderPayoutWeeklyCard, type PayoutWeeklyRow } from "../card-renderer.js";

const ANNOUNCED_KEY = "weekly_payout_announced";

interface BatchRow {
  wd_id: number;
  user_discord_id: string;
  user_username: string | null;
  wd_amount: string;
  wd_method: string;
  wd_destination: string;
  admin_discord_id: string | null;
  admin_username: string | null;
}

/**
 * Mask a payout destination for public display. We show the first 3 chars,
 * stars, then the domain (for emails/UPI) or last 3 chars (for wallets).
 * Never returns the raw value.
 */
function maskDestination(dest: string | null | undefined): string {
  if (!dest || typeof dest !== "string") return "—";
  const trimmed = dest.trim();
  if (trimmed.length === 0) return "—";
  if (trimmed.includes("@")) {
    const at = trimmed.indexOf("@");
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    // Show at most ceil(local/3) chars and never the entire local part. For a
    // 1-2 char local ("a@x", "ab@x") this means zero visible chars + stars,
    // which avoids leaking the whole address.
    const showN = local.length <= 3 ? 0 : Math.min(3, local.length - 1);
    const visible = local.slice(0, showN);
    return `${visible}***@${domain}`;
  }
  // Non-email (crypto wallet / Binance ID / etc). For very short values we
  // refuse to show any prefix at all — otherwise we'd leak the whole string.
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`;
}

/**
 * Friendly display name for a creator id. Real Discord ids resolve to the
 * stored discord_username. Dashboard pseudo-ids ("dashboard:alice") fall
 * back to the username after the colon. Matches the helper in withdrawals.ts.
 */
function resolveAdminLabel(adminDiscordId: string, fetchedUsername: string | null): string {
  if (adminDiscordId.startsWith("dashboard:")) {
    return adminDiscordId.slice("dashboard:".length);
  }
  return fetchedUsername ?? adminDiscordId;
}

/**
 * Atomically claim the "announce slot" for the given anchor timestamp. Returns
 * true if this caller is responsible for posting (and updated the row), false
 * if a previous caller already announced this week's cycle.
 */
async function claimAnnounceSlot(anchorIso: string): Promise<boolean> {
  // The WHERE clause on the DO UPDATE makes the upsert a no-op when the
  // existing row already has the same anchor, so RETURNING is empty in that
  // case → we know someone already announced.
  const res = await db.execute<{ key: string }>(sql`
    INSERT INTO "system_settings" ("key", "value", "updated_at")
    VALUES (${ANNOUNCED_KEY}, ${JSON.stringify({ anchor: anchorIso })}::jsonb, NOW())
    ON CONFLICT ("key") DO UPDATE
      SET "value" = EXCLUDED."value", "updated_at" = NOW()
      WHERE ("system_settings"."value"->>'anchor') IS DISTINCT FROM ${anchorIso}
    RETURNING "key"
  `);
  return res.rows.length > 0;
}

/**
 * Release a previously-claimed announce slot. Called when sending the
 * announcement fails AFTER the claim, so the next finalizing admin can
 * re-trigger the post instead of permanently dropping this week's recap.
 * Best-effort: a failure here just means we'll skip this week's announcement
 * (logged), but the bot is otherwise unaffected.
 */
async function releaseAnnounceSlot(anchorIso: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM "system_settings"
     WHERE "key" = ${ANNOUNCED_KEY}
       AND ("value"->>'anchor') = ${anchorIso}
  `);
}

export async function tryPostWeeklyPayoutAnnouncement(guild: Guild): Promise<void> {
  // 1. Find the current payout cycle anchor (the timestamp that the cron's
  //    atomic CAS stamped when this week's runWeeklyPayouts started).
  const cfgRes = await db.execute<{ last_weekly_payout_at: Date | null }>(sql`
    SELECT last_weekly_payout_at FROM server_config LIMIT 1
  `);
  const anchor = cfgRes.rows[0]?.last_weekly_payout_at;
  if (!anchor) {
    logger.debug("Weekly payout announcement: no anchor yet, skipping");
    return;
  }
  const anchorDate = new Date(anchor as unknown as string);
  const anchorIso = anchorDate.toISOString();

  // 2. Check if there are any withdrawals from this cycle still pending. The
  //    cycle is defined by requested_at (stamped at insert in runWeeklyPayouts)
  //    rather than processed_at, so pending & approved use the SAME window
  //    semantics — no stale-row drift, no off-by-one between the two queries.
  const pendingRes = await db.execute<{ id: number }>(sql`
    SELECT id FROM withdrawals
     WHERE status = 'pending' AND requested_at >= ${anchorIso}
     LIMIT 1
  `);
  if (pendingRes.rows.length > 0) {
    logger.debug("Weekly payout announcement: still pending withdrawals in cycle, skipping");
    return;
  }

  // 3. Atomically claim the announce slot for this anchor. If another concurrent
  //    handler already claimed it, abort silently.
  const claimed = await claimAnnounceSlot(anchorIso);
  if (!claimed) {
    logger.debug("Weekly payout announcement: already announced for anchor", { anchorIso });
    return;
  }

  // 4. Fetch all approved withdrawals from this cycle + their per-creator
  //    payout breakdown. Same `requested_at >= anchor` window as the pending
  //    check above. Left-join users twice (earner + admin).
  const batchRes = await db.execute<BatchRow>(sql`
    SELECT
      w.id                          AS wd_id,
      w.discord_id                  AS user_discord_id,
      eu.discord_username           AS user_username,
      w.amount::text                AS wd_amount,
      w.method                      AS wd_method,
      w.destination                 AS wd_destination,
      wcp.creator_discord_id        AS admin_discord_id,
      au.discord_username           AS admin_username
    FROM withdrawals w
    LEFT JOIN withdrawal_creator_payouts wcp
           ON wcp.withdrawal_id = w.id AND wcp.status = 'paid'
    LEFT JOIN users eu ON eu.discord_id = w.discord_id
    LEFT JOIN users au ON au.discord_id = wcp.creator_discord_id
    WHERE w.status = 'approved' AND w.requested_at >= ${anchorIso}
    ORDER BY w.amount::numeric DESC, w.id
  `);

  if (batchRes.rows.length === 0) {
    logger.debug("Weekly payout announcement: no approved withdrawals in cycle, skipping");
    return;
  }

  // 5. Group rows by user (one row in the card per user). Track admin set.
  const byUser = new Map<number, {
    username: string;
    amount: string;
    method: string;
    destinationMasked: string;
    paidBy: Set<string>;
  }>();
  const allAdmins = new Set<string>();
  let totalAmount = 0;

  for (const r of batchRes.rows) {
    if (!byUser.has(r.wd_id)) {
      byUser.set(r.wd_id, {
        username: r.user_username ?? r.user_discord_id,
        amount: formatMoney(r.wd_amount),
        method: r.wd_method,
        destinationMasked: maskDestination(r.wd_destination),
        paidBy: new Set<string>(),
      });
      totalAmount += parseFloat(r.wd_amount);
    }
    if (r.admin_discord_id) {
      const label = resolveAdminLabel(r.admin_discord_id, r.admin_username);
      byUser.get(r.wd_id)!.paidBy.add(label);
      allAdmins.add(label);
    }
  }

  const rows: PayoutWeeklyRow[] = Array.from(byUser.values()).map((u) => ({
    username: u.username,
    amount: u.amount,
    method: u.method,
    destinationMasked: u.destinationMasked,
    paidBy: Array.from(u.paidBy),
  }));

  // 6. Render the card.
  const now = new Date();
  const payDate = anchorDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  const generatedAt = now.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata", hour12: true }) + " IST";

  const png = renderPayoutWeeklyCard({
    payDate,
    generatedAt,
    totalAmount: formatMoney(totalAmount.toFixed(2)),
    totalUsers: rows.length,
    totalAdmins: allAdmins.size,
    rows,
  });

  // 7. Post to #announcements. If anything from here to the end of the send
  //    fails, release the slot so the NEXT finalize-completing admin (or a
  //    manual retry) can post the recap instead of dropping this week.
  try {
    const { announcementsChannel } = await setupGuild(guild);
    const file = new AttachmentBuilder(png, { name: "weekly-payout.png" });
    await announcementsChannel.send({
      content: `🎉 **Wednesday Payday recap** — ${rows.length} ${rows.length === 1 ? "earner" : "earners"} got paid ${formatMoney(totalAmount.toFixed(2))} this week.`,
      files: [file],
    });

    logger.info({
      guildId: guild.id,
      anchorIso,
      users: rows.length,
      admins: allAdmins.size,
      totalAmount,
    }, "Weekly payout announcement posted");
  } catch (sendErr) {
    await releaseAnnounceSlot(anchorIso).catch((relErr) =>
      logger.warn({ err: relErr, anchorIso }, "Failed to release announce slot after send failure")
    );
    throw sendErr;
  }
}
