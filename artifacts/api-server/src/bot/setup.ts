import {
  type Guild,
  type GuildMember,
  type CategoryChannel,
  type TextChannel,
  ChannelType,
  PermissionFlagsBits,
  type Role,
  EmbedBuilder,
} from "discord.js";
import {
  CHANNELS,
  CATEGORIES,
  ROLES,
  COLORS,
  REFERRAL_REWARD_REFERRER,
  REFERRAL_TIER1_REWARD,
  REFERRAL_TIER1_MIN_KARMA,
  REFERRAL_TIER1_MIN_AGE_DAYS,
  REFERRAL_TIER2_REWARD,
  REFERRAL_TIER2_MIN_KARMA,
  REFERRAL_TIER2_MIN_AGE_DAYS,
} from "./constants.js";
import { logger } from "../lib/logger.js";
import { ensureFlairRoles } from "./handlers/flair.js";

export interface GuildSetup {
  adminRole: Role;
  modRole: Role;
  verifiedRole: Role;
  unverifiedRole: Role;
  karma10kRole: Role;
  karma5kRole: Role;
  earnCategory: CategoryChannel;
  workspacesCategory: CategoryChannel;
  communityCategory: CategoryChannel;
  tasksChannel: TextChannel;
  verificationLogChannel: TextChannel;
  taskLogsChannel: TextChannel;
  withdrawalLogChannel: TextChannel;
  leaderboardChannel: TextChannel;
  startHereChannel: TextChannel;
  guideChannel: TextChannel;
  generalChannel: TextChannel;
  referralEventsChannel: TextChannel;
  announcementsChannel: TextChannel;
  updatesChannel: TextChannel;
  rejectedTasksChannel: TextChannel;
  scamAlertsChannel: TextChannel;
  suggestionsChannel?: TextChannel;
  vipChatChannel?: TextChannel;
  karmaTipsChannel?: TextChannel;
}

const setupCache = new Map<string, { setup: GuildSetup; expiry: number }>();

async function ensureRole(guild: Guild, name: string, color: number, hoist = false): Promise<Role> {
  let role = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!role && name.toLowerCase() === "mod") {
    role = guild.roles.cache.find((r) => r.name.toLowerCase() === "moderator");
  }
  if (!role && name.toLowerCase() === "admin") {
    role = guild.roles.cache.find((r) => r.name.toLowerCase() === "administrator");
  }
  if (!role) {
    role = await guild.roles.create({ name, color, hoist, mentionable: false, reason: "Reddit Microtasks setup" });
    // After creating a role, try to position it just below the bot's highest
    // role so the bot always has authority to assign it. This is best-effort —
    // if it fails (e.g. bot lacks MANAGE_ROLES or the position is already fine)
    // we swallow the error silently; the admin can reorder manually.
    try {
      const botMember = guild.members.me;
      if (botMember && botMember.roles.highest.position > 1) {
        const targetPos = botMember.roles.highest.position - 1;
        if (role.position < targetPos) {
          await role.setPosition(targetPos);
        }
      }
    } catch {
      // Ignore — hierarchy nudge is best-effort only
    }
  } else {
    if (hoist && !role.hoist) {
      await role.setHoist(true).catch(() => {});
    }
    if (role.mentionable) {
      await role.setMentionable(false, "Roles must not be mentionable by default").catch(() => {});
    }
  }
  return role;
}

async function ensureCategory(guild: Guild, name: string): Promise<CategoryChannel> {
  let cat = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name
  ) as CategoryChannel | undefined;
  if (!cat) {
    cat = (await guild.channels.create({
      name,
      type: ChannelType.GuildCategory,
      reason: "Reddit Microtasks bot setup",
    })) as CategoryChannel;
  }
  return cat;
}

