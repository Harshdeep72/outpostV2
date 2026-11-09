import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

async function main() {
  await client.login(process.env.DISCORD_BOT_TOKEN);
  console.log("Logged in as", client.user?.tag);

  // 1. Update instructions-for-you message 1567157208880513185
  console.log("Updating instructions-for-you message...");
  const instructionsChannel = await client.channels.fetch("1565314111372394581");
  if (instructionsChannel && instructionsChannel.isTextBased()) {
    const msg = await instructionsChannel.messages.fetch("1567157208880513185");
    const embed1 = new EmbedBuilder()
      .setTitle("TASK RULES & SAFETY INSTRUCTIONS (1-HOUR GUIDE)")
      .setDescription(
        "Please read these rules carefully before claiming tasks. Following this 1-hour pacing breakdown ensures your comments stay live, clients are satisfied, and your Reddit accounts stay safe from bans."
      )
      .setColor(0x5865f2)
      .addFields(
        {
          name: "[ 01 ] Task Limit & The 1-Hour Window",
          value:
            "• You can only claim **1 task at a time**.\n" +
            "• You are given **60 minutes (1 full hour)** to complete each task.\n" +
            "• Take your time! Rushing to comment in 2 minutes is the #1 reason Reddit flags and deletes comments.",
          inline: false,
        },
        {
          name: "⚠️ [ 02 ] Critical Rule: The Brand Name",
          value:
            "• **The brand name is what our clients are paying for — never remove or divert away from the brand!**\n" +
            "• The goal is always to recommend the brand as the solution to OP's question.\n" +
            "• The secret is simply *how* you deliver that recommendation so Reddit mods don't flag it as an ad.",
          inline: false,
        },
        {
          name: "⏱️ [ 03 ] Min 0–10: Find the Right \"Hook\" in OP’s Post",
          value:
            "• Read OP's post carefully: What specific problem or question are they asking about?\n" +
            "• Connect that exact problem to the brand you're assigned to recommend. When the brand directly answers OP’s question, it looks like a genuine peer recommendation, not an ad.\n" +
            "• Browse the thread naturally, upvote 1–2 other replies while browsing.",
          inline: false,
        },
        {
          name: "⏱️ [ 04 ] Min 10–25: Frame the Brand as Personal Experience",
          value:
            "❌ **Don't sound like a sales page:**\n" +
            "   *\"You must try [BrandName], it is the best and cheapest tool for XYZ!\"* ➔ Mods delete this instantly.\n" +
            "✅ **Frame it as a real user experience:**\n" +
            "   *\"I ran into this exact same problem a few weeks ago. I ended up trying [BrandName] and it handled [specific issue OP mentioned] really well for me.\"*\n" +
            "• The brand name is clearly recommended, but the tone is 100% natural, casual, and helpful.\n" +
            "• **Always type by hand:** Never copy-paste raw text.",
          inline: false,
        },
        {
          name: "⏱️ [ 05 ] Min 25–40: Post & Do the Incognito Check",
          value:
            "• Post your comment with the brand name clearly included.\n" +
            "• **Incognito Check:** Open your comment link in a **Private / Incognito window (logged out)**.\n" +
            "• If your comment shows up with the brand name intact, you’re golden!\n" +
            "• *(Tip: If Reddit ever filters it, 99% of the time it’s because of raw URLs or sales buzzwords like \"discount/buy/promo\" — stick to natural text mentioning the brand).*",
          inline: false,
        },
        {
          name: "⏱️ [ 06 ] Min 40–50: Submit to Discord",
          value:
            "• Tap **Share ➔ Copy Link** on your Reddit comment.\n" +
            "• Return to your private workspace channel on Discord and click **Submit Proof**.\n" +
            "• You are all done with time to spare! Earnings will enter the 24h verification hold.",
          inline: false,
        }
      )
      .setFooter({ text: "Reddit Microtasks • Rules & Safety Guide" });

    await msg.edit({ embeds: [embed1] });
    console.log("Successfully edited instructions-for-you message!");
  }

  // 2. Update #faq thread 1568680460618440786 ("📋 How to Claim & Complete Tasks (Step-by-Step)")
  console.log("Updating FAQ thread 1568680460618440786...");
  const faqThread = await client.channels.fetch("1568680460618440786");
  if (faqThread && faqThread.isTextBased()) {
    const starterMsg = await faqThread.messages.fetch("1568680460618440786");
    const faqEmbed = new EmbedBuilder()
      .setTitle("📋 Task Workflow Guide — From Claim to Submission (1-Hour Pacing)")
      .setDescription(
        "Follow this step-by-step 1-hour breakdown whenever you claim a task to ensure your comments stay live, pass verification, and get approved!"
      )
      .setColor(0xfee75c)
      .addFields(
        {
          name: "1️⃣ Claiming Your Task (Min 0)",
          value:
            "1. Go to <#1565661343737192531> where open tasks are posted.\n" +
            "2. Click the **Claim Task** button on any open card.\n" +
            "3. The bot generates your private workspace channel (`#work-yourusername`).\n" +
            "4. Inside your workspace, you will find the Reddit link, assigned brand/product, and your **60-minute claim timer**.",
          inline: false,
        },
        {
          name: "2️⃣ Min 0–10: Find OP’s Hook & Warm Up",
          value:
            "• Open the thread on Reddit. Read what OP is complaining about or asking for.\n" +
            "• Upvote 1–2 other helpful replies to establish natural user browsing behavior.\n" +
            "• Connect OP's exact problem to the brand you're assigned to recommend.",
          inline: false,
        },
        {
          name: "3️⃣ Min 10–25: Write the Comment (Personal Experience)",
          value:
            "⚠️ **Never remove or alter the Brand Name — that is what clients pay for!**\n" +
            "• **Frame as personal experience:** *\"I ran into this exact same problem a few weeks ago. I ended up trying [BrandName] and it handled [issue] really well for me.\"*\n" +
            "• **No sales pitch:** Avoid sales jargon, links, or discounts that trigger AutoMod.\n" +
            "• **Type by hand:** Never copy-paste directly.",
          inline: false,
        },
        {
          name: "4️⃣ Min 25–40: Post & Do the Incognito Check",
          value:
            "• Post your comment on the Reddit thread.\n" +
            "• **Check in Private / Incognito window:** Open the comment link while logged out.\n" +
            "• If it's visible with the brand name intact, your comment is 100% live and safe!",
          inline: false,
        },
        {
          name: "5️⃣ Min 40–50: Submit Proof in Discord",
          value:
            "1. On Reddit, tap **Share ➔ Copy Link** under your comment.\n" +
            "2. Return to your `#work-username` channel.\n" +
            "3. Click **Submit Proof** and paste your comment link.\n" +
            "4. Our system verifies liveness immediately and queues your payout!",
          inline: false,
        }
      )
      .setFooter({ text: "Reddit Microtasks FAQ • Claiming & Completion Guide" });

    await starterMsg.edit({ embeds: [faqEmbed] });
    console.log("Successfully edited FAQ starter message!");
  }

  // 3. Update #help-and-faq thread 1568683021572382801 ("🛡️ The Anti-Ban & Human Behavior Guide")
  console.log("Updating Anti-Ban guide 1568683021572382801...");
  const antiBanThread = await client.channels.fetch("1568683021572382801");
  if (antiBanThread && antiBanThread.isTextBased()) {
    const starterMsg = await antiBanThread.messages.fetch("1568683021572382801");
    const antiBanEmbed = new EmbedBuilder()
      .setTitle("🛡️ The Anti-Ban & Human Behavior Guide (1-Hour Master Breakdown)")
      .setDescription(
        "Crucial rules from Skylerr & Staff on keeping your comments live, keeping the brand front and center, and protecting your Reddit accounts from bans."
      )
      .setColor(0xed4245)
      .addFields(
        {
          name: "⚠️ Rule #0: The Brand Name Is Mandatory",
          value:
            "• The brand name is what our clients are paying for — **never remove, hide, or divert away from the brand**.\n" +
            "• The goal is always to recommend the brand as the solution. The trick is simply how you deliver that recommendation so mods don't view it as an ad.",
          inline: false,
        },
        {
          name: "⏱️ Min 0–10: Find OP’s Hook & Warm Up",
          value:
            "• **Do NOT rush:** Posting within 2 minutes is the fastest way to get flagged by Reddit AutoMod.\n" +
            "• Read OP's post carefully. Identify their exact pain point.\n" +
            "• Upvote 1–2 comments in the thread to show authentic human browsing activity.",
          inline: false,
        },
        {
          name: "⏱️ Min 10–25: Frame as Personal Experience",
          value:
            "❌ **Never sound like a salesperson:**\n" +
            "   *\"Try [BrandName], best and cheapest option with fast delivery!\"* ➔ Deleted instantly.\n" +
            "✅ **Frame as an authentic recommendation:**\n" +
            "   *\"I had the exact same issue last month. Tried [BrandName] and it resolved it smoothly for me.\"*\n" +
            "• **Always type by hand:** Never copy-paste. Keep the tone natural and conversational.",
          inline: false,
        },
        {
          name: "⏱️ Min 25–40: Post & The Incognito Check",
          value:
            "• Post your comment with the brand name clearly mentioned.\n" +
            "• Open the comment link in a **Private / Incognito tab (logged out)**.\n" +
            "• If it shows up while logged out, Reddit's spam filter accepted it!\n" +
            "• If it doesn't show, it was caught by AutoMod (usually due to raw links or promo words).",
          inline: false,
        },
        {
          name: "⏱️ Min 40–50: Submit Proof to Discord",
          value:
            "• Grab your comment permalink (**Share ➔ Copy Link**).\n" +
            "• Head to your private workspace channel and hit **Submit Proof** with plenty of time to spare!",
          inline: false,
        }
      )
      .setFooter({ text: "Community Guide • Anti-Ban Safety" });

    await starterMsg.edit({ embeds: [antiBanEmbed] });
    console.log("Successfully edited Anti-Ban guide!");
  }

  // 4. Update #help-and-faq thread 1568683043219312695 ("⚠️ What to Do If Your Comment Gets Removed")
  console.log("Updating Comment Removed guide 1568683043219312695...");
  const removedThread = await client.channels.fetch("1568683043219312695");
  if (removedThread && removedThread.isTextBased()) {
    const starterMsg = await removedThread.messages.fetch("1568683043219312695");
    const removedEmbed = new EmbedBuilder()
      .setTitle("⚠️ What to Do If Your Comment Gets Removed")
      .setDescription(
        "Understanding AutoMod removals, the Incognito check, and how to protect your account health (by Mokaky & Staff)."
      )
      .setColor(0xeb459e)
      .addFields(
        {
          name: "🚫 Rule #1: NEVER Re-Post a Removed Comment",
          value:
            "• If Reddit AutoMod deletes your comment, **do NOT re-post the same comment again** on that thread.\n" +
            "• Repeatedly posting deleted comments triggers Reddit's spam heuristics and can get your account shadowbanned.",
          inline: false,
        },
        {
          name: "🕵️ The Incognito Check: How to Know If You're Removed",
          value:
            "• Reddit often lets you see your own comment while logged in, but hides it from everyone else (shadow-removal).\n" +
            "• **Always check your comment in an Incognito / Private window (logged out)** between Min 25–40.\n" +
            "• If it doesn't show up in Incognito, it was filtered by AutoMod.",
          inline: false,
        },
        {
          name: "🔍 Why Removals Happen & How to Avoid Them",
          value:
            "1. **Rushing:** Posting in under 5 minutes without reading OP's post.\n" +
            "2. **Sales Tone:** Sounding like an advertisement instead of a peer sharing personal experience.\n" +
            "3. **Promo Keywords & Raw Links:** Including words like \"discount/deal/coupon\" or raw external URLs.\n" +
            "4. **Brand Missing:** Remember, **never remove the brand name** — keep the brand as the helpful solution, but wrap it in natural peer wording!",
          inline: false,
        },
        {
          name: "👀 Check Your Rejection Reason & Move Forward",
          value:
            "• Check <#1565661351890784256> (`#rejected-tasks`) to see automated liveness failure logs.\n" +
            "• Reject the task or let cooldown expire, do some casual browsing, and claim a fresh task on another thread later.",
          inline: false,
        }
      )
      .setFooter({ text: "Community Guide • Troubleshooting & Removals" });

    await starterMsg.edit({ embeds: [removedEmbed] });
    console.log("Successfully edited Comment Removed guide!");
  }

  // 5. Post Announcement in #announcements (1565314111372394580)
  console.log("Posting announcement in #announcements...");
  const announceChannel = await client.channels.fetch("1565314111372394580");
  if (announceChannel && announceChannel.isTextBased()) {
    const announceEmbed = new EmbedBuilder()
      .setTitle("📢 UPDATED GUIDELINES: How to Spend Your 1-Hour Task Window & Keep Comments Live!")
      .setDescription(
        "Hey everyone! 👋\n\n" +
        "We've updated our guidelines across the server to help everyone maximize approvals and keep your comments live permanently.\n\n" +
        "You have a **full 60-minute window** for each task. Rushing to post in 2–5 minutes is the #1 reason comments get deleted by Reddit AutoMod. Here is the exact strategy to follow:\n\n" +
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      )
      .setColor(0x5865f2)
      .addFields(
        {
          name: "⚠️ KEY MANDATORY RULE: The Brand Name",
          value:
            "• **The brand name is what our clients are paying for — never remove, alter, or divert away from the brand.**\n" +
            "• The goal is always to recommend the brand as the solution to OP's post. The secret is simply *how* you deliver that recommendation so Reddit mods don't flag it as an ad.",
          inline: false,
        },
        {
          name: "⏱️ Min 0–10: Find the Right \"Hook\" in OP’s Post",
          value:
            "• Read OP's post carefully: What specific problem or question are they asking for help with?\n" +
            "• Connect that exact problem to the brand you're assigned to recommend. When the brand directly answers OP’s question, it looks like a genuine peer recommendation, not an ad.\n" +
            "• Upvote 1–2 helpful replies to warm up naturally.",
          inline: false,
        },
        {
          name: "⏱️ Min 10–25: Frame the Brand as Personal Experience",
          value:
            "❌ **Don't sound like a sales page:**\n" +
            "   *\"You must try [BrandName], it is the best and cheapest tool for XYZ!\"* ➔ Mods delete this instantly.\n" +
            "✅ **Frame it as a real user experience:**\n" +
            "   *\"I ran into this exact same problem a few weeks ago. I ended up trying [BrandName] and it handled [specific issue OP mentioned] really well for me.\"*\n" +
            "• The brand name is clearly recommended, but the tone is 100% natural, casual, and helpful.\n" +
            "• **Always type by hand:** Never copy-paste raw text.",
          inline: false,
        },
        {
          name: "⏱️ Min 25–40: Post & Do the Incognito Check",
          value:
            "• Post your comment with the brand name clearly included.\n" +
            "• **Open the link in a Private / Incognito tab (logged out):**\n" +
            "• If your comment shows up with the brand name intact, you’re golden!\n" +
            "• *(Tip: If Reddit ever filters it, 99% of the time it’s because of raw links or buzzwords like \"discount/buy/promo\" — stick to natural text mentioning the brand).* ",
          inline: false,
        },
        {
          name: "⏱️ Min 40–50: Submit to Discord",
          value:
            "• Copy your comment permalink (**Share ➔ Copy Link**).\n" +
            "• Submit proof in your `#work-username` workspace channel, and you’re all done with time to spare!\n" +
            "• After 24h verification, your earnings unlock directly into your Available Balance for Saturday payout.",
          inline: false,
        }
      )
      .setFooter({ text: "Reddit Microtasks • Updated Guidelines" })
      .setTimestamp();

    await announceChannel.send({
      content: "@everyone",
      embeds: [announceEmbed],
    });
    console.log("Successfully posted announcement!");
  }

  await client.destroy();
  console.log("All done!");
}

main().catch((err) => {
  console.error("Error updating guidelines:", err);
  process.exit(1);
});
