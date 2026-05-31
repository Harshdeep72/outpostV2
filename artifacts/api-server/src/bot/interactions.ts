import {
  type Client,
  type Interaction,
  InteractionType,
} from "discord.js";
import { upsertUserSmart } from "./db.js";
import { logger } from "../lib/logger.js";

import { handleVerifyCommand, handleVerifyStart, handleVerifyModal, handleVerifyAccept, handleVerifyReject, handleVerifyRejectReason, handleVerifyRevoke, handleVerifyDismiss, handleVerifyUnlinkAccount, handleAdminVerifyCommand } from "./handlers/verification.js";
import { handleCreateTaskCommand, handleTaskCreateModal, handleTaskClaim, handleTaskDetails, handleClaimSubmit, handleClaimCopy, handleClaimReject, handleClaimRejectModal, handleClaimSubmitModal, handleSubAccept, handleSubReject, handleSubFlag, handleSubReviewReason, handleCampaignClaimNext } from "./handlers/tasks.js";
import { handleWalletCommand, handleSetupI, handleSetWallet, handleSetPaypal } from "./handlers/wallet.js";
import { handleSetupCommand, handleAddMod, handleRemoveMod, handleAddAdmin, handleFlagUser, handleUnflagUser, handleAddBalance, handleRemoveBalance, handleNotifyWalletMigration } from "./handlers/admin.js";
import { handleLeaderboardCommand, handleResetLeaderboard, handleLeaderboardPageButton } from "./handlers/leaderboard.js";
import { handleWdApprove, handleWdCreatorPay, handleWdReject, handleWdRejectReason } from "./handlers/withdrawals.js";
import { handleBulkTaskCommand, handleBulkTaskCsvModal } from "./handlers/bulktask.js";
import { handleReferralCommand, handleReferralUseCommand } from "./handlers/referral.js";
import { handleProfileCommand } from "./handlers/profile.js";
import { handleDigestCommand } from "./handlers/digest.js";
import { handleMassDmCommand, handleMassDmModal } from "./handlers/massdm.js";
import { handleSendStatsCommand, handleStatsPageButton } from "./handlers/sendStats.js";
import { handleTaskHistoryCommand, handlePayoutHistoryCommand, handleAdminPayoutHistoryCommand } from "./handlers/history.js";
import { handlePingCommand } from "./handlers/ping.js";
import { handleStatsCommand } from "./handlers/stats.js";
import { handleHealthCommand } from "./handlers/health.js";
import { handleCancelTaskCommand, handleCancelCampaignCommand } from "./handlers/canceltask.js";
import { handleTestUrlCommand } from "./handlers/testurl.js";

const SLOW_HANDLER_MS = 800;

async function timed(label: string, fn: () => Promise<unknown>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
  } finally {
    const dur = Date.now() - start;
    if (dur > SLOW_HANDLER_MS) {
      logger.warn({ handler: label, durationMs: dur }, "Slow handler");
    }
  }
}