async function ensureTextChannel(
  guild: Guild,
  name: string,
  parent: CategoryChannel,
  permissionOverwrites: any[] = []
): Promise<{ channel: TextChannel; created: boolean }> {
  // Reuse existing channel anywhere in guild (e.g. #announcements in Information, or #chitchat for #general)
  let ch = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && (c.name === name || (name === CHANNELS.GENERAL && c.name === "chitchat"))
  ) as TextChannel | undefined;
  if (ch) return { channel: ch, created: false };
  ch = (await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent.id,
    permissionOverwrites,
    reason: "Reddit Microtasks bot setup",
  })) as TextChannel;
  return { channel: ch, created: true };
}

function readOnlyOverwrites(everyoneId: string, adminId: string, modId: string) {
  return [
    { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
    { id: adminId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    { id: modId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
  ];
}

function modOnlyOverwrites(everyoneId: string, adminId: string, modId: string) {
  return [
    { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
    { id: adminId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    { id: modId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
  ];
}

async function postStartHereContent(ch: TextChannel) {
  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.PRIMARY)
        .setTitle("👋 Welcome to Reddit Microtasks!")
        .setDescription(
          "Reddit Microtasks is a **Reddit-based earning platform** powered by Discord.\n\n" +
          "Complete real tasks on Reddit and earn real money directly to your wallet."
        )
        .addFields(
          { name: "📌 How to Start", value: "1. Read `#guide` for the full setup guide\n2. Run `/verify` to link your Reddit account\n3. Browse `#tasks` and click **Claim Task**\n4. Submit your proof link after completing\n5. Get paid every Saturday!" },
          { name: "🛡️ Account Safety & Anti-Ban FAQ", value: "• **Alts Welcome:** You can link up to 3 Reddit accounts — feel free to use an alt rather than your personal main.\n• **Zero Passwords:** We never ask for Reddit passwords, emails, or sensitive tokens. Verification only checks public profile karma & age.\n• **Anti-Ban Protection:** Our 5–6 min pre-engagement guidelines and cooldowns are specifically engineered to keep your Reddit accounts completely safe." },
          { name: "🚨 Anti-Scam Advisory", value: "Staff will **NEVER** DM you asking for Reddit passwords, crypto deposits, or off-platform work. All tasks and payouts happen strictly inside this server. See `#scam-alerts` for full details." },
          { name: "🔗 Referral Program", value: `Run \`/referral\` to get your code.\nShare it with friends — earn **+$${REFERRAL_TIER1_REWARD}** (Tier 1: 300+ karma & 3+ mo) or **+$${REFERRAL_TIER2_REWARD}** (Tier 2: 150+ karma & 1+ mo) when they complete their first task and clear the 24hr live check.` },
          { name: "💼 Your Wallet", value: "Run `/wallet` anytime to see your balance, trust score, and earnings." },
        )
        .setFooter({ text: "Reddit Microtasks • Start earning today" })
        .setTimestamp(),
    ],
  });
}

async function postGuideContent(ch: TextChannel) {
  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.ACCENT)
        .setTitle("📖 Reddit Microtasks Earning Guide")
        .setDescription("Read this before claiming your first task.")
        .addFields(
          {
            name: "Step 1 — Verify Your Reddit Account",
            value: "Run `/verify` → click **Verify** → enter your Reddit username or profile link.\nA mod will check your account (karma, age) and approve you.\n\nRequirements vary per task — some tasks need higher trust scores.",
          },
          {
            name: "🛡️ Account Safety & Anti-Ban FAQ",
            value: "• **Is it safe?** Yes! Reddit Microtasks is built with account longevity in mind.\n• **Use Alts if Preferred:** You can link up to 3 Reddit accounts. You do **NOT** have to use your main account.\n• **Zero Credentials:** We never ask for passwords or private logins. Verification only checks public profile karma & age.\n• **Why the 5-6 Minute Rule?** Reddit filters flag rapid copy-paste comments. Taking 5-6 minutes to browse the post, upvote, and paraphrase ensures your comment sticks permanently and keeps your account in 100% good standing.",
          },
          {
            name: "Step 2 — Claim a Task",
            value: "Go to `#tasks` and click **Claim Task** on any open task.\nYou can hold **1 active claim** at a time.\nThere is a **4-hour cooldown** between completing tasks (configurable by admins).",
          },
          {
            name: "Step 3 — Complete the Task",
            value: "Your personal workspace channel will be assigned with full task details.\n" +
                   "• Complete the task on Reddit using your verified account.\n" +
                   "• **Do NOT copy-paste directly:** Reddit AI filters identical comments. Type manually & tweak words slightly while keeping the core motive and brand intact.\n" +
                   "• Surf the subreddit and blend in like a real human. You have a full 60-minute window!\n" +
                   "• Copy the direct share link to your comment.",
          },
          {
            name: "Step 4 — Submit Proof",
            value: "Click **Submit Proof** in your workspace and paste the Reddit link.\nThe bot checks it automatically:\n✅ If valid → auto-approved instantly\n⏳ If uncertain → sent to manual review",
          },
          {
            name: "Step 5 — Earn & Withdraw",
            value: "Accepted rewards go to **Pending Balance** first (hold period).\nThen move to **Available Balance**.\nPayouts happen **every Saturday**.\nSet up your payout details with `/setupi` (UPI) or `/setpaypal` (PayPal).",
          },
          {
            name: "🛡️ Trust Score",
            value: "+2 per accepted task | −3 per rejection | −10 per flag\nHigher trust = access to better tasks. Start at 100.",
          },
          {
            name: "🚨 Anti-Scam Security",
            value: "• **Zero Passwords:** We NEVER ask for Reddit passwords, 2FA codes, or logins.\n• **No DM Tasks:** All tasks happen exclusively in `#tasks` and your assigned `#work-*` channel.\n• **Zero Fees:** We will never ask you to pay any deposit or fee to withdraw your earnings.\n• **Impersonators:** Beware of users pretending to be admins/managers (e.g. \"Jason\"). Report suspicious DMs immediately in `#chitchat`.",
          },
          {
            name: "⚠️ Rules",
            value: "• One Reddit account per Discord account\n• No fake or deleted proof links\n• No sharing tasks with others\n• Abuse = permanent flag + payout block",
          },
        )
        .setFooter({ text: "Reddit Microtasks • Need help? Ask in #general" })
        .setTimestamp(),
    ],
  });
}

