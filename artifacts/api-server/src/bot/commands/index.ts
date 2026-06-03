import {
  SlashCommandBuilder,
} from "discord.js";
import { TASK_TYPES, COIN_CHOICES } from "../constants.js";

const TASK_TYPE_LABELS: Record<string, string> = {
  comment: "Reddit: Comment",
  post: "Reddit: Post",
  upvote: "Reddit: Upvote",
  share: "Reddit: Share",
  join: "Reddit: Join",
  twitter_follow: "Twitter: Follow",
  twitter_like: "Twitter: Like",
  twitter_retweet: "Twitter: Retweet",
  twitter_reply: "Twitter: Reply",
  twitter_tweet: "Twitter: Tweet",
  quora_answer: "Quora: Answer",
  quora_follow: "Quora: Follow",
  quora_upvote: "Quora: Upvote",
};

function buildDigest(): SlashCommandBuilder {
  const b = new SlashCommandBuilder()
    .setName("digest")
    .setDescription("Opt in/out of the once-a-day DM digest of your earnings & new tasks")
    .setDMPermission(true);
  b.addSubcommand((s) => s.setName("on").setDescription("Turn the daily digest DM on"));
  b.addSubcommand((s) => s.setName("off").setDescription("Turn the daily digest DM off"));
  b.addSubcommand((s) => s.setName("status").setDescription("Check whether the digest is on"));
  return b;
}