export function registerInteractionHandler(client: Client) {
  client.on("interactionCreate", async (interaction: Interaction) => {
    try {
      if (interaction.guild && interaction.user) {
        upsertUserSmart(interaction.user.id, interaction.user.username).catch((err) => {
          logger.warn({ err, userId: interaction.user.id }, "Background upsertUser failed");
        });
      }

      if (interaction.isChatInputCommand()) {
        const name = interaction.commandName;
        if (name === "ping") return timed(name, () => handlePingCommand(interaction));
        if (name === "verify") return timed(name, () => handleVerifyCommand(interaction));
        if (name === "verifyuser") return timed(name, () => handleAdminVerifyCommand(interaction));
        if (name === "setup") return timed(name, () => handleSetupCommand(interaction));
        if (name === "createtask") return timed(name, () => handleCreateTaskCommand(interaction));
        if (name === "bulktask") return timed(name, () => handleBulkTaskCommand(interaction));
        if (name === "canceltask") return timed(name, () => handleCancelTaskCommand(interaction));
        if (name === "cancelcampaign") return timed(name, () => handleCancelCampaignCommand(interaction));
        if (name === "referral") return timed(name, () => handleReferralCommand(interaction));
        if (name === "referraluse") return timed(name, () => handleReferralUseCommand(interaction));
        if (name === "setupi") return timed(name, () => handleSetupI(interaction));
        if (name === "setpaypal") return timed(name, () => handleSetPaypal(interaction));
        if (name === "setwallet") return timed(name, () => handleSetWallet(interaction));
        if (name === "wallet") return timed(name, () => handleWalletCommand(interaction));
        if (name === "leaderboard") return timed(name, () => handleLeaderboardCommand(interaction));
        if (name === "resetleaderboard") return timed(name, () => handleResetLeaderboard(interaction));
        if (name === "addmod") return timed(name, () => handleAddMod(interaction));
        if (name === "removemod") return timed(name, () => handleRemoveMod(interaction));
        if (name === "addadmin") return timed(name, () => handleAddAdmin(interaction));
        if (name === "flag") return timed(name, () => handleFlagUser(interaction));
        if (name === "unflag") return timed(name, () => handleUnflagUser(interaction));
        if (name === "profile") return timed(name, () => handleProfileCommand(interaction));
        if (name === "digest") return timed(name, () => handleDigestCommand(interaction));
        if (name === "massdm") return timed(name, () => handleMassDmCommand(interaction));
        if (name === "sendstats") return timed(name, () => handleSendStatsCommand(interaction));
        if (name === "notifywalletmigration") return timed(name, () => handleNotifyWalletMigration(interaction));
        if (name === "taskhistory") return timed(name, () => handleTaskHistoryCommand(interaction));
        if (name === "payouthistory") return timed(name, () => handlePayoutHistoryCommand(interaction));
        if (name === "adminpayouthistory") return timed(name, () => handleAdminPayoutHistoryCommand(interaction));
        if (name === "stats") return timed(name, () => handleStatsCommand(interaction));
        if (name === "health") return timed(name, () => handleHealthCommand(interaction));
        if (name === "testurl") return timed(name, () => handleTestUrlCommand(interaction));
        if (name === "addbalance") return timed(name, () => handleAddBalance(interaction));
        if (name === "removebalance") return timed(name, () => handleRemoveBalance(interaction));
        logger.warn({ name }, "Unknown command");
        return;
      }

      if (interaction.isButton()) {
        const [scope, action, ...rest] = interaction.customId.split(":");
        const p1 = rest[0] ?? "";
        const p2 = rest[1] ?? "";
        const tag = `btn:${scope}:${action}`;

        if (scope === "verify") {
          if (action === "start") return timed(tag, () => handleVerifyStart(interaction));
          // verify:accept:<discordId>[:<redditUsernameLower>]
          // p2 is empty for legacy (pre-deploy) in-flight buttons —
          // handleVerifyAccept falls back to legacy behavior when missing.
          if (action === "accept") return timed(tag, () => handleVerifyAccept(interaction, p1, p2));
          if (action === "reject") return timed(tag, () => handleVerifyReject(interaction, p1));
          if (action === "revoke") return timed(tag, () => handleVerifyRevoke(interaction, p1));
          if (action === "dismiss") return timed(tag, () => handleVerifyDismiss(interaction));
          // verify:unlinkacc:<discordId>:<redditUsernameLower> — unlink a
          // single additional Reddit account from the verification log.
          if (action === "unlinkacc") return timed(tag, () => handleVerifyUnlinkAccount(interaction, p1, p2));
        }

        if (scope === "task") {
          if (action === "claim") return timed(tag, () => handleTaskClaim(interaction, parseInt(p1)));
          if (action === "details") return timed(tag, () => handleTaskDetails(interaction, parseInt(p1)));
        }

        if (scope === "campaign") {
          if (action === "claimnext") return timed(tag, () => handleCampaignClaimNext(interaction, parseInt(p1)));
        }

        if (scope === "claim") {
          if (action === "submit") return timed(tag, () => handleClaimSubmit(interaction, parseInt(p1)));
          if (action === "copy") return timed(tag, () => handleClaimCopy(interaction, parseInt(p1), "comment"));
          if (action === "copytitle") return timed(tag, () => handleClaimCopy(interaction, parseInt(p1), "title"));
          if (action === "copybody") return timed(tag, () => handleClaimCopy(interaction, parseInt(p1), "body"));
          if (action === "reject") return timed(tag, () => handleClaimReject(interaction, parseInt(p1)));
        }

        // Disabled placeholder buttons we put on a workspace message after
        // rejection — silently ack so Discord doesn't show a red error.
        if (scope === "noop") {
          await interaction.deferUpdate().catch(() => {});
          return;
        }

        if (scope === "sub") {
          if (action === "accept") return timed(tag, () => handleSubAccept(interaction, parseInt(p1)));
          if (action === "reject") return timed(tag, () => handleSubReject(interaction, parseInt(p1)));
          if (action === "flag") return timed(tag, () => handleSubFlag(interaction, parseInt(p1)));
        }

        if (scope === "stats") {
          // Paginated /sendstats card — `page` advances, `noop` is the
          // (disabled) middle indicator that should never actually fire.
          if (action === "page") return timed(tag, () => handleStatsPageButton(interaction, p1, p2));
          if (action === "noop") {
            await interaction.deferUpdate().catch(() => {});
            return;
          }
        }

        if (scope === "lb") {
          // Paginated leaderboard channel post — `page:N` switches page,
          // `noop` is the (disabled) middle "Page X / Y" indicator.
          if (action === "page") return timed(tag, () => handleLeaderboardPageButton(interaction, p1));
          if (action === "noop") {
            await interaction.deferUpdate().catch(() => {});
            return;
          }
        }

        if (scope === "wd") {
          if (action === "approve") return timed(tag, () => handleWdApprove(interaction, parseInt(p1)));
          if (action === "reject") return timed(tag, () => handleWdReject(interaction, parseInt(p1)));
          if (action === "cpay") {
            const parts = interaction.customId.split(":");
            return timed(tag, () => handleWdCreatorPay(interaction, parseInt(parts[2]!), parseInt(parts[3]!)));
          }
        }

        logger.warn({ customId: interaction.customId }, "Unknown button interaction");
        return;
      }

      if (interaction.isModalSubmit()) {
        const parts = interaction.customId.split(":");
        const scope = parts[0];
        const action = parts[1];
        const tag = `modal:${scope}:${action}`;

        if (scope === "verify") {
          if (action === "modal") return timed(tag, () => handleVerifyModal(interaction));
          if (action === "rejectreason") return timed(tag, () => handleVerifyRejectReason(interaction, parts[2]!, parts[3]!));
        }

        if (scope === "task" && action === "create") {
          // Phase 2 added a `cooldownEnabled` ("1"|"0") flag. Old in-flight
          // customIds (pre-deploy modals) had 7 segments; new format has 8
          // (type,reward,slots,time,hold,trust,cd,nonce). The length check
          // distinguishes them so we don't break old modals after deploy.
          const rest = parts.slice(2);
          const hasCooldown = rest.length >= 8;
          const [type, reward, slots, time, hold, trust] = rest;
          const cooldownEnabled = hasCooldown ? rest[6] !== "0" : true;
          const nonce = hasCooldown ? rest[7] : rest[6];
          return timed(tag, () => handleTaskCreateModal(
            interaction,
            type!,
            parseFloat(reward!),
            parseInt(slots!),
            parseInt(time!),
            parseInt(hold!),
            parseInt(trust!),
            cooldownEnabled,
            nonce
          ));
        }

        if (scope === "claim" && action === "submitmodal") {
          return timed(tag, () => handleClaimSubmitModal(interaction, parseInt(parts[2]!)));
        }

        if (scope === "claim" && action === "rejectmodal") {
          return timed(tag, () => handleClaimRejectModal(interaction, parseInt(parts[2]!)));
        }

        if (scope === "sub" && action === "reason") {
          const subAction = parts[2] as "reject" | "flag";
          return timed(tag, () => handleSubReviewReason(interaction, subAction, parseInt(parts[3]!)));
        }

        if (scope === "wd" && action === "reason") {
          return timed(tag, () => handleWdRejectReason(interaction, parseInt(parts[2]!)));
        }

        if (scope === "bulktask" && action === "csvmodal") {
          return timed(tag, () => handleBulkTaskCsvModal(interaction));
        }

        if (scope === "massdm" && action === "modal") {
          return timed(tag, () => handleMassDmModal(interaction, parts[2], parts[3]));
        }

        logger.warn({ customId: interaction.customId }, "Unknown modal interaction");
        return;
      }
    } catch (err: any) {
      logger.error({ err, customId: (interaction as any).customId ?? (interaction as any).commandName }, "Interaction handler error");
      const raw = String(err?.message ?? err ?? "unknown error");
      const isMissingTable = /relation ".*" does not exist/i.test(raw);
      const userMessage = isMissingTable
        ? "❌ The database isn't set up yet. An admin needs to run the database migration (`pnpm --filter @workspace/db push`) so the bot's tables exist."
        : `❌ Something went wrong: \`${raw.slice(0, 300)}\``;
      try {
        const i = interaction as any;
        if (typeof i.isModalSubmit === "function" && i.isModalSubmit() && !i.deferred && !i.replied) {
          await i.reply({ content: userMessage, flags: 64 }).catch(() => {});
        } else if (i.deferred && !i.replied) {
          await i.editReply({ content: userMessage }).catch(() => {});
        } else if (i.replied) {
          await i.followUp({ content: userMessage, flags: 64 }).catch(() => {});
        } else if (typeof i.reply === "function") {
          await i.reply({ content: userMessage, flags: 64 }).catch(() => {});
        }
      } catch {}
    }
  });
}