async function postUpdatesIntro(ch: TextChannel) {
  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.PRIMARY)
        .setTitle("📣 Bot Updates")
        .setDescription(
          "This is where bot **updates, fixes, and new features** will be announced.\n\n" +
          "Whenever the Reddit Microtasks team ships an update, the patch notes appear here automatically.\n" +
          "Keep an eye on this channel so you never miss a new task type, payout improvement, or anti-cheat upgrade."
        )
        .setFooter({ text: "Reddit Microtasks • Patch notes" })
        .setTimestamp(),
    ],
  });
}

export async function postScamAlertsContent(ch: TextChannel): Promise<void> {
  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.DANGER)
        .setTitle("🚨 OFFICIAL SECURITY ADVISORY: Beware of Impersonators & Direct Message Scams")
        .setDescription(
          "**Please read this carefully to protect your earnings, Reddit accounts, and personal security.**\n\n" +
          "Several members have reported receiving unsolicited Direct Messages (DMs) from individuals (such as impersonators going by **\"Jason\"** or claiming to be \"Outpost Admin / Task Manager\") offering off-platform tasks or requesting account access."
        )
        .addFields(
          {
            name: "🛑 1. Staff NEVER Ask for Reddit Passwords or Credentials",
            value:
              "Official staff and our automated bot will **NEVER** ask for your Reddit password, 2FA codes, account cookies, or login credentials. Verification only requires your public Reddit username/link.",
            inline: false,
          },
          {
            name: "🔒 2. ALL Tasks & Proofs Are Exclusively on Discord",
            value:
              "All genuine tasks are posted in `#tasks` and managed inside your private `#work-<username>` channel by our automated bot. **Never** accept tasks offered via private DMs or third-party links.",
            inline: false,
          },
          {
            name: "💸 3. Zero Fees or Deposits to Withdraw",
            value:
              "You will **NEVER** be asked to pay an \"activation fee\", \"verification deposit\", or \"crypto gas fee\" to receive your payouts. Payouts are 100% free and sent directly to your registered UPI / GCash / PayPal / BEP-20 wallet.",
            inline: false,
          },
          {
            name: "🛡️ What to Do If Someone DMs You",
            value:
              "• **Do NOT click external links or provide login details.**\n" +
              "• Take a screenshot of the DM and username.\n" +
              "• Report them immediately to an Admin/Mod or in `#chitchat`, then block them.",
            inline: false,
          }
        )
        .setFooter({ text: "Reddit Microtasks Official Security Bulletin" })
        .setTimestamp(new Date()),
    ],
  });
}

