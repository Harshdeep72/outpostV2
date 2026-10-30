import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { recheckRedditLiveness } from "./reddit-validator.js";
import { invalidateUser } from "./cache.js";
import { getPrimaryGuild } from "./discord-client.js";
import { setupGuild } from "./setup.js";
import { makeEmbed } from "./util.js";
import { COLORS } from "./constants.js";
import { logger } from "../lib/logger.js";

export interface BatchItemResult {
  id: string;
  worker: string;
  discordId: string;
  workspaceChannelId?: string | null;
  proofLink: string;
  status: "APPROVED_LIVE" | "ALREADY_ACCEPTED" | "NOT_LIVE";
  liveness: string;
  reward: string;
  paymentMethod: string;
  paymentDestination: string;
}

export interface WorkerPayoutSummary {
  worker: string;
  discordId: string;
  workspaceChannelId: string | null;
  totalAmount: number;
  paymentMethod: string;
  paymentDestination: string;
  submissions: Array<{
    id: string;
    reward: string;
    proofLink: string;
  }>;
}

export async function auditAndApproveBatchEarly(): Promise<{
  totalChecked: number;
  liveApprovedCount: number;
  alreadyAcceptedCount: number;
  notLiveCount: number;
  totalPayoutAmount: number;
  items: BatchItemResult[];
  workers: WorkerPayoutSummary[];
}> {
  // 1. Fetch submissions from last 48 hours
  const subsResult = await db.execute<{
    id: string;
    task_id: string;
    user_id: string;
    discord_id: string;
    proof_link: string;
    review_status: string;
    live_status: string;
    reward: string;
    submitted_at: string;
    moved_to_available: number;
    discord_username: string;
    workspace_channel_id: string | null;
    upi_id: string | null;
    paypal_email: string | null;
    gcash_number: string | null;
    crypto_wallets: any;
  }>(sql`
    SELECT s.id, s.task_id, s.user_id, s.discord_id, s.proof_link, s.review_status, s.live_status, s.reward, s.submitted_at, s.moved_to_available,
           u.discord_username, u.workspace_channel_id, u.upi_id, u.paypal_email, u.gcash_number, u.crypto_wallets
      FROM submissions s
      JOIN users u ON u.id = s.user_id
     WHERE s.submitted_at > NOW() - INTERVAL '48 hours'
     ORDER BY s.id ASC
  `);

  const items: BatchItemResult[] = [];
  let liveApprovedCount = 0;
  let alreadyAcceptedCount = 0;
  let notLiveCount = 0;
  let totalPayoutAmount = 0;

  for (const sub of subsResult.rows) {
    const subId = parseInt(sub.id);
    const userId = parseInt(sub.user_id);
    const rewardNum = parseFloat(sub.reward) || 1.0;

    // Determine payment info
    let method = "Not Set";
    let destination = "Not Set";
    if (sub.upi_id) {
      method = "UPI";
      destination = sub.upi_id;
    } else if (sub.paypal_email) {
      method = "PayPal";
      destination = sub.paypal_email;
    } else if (sub.gcash_number) {
      method = "GCash";
      destination = sub.gcash_number;
    } else if (sub.crypto_wallets && typeof sub.crypto_wallets === "object") {
      const entries = Object.entries(sub.crypto_wallets);
      if (entries.length > 0) {
        const [coin, val] = entries[0]!;
        method = coin;
        destination = typeof val === "object" ? ((val as any)?.address ?? JSON.stringify(val)) : String(val);
      }
    }

    if (sub.review_status === "accepted") {
      // If previously accepted (e.g. by manual admin click) but not yet moved to available, move now
      if (!sub.moved_to_available || Number(sub.moved_to_available) === 0) {
        await db.execute(sql`
          UPDATE submissions
             SET moved_to_available = 1,
                 paid_at = NOW(),
                 last_checked_at = NOW(),
                 review_reason = 'Early approved for payout by client/operator'
           WHERE id = ${subId}
        `);
        await db.execute(sql`
          UPDATE users
             SET balance_pending   = GREATEST(0, balance_pending - ${sub.reward}::numeric),
                 balance_available = balance_available + ${sub.reward}::numeric,
                 total_earned      = total_earned + ${sub.reward}::numeric
           WHERE id = ${userId}
        `);
        invalidateUser(sub.discord_id, userId);
      }

      alreadyAcceptedCount++;
      totalPayoutAmount += rewardNum;
      items.push({
        id: sub.id,
        worker: sub.discord_username,
        discordId: sub.discord_id,
        workspaceChannelId: sub.workspace_channel_id,
        proofLink: sub.proof_link,
        status: "ALREADY_ACCEPTED",
        liveness: sub.live_status,
        reward: sub.reward,
        paymentMethod: method,
        paymentDestination: destination,
      });
      continue;
    }

    // Check liveness on Reddit live!
    let liveness = await recheckRedditLiveness(sub.proof_link).catch(() => ({ liveStatus: "unknown" as const }));

    if (liveness.liveStatus === "live") {
      // Approve and shift funds to available balance!
      await db.execute(sql`
        UPDATE submissions
           SET review_status = 'accepted',
               live_status = 'live',
               moved_to_available = 1,
               paid_at = NOW(),
               last_checked_at = NOW(),
               review_reason = 'Early approved for payout by client/operator'
         WHERE id = ${subId}
      `);

      await db.execute(sql`
        UPDATE users
           SET balance_pending   = GREATEST(0, balance_pending - ${sub.reward}::numeric),
               balance_available = balance_available + ${sub.reward}::numeric,
               total_earned      = total_earned + ${sub.reward}::numeric,
               trust_score       = LEAST(1000, trust_score + 2),
               last_task_completed_at = NOW()
         WHERE id = ${userId}
      `);

      invalidateUser(sub.discord_id, userId);
      liveApprovedCount++;
      totalPayoutAmount += rewardNum;

      items.push({
        id: sub.id,
        worker: sub.discord_username,
        discordId: sub.discord_id,
        workspaceChannelId: sub.workspace_channel_id,
        proofLink: sub.proof_link,
        status: "APPROVED_LIVE",
        liveness: "live",
        reward: sub.reward,
        paymentMethod: method,
        paymentDestination: destination,
      });
    } else {
      notLiveCount++;
      items.push({
        id: sub.id,
        worker: sub.discord_username,
        discordId: sub.discord_id,
        workspaceChannelId: sub.workspace_channel_id,
        proofLink: sub.proof_link,
        status: "NOT_LIVE",
        liveness: liveness.liveStatus,
        reward: sub.reward,
        paymentMethod: method,
        paymentDestination: destination,
      });
    }
  }

  // ── GROUP BY WORKER ──────────────────────────────────────────────
  const eligibleItems = items.filter(
    (i) => i.status === "APPROVED_LIVE" || i.status === "ALREADY_ACCEPTED"
  );

  const workerMap = new Map<string, WorkerPayoutSummary>();
  for (const item of eligibleItems) {
    let w = workerMap.get(item.discordId);
    if (!w) {
      w = {
        worker: item.worker,
        discordId: item.discordId,
        workspaceChannelId: item.workspaceChannelId ?? null,
        totalAmount: 0,
        paymentMethod: item.paymentMethod,
        paymentDestination: item.paymentDestination,
        submissions: [],
      };
      workerMap.set(item.discordId, w);
    }
    w.totalAmount += parseFloat(item.reward) || 1.0;
    w.submissions.push({
      id: item.id,
      reward: item.reward,
      proofLink: item.proofLink,
    });
  }

  const workerList = Array.from(workerMap.values());
  // Sort: workers with saved payout first, then descending by amount
  workerList.sort((a, b) => {
    const aSet = a.paymentMethod !== "Not Set" ? 1 : 0;
    const bSet = b.paymentMethod !== "Not Set" ? 1 : 0;
    if (aSet !== bSet) return bSet - aSet;
    return b.totalAmount - a.totalAmount;
  });

  // Post to Discord channel
  try {
    const guild = getPrimaryGuild();
    if (guild) {
      const { withdrawalLogChannel, taskLogsChannel } = await setupGuild(guild);
      const ch = withdrawalLogChannel || taskLogsChannel;
      if (ch && "send" in ch) {
        const readyCount = workerList.filter((w) => w.paymentMethod !== "Not Set").length;
        const missingCount = workerList.filter((w) => w.paymentMethod === "Not Set").length;

        const embed = makeEmbed(COLORS.SUCCESS)
          .setTitle("💰 Early Batch Payout — Grouped by Worker")
          .setDescription(
            `**Payout Summary:**\n` +
            `• **Total Unique Workers:** ${workerList.length} (${readyCount} ready to pay, ${missingCount} missing payment details)\n` +
            `• **Total Live Tasks Approved:** ${eligibleItems.length}\n` +
            `• **Total Batch Amount:** **$${totalPayoutAmount.toFixed(2)}**\n` +
            `• **Not Live / Filtered:** ${notLiveCount}\n\n` +
            `*Each worker below shows their combined total across all tasks. Pay them once, then run the clear command in their ticket.*`
          );

        const fields = workerList.slice(0, 25).map((w) => {
          const taskCountText = `${w.submissions.length} task${w.submissions.length > 1 ? "s" : ""}`;
          const subLinks = w.submissions.map((s) => `[#${s.id}](${s.proofLink})`).join(", ");
          const payLine =
            w.paymentMethod !== "Not Set"
              ? `💳 **Pay To:** \`${w.paymentDestination}\` (${w.paymentMethod})`
              : `⚠️ **Pay To:** *Not Set (waiting for worker)*`;
          const ticketLine = w.workspaceChannelId ? ` | 📂 <#${w.workspaceChannelId}>` : "";
          const resetCmd = `\`/removebalance user:<@${w.discordId}> amount:${w.totalAmount} reason:Paid batch\``;

          return {
            name: `👤 ${w.worker} — $${w.totalAmount.toFixed(2)} (${taskCountText})`,
            value: `Tasks: ${subLinks}${ticketLine}\n${payLine}\nClear Balance: ${resetCmd}`,
            inline: false,
          };
        });

        if (fields.length > 0) embed.addFields(fields);

        await ch.send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to post early payout embed to Discord");
  }

  return {
    totalChecked: items.length,
    liveApprovedCount,
    alreadyAcceptedCount,
    notLiveCount,
    totalPayoutAmount,
    items,
    workers: workerList,
  };
}
