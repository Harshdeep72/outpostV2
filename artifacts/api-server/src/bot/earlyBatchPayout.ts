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
  proofLink: string;
  status: "APPROVED_LIVE" | "ALREADY_ACCEPTED" | "NOT_LIVE";
  liveness: string;
  reward: string;
  paymentMethod: string;
  paymentDestination: string;
}

export async function auditAndApproveBatchEarly(): Promise<{
  totalChecked: number;
  liveApprovedCount: number;
  alreadyAcceptedCount: number;
  notLiveCount: number;
  totalPayoutAmount: number;
  items: BatchItemResult[];
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
    discord_username: string;
    upi_id: string | null;
    paypal_email: string | null;
    gcash_number: string | null;
    crypto_wallets: any;
  }>(sql`
    SELECT s.id, s.task_id, s.user_id, s.discord_id, s.proof_link, s.review_status, s.live_status, s.reward, s.submitted_at,
           u.discord_username, u.upi_id, u.paypal_email, u.gcash_number, u.crypto_wallets
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
      alreadyAcceptedCount++;
      totalPayoutAmount += rewardNum;
      items.push({
        id: sub.id,
        worker: sub.discord_username,
        discordId: sub.discord_id,
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
        proofLink: sub.proof_link,
        status: "NOT_LIVE",
        liveness: liveness.liveStatus,
        reward: sub.reward,
        paymentMethod: method,
        paymentDestination: destination,
      });
    }
  }

  // Post to Discord channel
  try {
    const guild = getPrimaryGuild();
    if (guild) {
      const { withdrawalLogChannel, taskLogsChannel } = await setupGuild(guild);
      const ch = withdrawalLogChannel || taskLogsChannel;
      if (ch && "send" in ch) {
        const eligible = items.filter((i) => i.status === "APPROVED_LIVE" || i.status === "ALREADY_ACCEPTED");
        const embed = makeEmbed(COLORS.SUCCESS)
          .setTitle("💰 Early Batch Payout Audit & Approval")
          .setDescription(
            `**Client Payout Summary:**\n` +
            `• **Total Checked:** ${items.length}\n` +
            `• **Newly Approved (Live):** ${liveApprovedCount}\n` +
            `• **Previously Accepted:** ${alreadyAcceptedCount}\n` +
            `• **Not Live / Filtered:** ${notLiveCount}\n` +
            `• **Total Eligible Amount:** $${totalPayoutAmount.toFixed(2)}\n\n` +
            `Eligible rewards have been shifted to **Available Balance**.`
          );

        const fields = eligible.slice(0, 20).map((e) => ({
          name: `${e.worker} ($${e.reward})`,
          value: `**Sub #${e.id}** • [Proof Link](${e.proofLink})\n**Pay To:** ${e.paymentMethod}: \`${e.paymentDestination}\``,
          inline: false,
        }));
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
  };
}