async function postReferralEventsContent(ch: TextChannel) {
  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle("🎉 Referral Program — Active")
        .setDescription(
          "Earn cash by inviting your friends to Reddit Microtasks!\n\n" +
          "**Tiered Rewards:**\n" +
          `• **Tier 1 (+$${REFERRAL_TIER1_REWARD}):** Reddit account with **${REFERRAL_TIER1_MIN_KARMA}+ karma** & **3+ months old**\n` +
          `• **Tier 2 (+$${REFERRAL_TIER2_REWARD}):** Reddit account with **${REFERRAL_TIER2_MIN_KARMA}+ karma** & **1+ month old**\n\n` +
          "**How it works:**\n" +
          "1. Run `/referral` to get your unique invite code\n" +
          "2. Share it — your friend applies it during `/verify` or via `/referraluse <code>`\n" +
          "3. They complete at least 1 task that passes the **24-hour verification hold** (live check)\n" +
          `4. You get **+$${REFERRAL_TIER1_REWARD}** or **+$${REFERRAL_TIER2_REWARD}** (based on tier) added directly to your available balance!\n\n` +
          "**No limit** on how many people you can refer.\n" +
          "Anti-abuse protection is active — fair rewards for real referrals only.\n\n" +
          "Bot announcements about referral milestones will appear here."
        )
        .setFooter({ text: "Reddit Microtasks Referral System" })
        .setTimestamp(),
    ],
  });
}

async function postVipChatIntro(ch: TextChannel) {
  const existing = await ch.messages.fetch({ limit: 10 }).catch(() => null);
  if (existing && existing.size > 0) return;

  const embed = new EmbedBuilder()
    .setColor(0xE67E22)
    .setTitle("👑 VIP Lounge & Priority Support")
    .setDescription(
      "Welcome to the exclusive **VIP Lounge**, reserved strictly for verified contributors with **5k+ Karma** and **10k+ Karma** accounts!\n\n" +
      "### ⚡ 50% Task Cooldown Benefit\n" +
      "Your task cooldown between submissions is automatically cut in half:\n" +
      "• **Standard Cooldown:** 120 minutes (2 hours)\n" +
      "• **5k+ & 10k+ VIP Cooldown:** **60 minutes (1 hour)**\n" +
      "*Enjoy claiming up to double the tasks throughout every campaign drop!*\n\n" +
      "### 🎫 Priority Support & Expedited Reviews\n" +
      "Need assistance with a task, verification, payout, or proof query?\n" +
      "• Drop a message directly in this channel or tag Mods/Admins.\n" +
      "• Questions posted in this VIP channel receive **first-priority attention** before general support queues.\n\n" +
      "### 💬 Elite Network\n" +
      "Feel free to connect, exchange strategies, and discuss high-converting subreddits with other elite contributors and server leadership."
    )
    .setFooter({ text: "Reddit Microtasks VIP Tier • Coded with care" })
    .setTimestamp();

  const msg = await ch.send({ embeds: [embed] }).catch(() => null);
  if (msg) {
    await msg.pin().catch(() => {});
    const fetched = await ch.messages.fetch({ limit: 5 }).catch(() => null);
    const pinNotice = fetched?.find((m) => m.type === 6);
    if (pinNotice) await pinNotice.delete().catch(() => {});
  }
}