export function getCommandBuilders(): SlashCommandBuilder[] {
  const verify = new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Post the public verification panel (admin/mod only)");

  const setup = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Bootstrap categories/channels/roles");

  const createtask = new SlashCommandBuilder()
    .setName("createtask")
    .setDescription("Open the task creation modal")
    .addStringOption((o) =>
      o.setName("type").setDescription("Task type").setRequired(true)
        .addChoices(...TASK_TYPES.map((t) => ({ name: TASK_TYPE_LABELS[t] ?? t, value: t })))
    )
    .addNumberOption((o) =>
      o.setName("reward").setDescription("Reward amount ($0.01–$1000)").setRequired(true)
        .setMinValue(0.01).setMaxValue(1000)
    )
    .addIntegerOption((o) =>
      o.setName("time_limit").setDescription("Minutes to complete after claiming (5–1440, default 60)")
        .setMinValue(5).setMaxValue(1440)
    )
    .addIntegerOption((o) =>
      o.setName("hold_hours").setDescription("Hours to hold payout after acceptance (0–720, default 168 = 7 days)")
        .setMinValue(0).setMaxValue(720)
    )
    .addIntegerOption((o) =>
      o.setName("min_trust").setDescription("Minimum trust score required to claim (0–500, default 0)")
        .setMinValue(0).setMaxValue(500)
    )
    .addBooleanOption((o) =>
      o.setName("cooldown_enabled")
        .setDescription("Apply task cooldown to this task (default true; off = no cooldown)")
        .setRequired(false)
    )
    .addAttachmentOption((o) =>
      o.setName("image").setDescription("Optional reference image — shown on the task card").setRequired(false)
    );

  const bulktask = new SlashCommandBuilder()
    .setName("bulktask")
    .setDescription("Create multiple tasks from a Google Sheets URL or pasted CSV")
    .addStringOption((o) =>
      o.setName("sheets_url")
        .setDescription("Public Google Sheets URL (omit to paste CSV manually)")
        .setRequired(false)
    )
    .addIntegerOption((o) =>
      o.setName("interval_minutes")
        .setDescription("Drip-feed: minutes between each task drop (0 = post all at once, default 0, max 1440)")
        .setMinValue(0).setMaxValue(1440).setRequired(false)
    )
    .addIntegerOption((o) =>
      o.setName("max_claims_per_user")
        .setDescription("Max times a single user can claim tasks in this campaign (0 = unlimited, default 1)")
        .setMinValue(0).setMaxValue(100).setRequired(false)
    );

  const referral = new SlashCommandBuilder()
    .setName("referral")
    .setDescription("View your referral code and earnings stats")
    .setDMPermission(true);

  const referralUse = new SlashCommandBuilder()
    .setName("referraluse")
    .setDescription("Apply a referral code before verifying")
    .setDMPermission(true)
    .addStringOption((o) =>
      o.setName("code").setDescription("Referral code (8 characters)").setRequired(true).setMaxLength(8)
    );

  const setupi = new SlashCommandBuilder()
    .setName("setupi")
    .setDescription("Save UPI ID for INR auto-payouts")
    .setDMPermission(true)
    .addStringOption((o) =>
      o.setName("upi_id").setDescription("Your UPI ID").setRequired(true)
    );

  const setpaypal = new SlashCommandBuilder()
    .setName("setpaypal")
    .setDescription("Save your PayPal email for payouts")
    .setDMPermission(true)
    .addStringOption((o) =>
      o.setName("email").setDescription("Your PayPal email address").setRequired(true)
    );

  const setwallet = new SlashCommandBuilder()
    .setName("setwallet")
    .setDescription("Save a crypto wallet OR Binance Pay ID for payouts")
    .setDMPermission(true)
    .addStringOption((o) =>
      o.setName("coin").setDescription("Coin / payout method").setRequired(true)
        .addChoices(
          { name: "ETH", value: "ETH" },
          { name: "USDT", value: "USDT" },
          { name: "BTC", value: "BTC" },
          { name: "Binance Pay ID", value: "BINANCE" },
        )
    )
    .addStringOption((o) =>
      o.setName("address").setDescription("Wallet address — or your Binance Pay ID (8–13 digit number)").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("network").setDescription("Chain / network — REQUIRED for USDT, optional for ETH/BTC, ignored for Binance")
        .setRequired(false)
        .addChoices(
          { name: "TRC20 (Tron) — USDT",                value: "TRC20" },
          { name: "ERC20 (Ethereum mainnet) — USDT/ETH", value: "ERC20" },
          { name: "BEP20 (BNB Chain) — USDT",            value: "BEP20" },
          { name: "Solana — USDT",                       value: "SOL" },
          { name: "Polygon — USDT/ETH",                  value: "POLYGON" },
          { name: "Arbitrum — ETH",                      value: "ARB" },
          { name: "Optimism — ETH",                      value: "OP" },
          { name: "Base — ETH",                          value: "BASE" },
          { name: "Bitcoin (mainnet) — BTC",             value: "BTC" },
          { name: "Lightning — BTC",                     value: "LIGHTNING" },
        )
    );

  const wallet = new SlashCommandBuilder()
    .setName("wallet")
    .setDescription("Show a public wallet card")
    .setDMPermission(true)
    .addUserOption((o) => o.setName("user").setDescription("User to look up (defaults to you)"));

  const leaderboard = new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Manually refresh the leaderboard");

  const resetleaderboard = new SlashCommandBuilder()
    .setName("resetleaderboard")
    .setDescription("Repost a fresh leaderboard message");

  const addmod = new SlashCommandBuilder()
    .setName("addmod")
    .setDescription("Add Mod role to a user")
    .addUserOption((o) => o.setName("user").setDescription("User to promote").setRequired(true));

  const removemod = new SlashCommandBuilder()
    .setName("removemod")
    .setDescription("Remove Mod role from a user")
    .addUserOption((o) => o.setName("user").setDescription("User to demote").setRequired(true));

  const addadmin = new SlashCommandBuilder()
    .setName("addadmin")
    .setDescription("Add Admin role to a user")
    .addUserOption((o) => o.setName("user").setDescription("User to promote").setRequired(true));

  const flag = new SlashCommandBuilder()
    .setName("flag")
    .setDescription("Flag a user (blocks task claiming and payouts)")
    .addUserOption((o) => o.setName("user").setDescription("User to flag").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Reason (optional)"));

  const unflag = new SlashCommandBuilder()
    .setName("unflag")
    .setDescription("Clear a user's flag")
    .addUserOption((o) => o.setName("user").setDescription("User to unflag").setRequired(true));

  const profile = new SlashCommandBuilder()
    .setName("profile")
    .setDescription("View a user's Reddit profile, karma, and earnings")
    .setDMPermission(true)
    .addUserOption((o) => o.setName("user").setDescription("User to look up (defaults to you)"));

  const massdm = new SlashCommandBuilder()
    .setName("massdm")
    .setDescription("Send a DM to server members or one specific user (admin/mod only)")
    .addUserOption((o) =>
      o.setName("user")
        .setDescription("DM only this user (skips the target group)")
        .setRequired(false)
    )
    .addStringOption((o) =>
      o.setName("target")
        .setDescription("Who should receive the DM? (ignored if `user` is set)")
        .setRequired(false)
        .addChoices(
          { name: "Verified members only", value: "verified" },
          { name: "Non-verified members only", value: "unverified" },
          { name: "Everyone (verified + non-verified)", value: "all" },
        )
    );

  const sendstats = new SlashCommandBuilder()
    .setName("sendstats")
    .setDescription("Post each verified user a personalized task-stats card in their workspace channel");

  const notifywalletmigration = new SlashCommandBuilder()
    .setName("notifywalletmigration")
    .setDescription("DM users with legacy crypto wallets to re-save with a network (admin only)");

  const taskhistory = new SlashCommandBuilder()
    .setName("taskhistory")
    .setDescription("Show tasks created by an admin or yourself")
    .addUserOption((o) => o.setName("user").setDescription("Admin to look up (defaults to you)"));

  const payouthistory = new SlashCommandBuilder()
    .setName("payouthistory")
    .setDescription("Show a user's own earning history (submissions they made)")
    .addUserOption((o) => o.setName("user").setDescription("User to look up (defaults to you)"));

  const adminpayouthistory = new SlashCommandBuilder()
    .setName("adminpayouthistory")
    .setDescription("Show payout reviews handled by an admin (reviewer view)")
    .addUserOption((o) => o.setName("user").setDescription("Admin to look up (defaults to you)"));

  const canceltask = new SlashCommandBuilder()
    .setName("canceltask")
    .setDescription("Cancel an open task by ID (admin/mod only)")
    .addIntegerOption((o) =>
      o.setName("task_id").setDescription("ID of the task to cancel").setRequired(true).setMinValue(1)
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason for cancellation (shown to claimers)").setRequired(false)
    );

  const cancelcampaign = new SlashCommandBuilder()
    .setName("cancelcampaign")
    .setDescription("Cancel all open tasks in a campaign (admin/mod only)")
    .addIntegerOption((o) =>
      o.setName("campaign_id").setDescription("ID of the campaign to cancel").setRequired(true).setMinValue(1)
    )
    .addStringOption((o) =>
      o.setName("reason").setDescription("Reason for cancellation (shown to claimers)").setRequired(false)
    );

  const verifyuser = new SlashCommandBuilder()
    .setName("verifyuser")
    .setDescription("Manually verify or unverify a Discord user (admin/mod only)")
    .addUserOption((o) =>
      o.setName("user").setDescription("The Discord user to verify or unverify").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("action")
        .setDescription("What to do")
        .setRequired(true)
        .addChoices(
          { name: "Verify (grant verified role)", value: "verify" },
          { name: "Unverify (remove verified role)", value: "unverify" },
        )
    )
    .addStringOption((o) =>
      o.setName("reddit_username")
        .setDescription("Reddit username to link (required when verifying without prior link)")
        .setRequired(false)
        .setMaxLength(20)
    );

  const ping = new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Show bot latency, DB speed, proxy status, and cache stats")
    .setDMPermission(true);

  const stats = new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show community stats — total earnings, tasks completed, top earner this week")
    .setDMPermission(true);

  const testurl = new SlashCommandBuilder()
    .setName("testurl")
    .setDescription("Run a Reddit proof URL through the full validation system and show the result (admin only)")
    .addStringOption((o) =>
      o.setName("url").setDescription("Full Reddit comment or post URL to test").setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("reddit_username")
        .setDescription("Reddit username to check authorship against (leave blank to skip author check)")
        .setRequired(false)
        .setMaxLength(20)
    );

  const health = new SlashCommandBuilder()
    .setName("health")
    .setDescription("Deep health check — DB latency, proxy success rate, Reddit API status (admin only)");

  const addbalance = new SlashCommandBuilder()
    .setName("addbalance")
    .setDescription("Add money to a user's available balance (admin only)")
    .addUserOption((o) => o.setName("user").setDescription("User to credit").setRequired(true))
    .addNumberOption((o) =>
      o
        .setName("amount")
        .setDescription("Amount to add (e.g. 5.00)")
        .setRequired(true)
        .setMinValue(0.01)
        .setMaxValue(10000),
    )
    .addStringOption((o) => o.setName("reason").setDescription("Reason (shown to user in DM)"));

  const removebalance = new SlashCommandBuilder()
    .setName("removebalance")
    .setDescription("Remove money from a user's available balance (admin only)")
    .addUserOption((o) => o.setName("user").setDescription("User to debit").setRequired(true))
    .addNumberOption((o) =>
      o
        .setName("amount")
        .setDescription("Amount to remove (e.g. 5.00)")
        .setRequired(true)
        .setMinValue(0.01)
        .setMaxValue(10000),
    )
    .addStringOption((o) => o.setName("reason").setDescription("Reason (shown to user in DM)"));

  const checksubmission = new SlashCommandBuilder()
    .setName("checksubmission")
    .setDescription("Manually re-check a submission's Reddit liveness right now (mod/admin only)")
    .addIntegerOption((o) =>
      o.setName("id")
        .setDescription("Submission ID to check (the number shown in task-logs, e.g. 1255)")
        .setRequired(true)
        .setMinValue(1)
    );

  const approvesubmission = new SlashCommandBuilder()
    .setName("approvesubmission")
    .setDescription("Manually approve a wrongly-rejected submission and credit the reward (mod/admin only)")
    .addIntegerOption((o) =>
      o.setName("id")
        .setDescription("Submission ID to approve (e.g. 1284)")
        .setRequired(true)
        .setMinValue(1)
    );

  const reopenslot = new SlashCommandBuilder()
    .setName("reopenslot")
    .setDescription("Reopen a task slot held by a rejected submission, making it claimable again (mod/admin only)")
    .addIntegerOption((o) =>
      o.setName("submission_id")
        .setDescription("ID of the rejected submission whose task slot should be freed (e.g. 1284)")
        .setRequired(true)
        .setMinValue(1)
    )
    .addStringOption((o) =>
      o.setName("reason")
        .setDescription("Reason for reopening (recorded in audit log)")
        .setRequired(false)
        .setMaxLength(300)
    );

  const mystatus = new SlashCommandBuilder()
    .setName("mystatus")
    .setDescription("View your pending submissions — reward, live status, and time until payout")
    .setDMPermission(true);

  const processholds = new SlashCommandBuilder()
    .setName("processholds")
    .setDescription("Force-run the pending holds processor immediately (admin only)");

  const forcepayout = new SlashCommandBuilder()
    .setName("forcepayout")
    .setDescription("Manually trigger the weekly bulk payout process (admin only)");

  return [
    verify, setup, createtask, bulktask, referral, referralUse,
    setupi, setpaypal, setwallet, wallet, leaderboard, resetleaderboard,
    addmod, removemod, addadmin, flag, unflag,
    profile, massdm, sendstats, notifywalletmigration, taskhistory, payouthistory, adminpayouthistory,
    canceltask, cancelcampaign, verifyuser,
    ping, stats, health, testurl, addbalance, removebalance,
    checksubmission, approvesubmission, reopenslot, mystatus, processholds, forcepayout,
    buildDigest(),
  ] as unknown as SlashCommandBuilder[];
}
