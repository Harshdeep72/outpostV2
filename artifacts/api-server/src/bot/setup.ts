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
import { CHANNELS, CATEGORIES, ROLES, COLORS } from "./constants.js";
import { logger } from "../lib/logger.js";

export interface GuildSetup {
  adminRole: Role;
  modRole: Role;
  verifiedRole: Role;
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
}

const setupCache = new Map<string, { setup: GuildSetup; expiry: number }>();

async function ensureRole(guild: Guild, name: string, color: number): Promise<Role> {
  let role = guild.roles.cache.find((r) => r.name === name);
  if (!role) {
    role = await guild.roles.create({ name, color, reason: "Outpost Bot setup" });
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
      reason: "Outpost Bot bot setup",
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
  let ch = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name && c.parentId === parent.id
  ) as TextChannel | undefined;
  if (ch) return { channel: ch, created: false };
  ch = (await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent.id,
    permissionOverwrites,
    reason: "Outpost Bot bot setup",
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
        .setTitle("👋 Welcome to Outpost Bot!")
        .setDescription(
          "Outpost Bot is a **Reddit-based earning platform** powered by Discord.\n\n" +
          "Complete real tasks on Reddit and earn real money directly to your wallet."
        )
        .addFields(
          { name: "📌 How to Start", value: "1. Read `#guide` for the full setup guide\n2. Run `/verify` to link your Reddit account\n3. Browse `#tasks` and click **Claim Task**\n4. Submit your proof link after completing\n5. Get paid every Wednesday!" },
          { name: "🔗 Referral Program", value: "Run `/referral` to get your code.\nShare it with friends — earn **+$0.40** for each who verifies and completes a task." },
          { name: "💼 Your Wallet", value: "Run `/wallet` anytime to see your balance, trust score, and earnings." },
        )
        .setFooter({ text: "Outpost Bot Bot • Start earning today" })
        .setTimestamp(),
    ],
  });
}

async function postGuideContent(ch: TextChannel) {
  await ch.send({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.ACCENT)
        .setTitle("📖 Outpost Bot Earning Guide")
        .setDescription("Read this before claiming your first task.")
        .addFields(
          {
            name: "Step 1 — Verify Your Reddit Account",
            value: "Run `/verify` → click **Verify** → enter your Reddit username or profile link.\nA mod will check your account (karma, age) and approve you.\n\nRequirements vary per task — some tasks need higher trust scores.",
          },
          {
            name: "Step 2 — Claim a Task",
            value: "Go to `#tasks` and click **Claim Task** on any open task.\nYou can hold **1 active claim** at a time.\nThere is a **4-hour cooldown** between completing tasks (configurable by admins).",
          },
          {
            name: "Step 3 — Complete the Task",
            value: "Your personal workspace channel will be assigned with full task details.\nComplete the task on Reddit using your verified account.\nCopy the direct link to your post/comment.",
          },
          {
            name: "Step 4 — Submit Proof",
            value: "Click **Submit Proof** in your workspace and paste the Reddit link.\nThe bot checks it automatically:\n✅ If valid → auto-approved instantly\n⏳ If uncertain → sent to manual review",
          },
          {
            name: "Step 5 — Earn & Withdraw",
            value: "Accepted rewards go to **Pending Balance** first (hold period).\nThen move to **Available Balance**.\nPayouts happen **every Wednesday**.\nSet up your wallet with `/setupi` (UPI) or `/setwallet` (crypto / Binance Pay ID).",
          },
          {
            name: "🛡️ Trust Score",
            value: "+2 per accepted task | −3 per rejection | −10 per flag\nHigher trust = access to better tasks. Start at 100.",
          },
          {
            name: "⚠️ Rules",
            value: "• One Reddit account per Discord account\n• No fake or deleted proof links\n• No sharing tasks with others\n• Abuse = permanent flag + payout block",
          },
        )
        .setFooter({ text: "Outpost Bot Bot • Need help? Ask in #general" })
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
          "Whenever the Outpost team ships an update, the patch notes appear here automatically.\n" +
          "Keep an eye on this channel so you never miss a new task type, payout improvement, or anti-cheat upgrade."
        )
        .setFooter({ text: "Outpost Bot • Patch notes" })
        .setTimestamp(),
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
          "Earn by inviting your friends to Outpost Bot!\n\n" +
          "**How it works:**\n" +
          "1. Run `/referral` to get your unique code\n" +
          "2. Share it — your friend runs `/referraluse <code>`\n" +
          "3. They verify Reddit + complete 1 task\n" +
          "4. You get **+$0.40** added directly to your balance!\n\n" +
          "**No limit** on how many people you can refer.\n" +
          "Anti-abuse protection is active — fair rewards for real referrals only.\n\n" +
          "Bot announcements about referral milestones will appear here."
        )
        .setFooter({ text: "Outpost Bot Referral System" })
        .setTimestamp(),
    ],
  });
}

export async function setupGuild(guild: Guild): Promise<GuildSetup> {
  const cached = setupCache.get(guild.id);
  if (cached && cached.expiry > Date.now()) return cached.setup;

  await guild.roles.fetch();
  await guild.channels.fetch();

  const adminRole = await ensureRole(guild, ROLES.ADMIN, COLORS.DANGER);
  const modRole = await ensureRole(guild, ROLES.MOD, COLORS.WARNING);
  const verifiedRole = await ensureRole(guild, ROLES.VERIFIED, COLORS.SUCCESS);

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

  if (startCreated) postStartHereContent(startHereChannel).catch(() => {});
  if (guideCreated) postGuideContent(guideChannel).catch(() => {});
  if (refCreated) postReferralEventsContent(referralEventsChannel).catch(() => {});
  if (updatesCreated) postUpdatesIntro(updatesChannel).catch(() => {});

  const setup: GuildSetup = {
    adminRole, modRole, verifiedRole,
    communityCategory, earnCategory, workspacesCategory,
    tasksChannel, verificationLogChannel, taskLogsChannel, withdrawalLogChannel, leaderboardChannel,
    startHereChannel, guideChannel, generalChannel, referralEventsChannel, announcementsChannel,
    updatesChannel, rejectedTasksChannel,
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
    reason: "Outpost Bot: Workspaces category overflow (50-channel limit)",
  })) as CategoryChannel;
  return created;
}

export async function getOrCreateWorkspaceChannel(
  guild: Guild,
  member: GuildMember
): Promise<TextChannel> {
  await guild.channels.fetch();
  const { workspacesCategory, adminRole, modRole } = await setupGuild(guild);

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