async function postKarmaTipsIntro(ch: TextChannel) {
  const existing = await ch.messages.fetch({ limit: 10 }).catch(() => null);
  if (existing && existing.size > 0) return;

  const embed = new EmbedBuilder()
    .setColor(0x2ECC71)
    .setTitle("🌾 Reddit Karma Farming Tips & Strategies")
    .setDescription(
      "Welcome to **#karma-tips**! This channel is dedicated for members to share, discover, and discuss safe, effective strategies for growing Reddit karma and building high-trust accounts.\n\n" +
      "### ⚡ Why Higher Karma Matters in Reddit Microtasks\n" +
      "• **50% Shorter Task Cooldown:** Accounts with **5k+** and **10k+ Karma** enjoy a 60-minute task cooldown instead of 120 minutes — double your earning capacity!\n" +
      "• **VIP Lounge Access:** Exclusive access to `#vip-chat` with priority support from admins and mods.\n" +
      "• **Zero AutoMod Removals:** Higher-karma accounts bypass strict subreddit karma gates, keeping your submissions live and approved.\n\n" +
      "### 🛡️ Golden Rules for Safe Karma Growth (Anti-Ban)\n" +
      "1. **Target Rising Posts in Large Subreddits:** Browse `r/AskReddit`, `r/mildlyinteresting`, `r/aww`, `r/Showerthoughts`, `r/NoStupidQuestions`, or `r/me_irl` sorted by **Rising** or **New**. Leaving thoughtful, funny, or relatable comments early gives you the best chance of thousands of upvotes when the post trends.\n" +
      "2. **Helpful & Authentic Answers:** Niche subreddits (hobbies, gaming, tech, pets, local city subreddits) appreciate genuine help. A well-formatted, detailed guide or answer consistently gains steady upvotes.\n" +
      "3. **AVOID Free Karma Subreddits:** **NEVER** use `r/FreeKarma4U` or mutual-upvote exchange groups! Reddit's spam filter automatically flags and shadowbans accounts that participate in them.\n" +
      "4. **Human Pacing:** Do not mass-post comments in rapid succession. Blend in, upvote other posts, scroll naturally, and leave comfortable time between comments.\n\n" +
      "### 💬 Drop Your Tips Below!\n" +
      "Found an easy subreddit for building karma? Have a strategy that worked for you? Share your advice, ask questions, and help your fellow earners rank up!"
    )
    .setFooter({ text: "Reddit Microtasks Community • Help each other grow" })
    .setTimestamp();

  const msg = await ch.send({ embeds: [embed] }).catch(() => null);
  if (msg) {
    await msg.pin().catch(() => {});
    const fetched = await ch.messages.fetch({ limit: 5 }).catch(() => null);
    const pinNotice = fetched?.find((m) => m.type === 6);
    if (pinNotice) await pinNotice.delete().catch(() => {});
  }
}

