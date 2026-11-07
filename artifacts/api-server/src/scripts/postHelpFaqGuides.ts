import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_BOT_TOKEN);

  const guild = client.guilds.cache.get("1565314110621753495") || client.guilds.cache.first();
  if (!guild) throw new Error("Guild not found");
  const forum: any = await guild.channels.fetch("1568682213925593189");
  if (!forum) throw new Error("Forum channel not found");

  const guides = [
    {
      name: "🛡️ The Anti-Ban & Human Behavior Guide",
      embed: new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle("🛡️ The Anti-Ban & Human Behavior Guide")
        .setDescription(
          "Crucial tips from Skylerr & Staff on why Reddit removes comments, how to ensure your comments stick, and keeping your accounts safe from bans."
        )
        .addFields(
          {
            name: "[ 01 ] Do NOT Rush (Use Your 60 Minutes)",
            value:
              "• You are given **60 minutes (1 full hour)** to complete each task.\n" +
              "• Rushing to post immediately looks like a bot and gets your comment removed by Reddit.\n" +
              "• Take your time! Submitting in 2 minutes is the #1 reason comments get flagged."
          },
          {
            name: "[ 02 ] Pre-Engagement: Warm Up the Subreddit First",
            value:
              "• **Browse for 10 to 30 minutes:** Do not open the post and comment right away. Look around the subreddit first.\n" +
              "• **Post 1 or 2 normal comments:** Before posting your task, leave 1 or 2 casual, helpful comments on other unrelated threads.\n" +
              "• **Upvote & downvote:** Vote on a few posts naturally while browsing.\n" +
              "• Keep a natural gap between your browsing activity and posting your assigned comment."
          },
          {
            name: "[ 03 ] The Search Bar Method (No Direct Links)",
            value:
              "• Do **NOT** click direct Reddit links from Discord. Direct external referrals can trip Reddit spam filters.\n" +
              "• Instead, copy the post title, open Reddit in your browser or app, and use the Reddit search bar to find the post."
          },
          {
            name: "[ 04 ] Never Copy-Paste (Type It by Hand)",
            value:
              "• **Do NOT copy-paste:** Reddit AI instantly flags and deletes identical copy-pasted comments.\n" +
              "• **Type it out manually:** Always type your comment by hand.\n" +
              "• **Rephrase & tweak:** Change words slightly or add your personal casual tone, but keep the brand/product name spelled correctly."
          }
        )
        .setFooter({ text: "Community Guide • Anti-Ban Safety" })
        .setTimestamp()
    },
    {
      name: "💡 Beginner Roadmap: From Task Drop to Saturday Payout",
      embed: new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle("💡 Beginner Roadmap: From Task Drop to Saturday Payout")
        .setDescription(
          "A quick worker-to-worker walkthrough by Zuronium explaining how the entire earning cycle works."
        )
        .addFields(
          {
            name: "1️⃣ Task Drops in #tasks",
            value:
              "Tasks are dropped in <#1565661343737192531> throughout the day. Turn on notifications so you can catch drops early!"
          },
          {
            name: "2️⃣ Claiming & Private Workspace",
            value:
              "• Click **Claim Task** on an open task card (limit 1 active task at a time).\n" +
              "• The bot instantly creates your private ticket channel (`#work-yourusername`) under **Workspaces**.\n" +
              "• Inside, you get the target post details, instructions, and your countdown timer."
          },
          {
            name: "3️⃣ Execute with Warm-Up",
            value:
              "Warm up the subreddit first, write a genuine response that fits the conversation, and mention the requested brand naturally."
          },
          {
            name: "4️⃣ Submit Proof",
            value:
              "Click **Share → Copy Link** on your posted Reddit comment, return to your private workspace channel, click **Submit Proof**, and paste your link."
          },
          {
            name: "5️⃣ The 24-Hour Verification Hold",
            value:
              "Your comment must remain live for 24 hours to clear the hold. Once verified live, the reward automatically shifts into your **Available Balance**."
          },
          {
            name: "6️⃣ Saturday Payouts",
            value:
              "Payouts happen every Saturday via UPI, PayPal, GCash, or USDT directly to your configured payment address!"
          }
        )
        .setFooter({ text: "Community Guide • Workflow Walkthrough" })
        .setTimestamp()
    },
    {
      name: "⚡ Multi-Account Mastery: How to Skip Cooldowns",
      embed: new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle("⚡ Multi-Account Mastery: How to Skip Cooldowns")
        .setDescription(
          "Everything you need to know about our Multi-Account System and how to maximize your daily earnings (by Skylerr93)."
        )
        .addFields(
          {
            name: "🔄 Cooldowns are Per-Account (NOT Per-User)",
            value:
              "• When you submit a task with Account A, only Account A enters the cooldown period.\n" +
              "• If you have Account B or C linked: **You DO NOT have to wait**—you can claim your next task immediately using your other account!"
          },
          {
            name: "📈 Campaign Limits Scale With Your Accounts",
            value:
              "Your maximum tasks per campaign depend directly on how many Reddit accounts you have verified:\n" +
              "• **1 Linked Account ➔** Max 1 task per campaign\n" +
              "• **2 Linked Accounts ➔** Max 2 tasks per campaign\n" +
              "• **3 Linked Accounts ➔** Max 3 tasks per campaign (maximum allowed)"
          },
          {
            name: "🔗 How to Link Additional Accounts",
            value:
              "Run `/verify` in <#1565663449583980624> or your workspace channel anytime to link up to 3 verified Reddit accounts to your profile."
          }
        )
        .setFooter({ text: "Community Guide • Multi-Account Strategy" })
        .setTimestamp()
    },
    {
      name: "⚠️ What to Do If Your Comment Gets Removed",
      embed: new EmbedBuilder()
        .setColor(0xEB459E)
        .setTitle("⚠️ What to Do If Your Comment Gets Removed")
        .setDescription(
          "Understanding AutoMod removals, protecting your account health, and what NOT to do (by Mokaky & Staff)."
        )
        .addFields(
          {
            name: "🚫 Rule #1: NEVER Re-Post a Removed Comment",
            value:
              "• If Reddit AutoMod deletes your comment, **do NOT attempt to post the same comment again** on that thread.\n" +
              "• Retrying removed comments triggers aggressive spam detection and can get your Reddit account shadowbanned."
          },
          {
            name: "🔍 Why Removals Happen",
            value:
              "• The Reddit account is too new or lacks sufficient karma for that specific subreddit.\n" +
              "• Overly promotional language or copy-pasted phrasing.\n" +
              "• Posting within seconds of opening the thread without browsing first."
          },
          {
            name: "👀 Check Your Rejection Reason",
            value:
              "Check <#1565661351890784256> (`#rejected-tasks`) to see the automated liveness check logs and the reason for rejection."
          },
          {
            name: "🛡️ Protect Your Account Health",
            value:
              "Wait out the cooldown period, post a few normal organic comments across other subreddits, and claim a fresh task on a different thread later."
          }
        )
        .setFooter({ text: "Community Guide • Troubleshooting" })
        .setTimestamp()
    },
    {
      name: "💵 Payout Checklist: Don't Let Your Money Get Delayed",
      embed: new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("💵 Payout Checklist: Don't Let Your Money Get Delayed")
        .setDescription(
          "Make sure your payout details are configured so your earnings are released on schedule."
        )
        .addFields(
          {
            name: "⚠️ Don't Miss Payout Day",
            value:
              "In past batches, over 12 workers had delayed payments simply because they forgot to configure their payout method. Set it up once and you are all set!"
          },
          {
            name: "💳 Commands to Set Your Method",
            value:
              "• **UPI (India):** `/setupi upi_id:yourname@bank`\n" +
              "• **PayPal (Global):** `/setpaypal email:your@email.com`\n" +
              "• **GCash (Philippines):** `/setgcash number:09XXXXXXXXX`\n" +
              "• **Crypto (USDT):** `/setwallet coin:USDT address:0x... network:BEP20` *(Must be BEP-20 / BSC network!)*"
          },
          {
            name: "💼 Check Your Wallet Anytime",
            value:
              "Run `/wallet` in <#1565663449583980624> to check:\n" +
              "• **Available Balance:** Funds cleared and ready for payout.\n" +
              "• **Pending Balance:** Earnings undergoing the 24h verification hold.\n" +
              "• Completed payouts are posted publicly in <#1565661347914453034> (`#withdrawal-log`)."
          }
        )
        .setFooter({ text: "Community Guide • Payout Setup" })
        .setTimestamp()
    }
  ];

  console.log("Publishing guides to #help-and-faq forum...");
  for (const guide of guides) {
    const thread = await forum.threads.create({
      name: guide.name,
      message: {
        embeds: [guide.embed]
      }
    });
    console.log("Published thread:", thread.name, "ID:", thread.id);
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log("All 5 guides published successfully!");
  await client.destroy();
}

main().catch(console.error);