export async function setupGuild(guild: Guild): Promise<GuildSetup> {
  const cached = setupCache.get(guild.id);
  if (cached && cached.expiry > Date.now()) return cached.setup;

  await guild.roles.fetch();
  await guild.channels.fetch();

  const adminRole = await ensureRole(guild, ROLES.ADMIN, COLORS.DANGER, true);
  const modRole = await ensureRole(guild, ROLES.MOD, COLORS.WARNING, true);
  const karma10kRole = await ensureRole(guild, ROLES.KARMA_10K, 0xE67E22, true);
  const karma5kRole = await ensureRole(guild, ROLES.KARMA_5K, 0x3498DB, true);
  const verifiedRole = await ensureRole(guild, ROLES.VERIFIED, COLORS.SUCCESS, true);
  const unverifiedRole = await ensureRole(guild, ROLES.UNVERIFIED, 0x95A5A6, true);
  void ensureFlairRoles(guild).catch((err) => logger.warn({ err }, "ensureFlairRoles failed"));

  const everyoneId = guild.roles.everyone.id;
  const adminId = adminRole.id;
  const modId = modRole.id;

  const communityCategory = await ensureCategory(guild, CATEGORIES.COMMUNITY);
  const earnCategory = await ensureCategory(guild, CATEGORIES.EARN);
  const workspacesCategory = await ensureCategory(guild, CATEGORIES.WORKSPACES);

  const { channel: announcementsChannel, created: annCreated } = await ensureTextChannel(
    guild, CHANNELS.ANNOUNCEMENTS, communityCategory,
    readOnlyOverwrites(everyoneId, adminId, modId)
  );

  const { channel: startHereChannel, created: startCreated } = await ensureTextChannel(
    guild, CHANNELS.START_HERE, communityCategory,
    readOnlyOverwrites(everyoneId, adminId, modId)
  );

  const { channel: guideChannel, created: guideCreated } = await ensureTextChannel(
    guild, CHANNELS.GUIDE, communityCategory,
    readOnlyOverwrites(everyoneId, adminId, modId)
  );

  const { channel: generalChannel } = await ensureTextChannel(
    guild, CHANNELS.GENERAL, communityCategory,
    [
      { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: adminId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
      { id: modId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
    ]
  );

  const { channel: referralEventsChannel, created: refCreated } = await ensureTextChannel(
    guild, CHANNELS.REFERRAL_EVENTS, communityCategory,
    readOnlyOverwrites(everyoneId, adminId, modId)
  );

  const { channel: updatesChannel, created: updatesCreated } = await ensureTextChannel(
    guild, CHANNELS.UPDATES, communityCategory,
    readOnlyOverwrites(everyoneId, adminId, modId)
  );

  const { channel: scamAlertsChannel, created: scamCreated } = await ensureTextChannel(
    guild, CHANNELS.SCAM_ALERTS, communityCategory,
    readOnlyOverwrites(everyoneId, adminId, modId)
  );

  const { channel: tasksChannel } = await ensureTextChannel(
    guild, CHANNELS.TASKS, earnCategory,
    [
      { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
      { id: adminId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: modId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    ]
  );

  const { channel: verificationLogChannel } = await ensureTextChannel(
    guild, CHANNELS.VERIFICATION_LOG, earnCategory, modOnlyOverwrites(everyoneId, adminId, modId)
  );
  const { channel: taskLogsChannel } = await ensureTextChannel(
    guild, CHANNELS.TASK_LOGS, earnCategory, modOnlyOverwrites(everyoneId, adminId, modId)
  );
  const { channel: withdrawalLogChannel } = await ensureTextChannel(
    guild, CHANNELS.WITHDRAWAL_LOG, earnCategory, modOnlyOverwrites(everyoneId, adminId, modId)
  );

  const { channel: leaderboardChannel } = await ensureTextChannel(
    guild, CHANNELS.LEADERBOARD, earnCategory,
    readOnlyOverwrites(everyoneId, adminId, modId)
  );

  // Mod-only audit log for tasks the claimer rejected (with reason). Lives
  // under the Earn category alongside other log channels.
  const { channel: rejectedTasksChannel } = await ensureTextChannel(
    guild, CHANNELS.REJECTED_TASKS, earnCategory, modOnlyOverwrites(everyoneId, adminId, modId)
  );

  const { channel: suggestionsChannel } = await ensureTextChannel(
    guild, CHANNELS.SUGGESTIONS, communityCategory
  );

  const { channel: vipChatChannel, created: vipCreated } = await ensureTextChannel(
    guild, CHANNELS.VIP_CHAT, communityCategory,
    [
      { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
      { id: karma5kRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.AddReactions] },
      { id: karma10kRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.AddReactions] },
      { id: adminId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages] },
      { id: modId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ManageMessages] },
    ]
  );

  const { channel: karmaTipsChannel, created: karmaCreated } = await ensureTextChannel(
    guild, CHANNELS.KARMA_TIPS, communityCategory,
    [
      {
        id: everyoneId,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: verifiedRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AddReactions,
        ],
      },
      {
        id: unverifiedRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AddReactions,
        ],
      },
      {
        id: adminId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.ManageMessages,
        ],
      },
      {
        id: modId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ]
  );

  if (startCreated) postStartHereContent(startHereChannel).catch(() => {});
  if (guideCreated) postGuideContent(guideChannel).catch(() => {});
  if (refCreated) postReferralEventsContent(referralEventsChannel).catch(() => {});
  if (updatesCreated) postUpdatesIntro(updatesChannel).catch(() => {});
  if (scamCreated) postScamAlertsContent(scamAlertsChannel).catch(() => {});
  if (vipCreated) postVipChatIntro(vipChatChannel).catch(() => {});
  postKarmaTipsIntro(karmaTipsChannel).catch(() => {});

  const setup: GuildSetup = {
    adminRole, modRole, verifiedRole, unverifiedRole, karma10kRole, karma5kRole,
    communityCategory, earnCategory, workspacesCategory,
    tasksChannel, verificationLogChannel, taskLogsChannel, withdrawalLogChannel, leaderboardChannel,
    startHereChannel, guideChannel, generalChannel, referralEventsChannel, announcementsChannel,
    updatesChannel, rejectedTasksChannel, scamAlertsChannel, suggestionsChannel, vipChatChannel,
    karmaTipsChannel,
  };

  setupCache.set(guild.id, { setup, expiry: Date.now() + 5 * 60 * 1000 });
  return setup;
}

export function invalidateSetupCache(guildId: string) {
  setupCache.delete(guildId);
}

// Discord caps each category at 50 child channels. When the "Workspaces"
// category fills up we transparently spill into "Workspaces 2", "Workspaces
// 3", and so on — creating the next overflow category on demand. The
// per-guild 500-channel limit still applies; if THAT is hit, channel.create
// will throw and the caller surfaces the real Discord error to the admin.
const DISCORD_CATEGORY_CAPACITY = 50;

function listWorkspacesCategories(guild: Guild): CategoryChannel[] {
  // Match the base name AND any numbered overflow ("Workspaces 2", "Workspaces 17").
  const re = new RegExp(`^${CATEGORIES.WORKSPACES}(?:\\s+(\\d+))?$`);
  const cats: { cat: CategoryChannel; idx: number }[] = [];
  for (const c of guild.channels.cache.values()) {
    if (c.type !== ChannelType.GuildCategory) continue;
    const m = c.name.match(re);
    if (!m) continue;
    cats.push({ cat: c as CategoryChannel, idx: m[1] ? parseInt(m[1]) : 1 });
  }
  cats.sort((a, b) => a.idx - b.idx);
  return cats.map((x) => x.cat);
}

function categoryChildCount(guild: Guild, categoryId: string): number {
  let n = 0;
  for (const c of guild.channels.cache.values()) {
    if (c.parentId === categoryId) n++;
  }
  return n;
}

async function findOrCreateAvailableWorkspacesCategory(
  guild: Guild,
  primary: CategoryChannel
): Promise<CategoryChannel> {
  // Always consider the primary first (cheapest path, no scan).
  if (categoryChildCount(guild, primary.id) < DISCORD_CATEGORY_CAPACITY) {
    return primary;
  }
  // Walk existing overflow categories in order.
  const all = listWorkspacesCategories(guild);
  for (const cat of all) {
    if (cat.id === primary.id) continue;
    if (categoryChildCount(guild, cat.id) < DISCORD_CATEGORY_CAPACITY) {
      return cat;
    }
  }
  // All known workspace categories are full. Create the next numbered one.
  // Numbering picks max(existing) + 1 so we never accidentally reuse.
  const re = new RegExp(`^${CATEGORIES.WORKSPACES}(?:\\s+(\\d+))?$`);
  let maxIdx = 1;
  for (const c of guild.channels.cache.values()) {
    if (c.type !== ChannelType.GuildCategory) continue;
    const m = c.name.match(re);
    if (!m) continue;
    const idx = m[1] ? parseInt(m[1]) : 1;
    if (idx > maxIdx) maxIdx = idx;
  }
  const newName = `${CATEGORIES.WORKSPACES} ${maxIdx + 1}`;
  const created = (await guild.channels.create({
    name: newName,
    type: ChannelType.GuildCategory,
    reason: "Reddit Microtasks: Workspaces category overflow (50-channel limit)",
  })) as CategoryChannel;
  return created;
}

export async function getOrCreateWorkspaceChannel(
  guild: Guild,
  member: GuildMember
): Promise<TextChannel> {
  await guild.channels.fetch();
  const { workspacesCategory, adminRole, modRole } = await setupGuild(guild);

  // Check if this member already has a recorded workspaceChannelId in the database
  try {
    const { getUserByDiscordId } = await import("./db.js");
    const userRow = await getUserByDiscordId(member.id);
    if (userRow?.workspaceChannelId) {
      const existingCh = guild.channels.cache.get(userRow.workspaceChannelId) as TextChannel | undefined;
      if (existingCh && existingCh.type === ChannelType.GuildText) {
        if (!existingCh.permissionOverwrites.cache.has(member.id)) {
          await existingCh.permissionOverwrites.edit(member.id, {
            ViewChannel: true,
            SendMessages: true,
            AttachFiles: true,
            EmbedLinks: true,
            ReadMessageHistory: true,
          }, { reason: `Restoring workspace permissions for ${member.user.username}` }).catch(() => {});
        }
        return existingCh;
      }
    }
  } catch (err) {
    logger.warn({ err, userId: member.id }, "getOrCreateWorkspaceChannel: failed checking db workspaceChannelId");
  }

  // Sanitise the Discord username for use as a channel name. Falls back to
  // "user" if the username contains zero alphanumerics so we never end up
  // with a degenerate "work-" name that would collide for every such user.
  const baseSlug = (member.user.username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)) || "user";
  const idSuffix = member.id.slice(-4);
  const safeName = `work-${baseSlug}`;
  const safeNameWithId = `work-${baseSlug}-${idSuffix}`;

  // Look for an existing channel for THIS member across ALL workspaces
  // categories (primary "Workspaces" + any "Workspaces N" overflow). We
  // accept either name pattern (legacy `work-<name>` or the newer
  // collision-proof `work-<name>-<id4>`) but ONLY if this member already
  // has an explicit permission overwrite on it — otherwise it belongs to
  // someone else whose username sanitised to the same string.
  const workspaceCategoryIds = new Set(listWorkspacesCategories(guild).map((c) => c.id));
  workspaceCategoryIds.add(workspacesCategory.id); // safety: always include primary
  const candidates = guild.channels.cache.filter(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.parentId !== null &&
      workspaceCategoryIds.has(c.parentId) &&
      (c.name === safeName || c.name === safeNameWithId)
  );

  for (const cand of candidates.values()) {
    const tc = cand as TextChannel;
    const overwrite = tc.permissionOverwrites.cache.get(member.id);
    if (overwrite) return tc;
  }

  // No channel for this specific member. Pick a name that won't collide
  // with another user's existing workspace (across all overflow categories).
  const nameTaken = guild.channels.cache.some(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.parentId !== null &&
      workspaceCategoryIds.has(c.parentId) &&
      c.name === safeName
  );
  const finalName = nameTaken ? safeNameWithId : safeName;

  // Pick a category that has room. Spills into "Workspaces 2", "Workspaces
  // 3", ... on demand when the primary (or earlier overflow) is full.
  const targetCategory = await findOrCreateAvailableWorkspacesCategory(guild, workspacesCategory);

  const ch = await guild.channels.create({
    name: finalName,
    type: ChannelType.GuildText,
    parent: targetCategory.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: modRole.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      {
        id: adminRole.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
    ],
    reason: `Workspace for ${member.user.username}`,
  });
  return ch as TextChannel;
}
