import {
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type Guild,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} from "discord.js";
import { eq, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { users, redditAccounts } from "@workspace/db";
import { sql } from "drizzle-orm";
import { parseRedditInput, fetchRedditProfile } from "../reddit.js";
import { setupGuild, getOrCreateWorkspaceChannel } from "../setup.js";
import { upsertUser, getUserByDiscordId } from "../db.js";
import { invalidateUser } from "../cache.js";
import { markReferralVerified } from "./referral.js";
import { makeEmbed, formatMoney, hasAdminRole, hasModRole } from "../util.js";
import { renderVerificationReviewCard } from "../card-renderer.js";
import { COLORS } from "../constants.js";
import { logger } from "../../lib/logger.js";
import { getMaxRedditAccounts } from "../../lib/settings.js";

const MIN_KARMA = 100;

/**
 * Wraps member.roles.add() with a clear diagnostic for DiscordAPIError[50013].
 * [50013] "Missing Permissions" on role assignment almost always means the
 * bot's highest role sits LOWER in the server hierarchy than the role it's
 * trying to assign. Fix: Server Settings → Roles → drag the bot's role
 * (outpostv2) above Verified/Mod/Admin.
 */
async function addRoleOrThrowClear(member: import("discord.js").GuildMember, role: import("discord.js").Role): Promise<void> {
  try {
    await member.roles.add(role);
  } catch (err: any) {
    if (err?.code === 50013) {
      throw new Error(
        `DiscordAPIError[50013]: Missing Permissions — the bot cannot assign the "${role.name}" role because the bot's role is below it in the server hierarchy.\n\n` +
        `**Fix:** Go to Server Settings → Roles → drag the **outpostv2** bot role above **${role.name}**, then have the user retry.`
      );
    }
    throw err;
  }
}
const MIN_AGE_DAYS = 30;
// Default — overridden at runtime by the DB setting (Settings → Max Reddit accounts).
const DEFAULT_MAX_REDDIT_ACCOUNTS = 3;

/**
 * Render a verification review card using the canvas renderer.
 * Shows account age (confirmed/failed), karma check instructions, and
 * a direct link to old.reddit.com so mods can verify karma at a glance.
 * Never throws — returns null on failure so the caller degrades gracefully.
 */
function buildReviewCard(
  discordUsername: string,
  redditUsername: string,
  accountAgeDays: number,
  oldestActivityUtc: number,
): Buffer | null {
  try {
    return renderVerificationReviewCard({
      discordUsername,
      redditUsername,
      accountAgeDays,
      minAgeDays: MIN_AGE_DAYS,
      minKarma: MIN_KARMA,
      oldestActivityUtc,
    });
  } catch (err) {
    logger.warn({ err, redditUsername }, "buildReviewCard: render failed");
    return null;
  }
}

async function countRedditAccounts(discordId: string): Promise<number> {
  const r = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM reddit_accounts WHERE discord_id = ${discordId}`
  );
  return parseInt(r.rows[0]?.count ?? "0");
}

function maxedOutEmbed(linked: string[], limit: number = DEFAULT_MAX_REDDIT_ACCOUNTS) {
  const list = linked.length > 0 ? linked.map((u) => `• u/${u}`).join("\n") : "(none on file)";
  return makeEmbed(COLORS.WARNING)
    .setTitle(`✅ You've Linked the Maximum (${limit}) Reddit Accounts`)
    .setDescription(
      `You already have ${limit} Reddit accounts linked:\n\n${list}\n\n` +
      `Submit proofs from any of them. To swap one out, ask an admin to revoke an account.`
    );
}

async function fetchLinkedRedditUsernames(discordId: string): Promise<string[]> {
  const r = await db.execute<{ reddit_username: string }>(
    sql`SELECT reddit_username FROM reddit_accounts WHERE discord_id = ${discordId} ORDER BY created_at ASC`
  );
  return r.rows.map((row) => row.reddit_username).filter(Boolean);
}

export async function handleVerifyCommand(interaction: ChatInputCommandInteraction) {
  // Admin/mod posts a PUBLIC verification panel that any member can click.
  // Each click runs an ephemeral verify flow for the clicker — admin's panel
  // stays visible to the whole channel.
  const guild = interaction.guild!;
  const member = interaction.member;
  if (!member || typeof member === "string" || !("roles" in member) || !hasModRole(member as any, guild)) {
    return interaction.reply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can post the verification panel.")], flags: 64 });
  }

  await interaction.deferReply();

  const embed = makeEmbed(COLORS.PRIMARY)
    .setTitle("🔗 Reddit Verification")
    .setDescription(
      "Welcome! To earn on this server you need to link your Reddit account.\n\n" +
      "**Click the button below to start.** Your verification is private — only you will see your modal and result.\n\n" +
      "**Requirements:** ≥100 karma, ≥30 days old account.\n" +
      "Already verified? Clicking again will tell you so — nothing breaks."
    )
    .setFooter({ text: `Posted by ${interaction.user.username}` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("verify:start")
      .setLabel("✅ Verify Me")
      .setStyle(ButtonStyle.Primary)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

export async function handleVerifyStart(interaction: ButtonInteraction) {
  // showModal() MUST be the very first response — no DB calls before it.
  // The already-verified check is handled in handleVerifyModal after deferReply.
  // Note: this button lives on a PUBLIC panel posted by an admin via /verify.
  // Each clicker gets their own ephemeral modal + reply.
  const modal = new ModalBuilder()
    .setCustomId("verify:modal")
    .setTitle("Reddit Verification");

  const input = new TextInputBuilder()
    .setCustomId("reddit_input")
    .setLabel("Reddit username or profile link")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(300);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

export async function handleVerifyModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: 64 });
  try {
    await handleVerifyModalInner(interaction);
  } catch (err) {
    // SAFETY NET: never leave the user stuck on "🔍 Checking u/..." with no
    // resolution. If ANY step throws after deferReply (Discord rate limit,
    // workspace channel create failure, role add failure, log channel send
    // failure, DB hiccup), we always:
    //   1. editReply with an error embed so the user knows it failed
    //   2. post a crash entry to verification-logs so admins can investigate
    // Without this, the previous bug was: DB commits verified=true at the
    // top of the success path, then a downstream Discord call throws, the
    // user sees the loading spinner forever, and on retry hits the
    // "already verified" short-circuit with no trace in logs.
    logger.error({ err, discordId: interaction.user.id }, "Verify modal crashed");
    try {
      await interaction.editReply({
        embeds: [makeEmbed(COLORS.DANGER)
          .setTitle("⚠️ Verification Hit an Error")
          .setDescription(
            "Something went wrong while finalizing your verification. " +
            "Your Reddit username may have already been saved — please **wait 30 seconds**, then click **Verify Me** again to check your status.\n\n" +
            "If you still see this error, ping an admin in the verification channel."
          )],
      });
    } catch (replyErr) {
      logger.error({ err: replyErr, discordId: interaction.user.id }, "Verify modal: failed to editReply error fallback");
    }
    try {
      const guild = interaction.guild;
      if (guild) {
        const { verificationLogChannel } = await setupGuild(guild);
        const crashMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        await verificationLogChannel.send({
          embeds: [makeEmbed(COLORS.DANGER)
            .setTitle("🚨 Verification Crashed — Manual Check Needed")
            .addFields(
              { name: "Discord User", value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: false },
              { name: "Error", value: `\`\`\`${crashMsg.slice(0, 900)}\`\`\`` },
            )
            .setFooter({ text: "Check Render logs + DB to see if verification partially committed" })],
        });
      }
    } catch (logErr) {
      logger.error({ err: logErr, discordId: interaction.user.id }, "Verify modal: failed to post crash log to verification channel");
    }
  }
}

async function handleVerifyModalInner(interaction: ModalSubmitInteraction) {
  const existing = await getUserByDiscordId(interaction.user.id);
  // Multi-Reddit-account: instead of refusing already-verified users, allow
  // them to link additional Reddit accounts up to MAX_REDDIT_ACCOUNTS_PER_USER.
  // `isAdditional` controls whether we run the full first-time verification
  // setup (workspace/role) or just append to reddit_accounts.
  const existingCount = existing?.verified ? await countRedditAccounts(interaction.user.id) : 0;
  const isAdditional = !!existing?.verified;
  const maxAccounts = await getMaxRedditAccounts().catch(() => DEFAULT_MAX_REDDIT_ACCOUNTS);
  if (isAdditional && existingCount >= maxAccounts) {
    const linked = await fetchLinkedRedditUsernames(interaction.user.id);
    return interaction.editReply({ embeds: [maxedOutEmbed(linked, maxAccounts)] });
  }

  const raw = interaction.fields.getTextInputValue("reddit_input");
  const parsed = parseRedditInput(raw);
  if (!parsed) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Invalid Reddit username format. Please enter a valid username (3-20 characters, letters/numbers/underscores/hyphens).")],
    });
  }

  const guild = interaction.guild!;
  const discordId = interaction.user.id;
  const discordUsername = interaction.user.username;
  const nameLower = parsed.toLowerCase();

  // ANTI-ALT: a Reddit account can only be linked to ONE Discord ID, ever.
  // Check BOTH users.reddit_username (legacy primary slot) AND reddit_accounts
  // (multi-account table). Either match owned by a different Discord user
  // means the username is taken.
  // PERF: these two queries are independent — fire them in parallel so we
  // pay one DB round-trip instead of two. Same logic as the previous
  // sequential awaits below; only the wait is shared.
  const [dupCheck, dupCheckMulti] = await Promise.all([
    db.select().from(users)
      .where(eq(users.redditUsername, nameLower))
      .limit(1),
    db.execute<{ discord_id: string }>(
      sql`SELECT discord_id FROM reddit_accounts WHERE reddit_username = ${nameLower} LIMIT 1`
    ),
  ]);

  const ownedByOther =
    (dupCheck.length > 0 && dupCheck[0]!.discordId !== discordId) ||
    (dupCheckMulti.rows.length > 0 && dupCheckMulti.rows[0]!.discord_id !== discordId);

  if (ownedByOther) {
    logger.warn({ discordId, attempted: nameLower }, "Anti-alt: reddit account already linked to another discord id");
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(
        `❌ Reddit account **u/${parsed}** is already linked to another Discord account.\n\nOne Reddit account can only be tied to one Discord user. If this is a mistake, ask an admin to revoke the existing link.`
      )],
    });
  }

  // If the user has ALREADY linked this exact username (their own), short-circuit.
  // But ONLY if the account is truly linked in reddit_accounts — not just a
  // stale redditUsername left from a pending/rejected verification.
  if (isAdditional) {
    const ownedBySelf = dupCheckMulti.rows.length > 0 && dupCheckMulti.rows[0]!.discord_id === discordId;
    if (ownedBySelf) {
      return interaction.editReply({
        embeds: [makeEmbed(COLORS.WARNING).setDescription(
          `ℹ️ You've already linked **u/${parsed}** to your Discord account. No action needed.`
        )],
      });
    }
    // primary slot match on users.reddit_username only counts if it's ALSO in reddit_accounts
    // (legacy row) — otherwise it might be a stale pending entry, let them re-verify.
    const primaryLinked = (existing?.redditUsername ?? "").toLowerCase() === nameLower && ownedBySelf;
    if (primaryLinked) {
      return interaction.editReply({
        embeds: [makeEmbed(COLORS.WARNING).setDescription(
          `ℹ️ You've already linked **u/${parsed}** to your Discord account. No action needed.`
        )],
      });
    }
  }

  await upsertUser(discordId, discordUsername);

  // Show what we're actually doing — the username being checked + the
  // exact gates we're about to run. Pure cosmetic; no behavior change.
  await interaction.editReply({
    embeds: [
      makeEmbed(COLORS.PRIMARY)
        .setTitle(`🔍 Checking u/${parsed}`)
        .setDescription(
          `Fetching your Reddit profile and running these checks:\n\n` +
          `• Karma ≥ **${MIN_KARMA.toLocaleString()}**\n` +
          `• Account age ≥ **${MIN_AGE_DAYS}** days\n` +
          `• Not already linked to another Discord user\n\n` +
          `_This usually takes a few seconds…_`
        ),
    ],
  });

  // NOTE: previously tried Promise.all([fetchRedditProfile, setupGuild]) for
  // speed, but a thrown error inside setupGuild could leave the modal hung
  // on the loading screen. Reverted to the original sequential order — safe
  // and identical to the long-stable behavior. The dupCheck parallelization
  // above is kept (those are pure DB SELECTs, can't throw catastrophically).
  const result = await fetchRedditProfile(parsed);
  const { verificationLogChannel } = await setupGuild(guild);

  if (result.ok) {
    const p = result.profile;
    const karmaOk = p.karmaVerified && p.totalKarma >= MIN_KARMA;
    const ageOk = p.accountAgeDays >= MIN_AGE_DAYS;

    // If we couldn't verify karma (RSS fallback — JSON API blocked), we don't
    // know if they meet the ≥100 karma requirement. Queue for manual review
    // rather than blindly auto-verifying a potentially low-karma account.
    if (!p.karmaVerified) {
      // Render a review card image so mods see all the info at a glance.
      const cardBuf = buildReviewCard(discordUsername, p.name, p.accountAgeDays, p.createdUtc);
      const cardFile = cardBuf
        ? new AttachmentBuilder(cardBuf, { name: `verify-${p.name}.png` })
        : null;

      // Show karma floor if we have archived data (totalKarma > 0 means Arctic Shift gave us a floor)
      const hasKarmaFloor = p.totalKarma > 0;
      const karmaFloorLine = hasKarmaFloor
        ? `Archived score floor: **${p.totalKarma.toLocaleString()}** (actual karma is ≥ this — verify on Reddit).\n\n`
        : ``;
      const reasonLine = hasKarmaFloor
        ? `Archived karma floor is below the ${MIN_KARMA} threshold — actual karma may be higher.`
        : `Reddit's karma API is blocked from the server IP — karma could not be fetched automatically.`;

      const networkEmbed = makeEmbed(COLORS.WARNING)
        .setTitle("📋 Verification Request — Manual Karma Check Required")
        .setDescription(
          `${reasonLine}\n\n` +
          `**[u/${p.name}](https://old.reddit.com/user/${p.name})** — ${p.accountAgeDays} days old account.\n\n` +
          `${karmaFloorLine}` +
          `Open **[their profile](https://old.reddit.com/user/${p.name})** to check karma, then click Accept or Reject.`
        )
        .addFields(
          { name: "Discord User", value: `<@${discordId}> (${discordUsername})`, inline: true },
          { name: "Reddit Profile", value: `[u/${p.name}](https://old.reddit.com/user/${p.name})`, inline: true },
          { name: "Account Age", value: `${p.accountAgeDays} days`, inline: true },
          ...(hasKarmaFloor ? [{ name: "Karma Floor (Archive)", value: `≥ ${p.totalKarma.toLocaleString()}`, inline: true }] : []),
        )
        .setFooter({ text: `Requires ≥${MIN_KARMA} karma  ·  ≥${MIN_AGE_DAYS} days old` });

      if (cardFile) {
        networkEmbed.setImage(`attachment://verify-${p.name}.png`);
      }

      // Don't write redditUsername to users here — that would create a
      // phantom link that blocks the user from retrying if the mod rejects.
      // The username travels in the Accept button's customId instead.
      invalidateUser(discordId);

      const manualRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`verify:accept:${discordId}:${nameLower}`)
          .setLabel("✅ Accept (karma OK)")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`verify:reject:${discordId}`)
          .setLabel("❌ Reject")
          .setStyle(ButtonStyle.Danger),
      );

      await verificationLogChannel.send({
        embeds: [networkEmbed],
        components: [manualRow],
        ...(cardFile ? { files: [cardFile] } : {}),
      });
      await interaction.editReply({
        embeds: [makeEmbed(COLORS.WARNING).setDescription(
          `⏳ Your karma could not be automatically verified. A moderator will check and verify you shortly.\n\n` +
          `Your account **u/${p.name}** (${p.accountAgeDays} days old) has been submitted for review.` +
          (hasKarmaFloor ? `\n\nArchived karma floor: **${p.totalKarma.toLocaleString()}** (actual karma ≥ this).` : "")
        )],
      });
      logger.info({ discordId, parsed, ageDays: p.accountAgeDays, hasCard: !!cardFile, karmaFloor: p.totalKarma }, "Verification queued — karma unverifiable, review card attached");
      return;
    }

    if (!karmaOk || !ageOk) {
      const reasons: string[] = [];
      if (!karmaOk) reasons.push(`❌ Karma too low: **${p.totalKarma.toLocaleString()}** / ${MIN_KARMA} required`);
      if (!ageOk) reasons.push(`❌ Account too new: **${p.accountAgeDays}** / ${MIN_AGE_DAYS} days required`);

      const karmaDisplay = p.karmaVerified ? p.totalKarma.toLocaleString() : "N/A (API blocked)";
      const postKarmaDisplay = p.karmaVerified ? p.linkKarma.toLocaleString() : "N/A";
      const commentKarmaDisplay = p.karmaVerified ? p.commentKarma.toLocaleString() : "N/A";

      const failEmbed = makeEmbed(COLORS.DANGER)
        .setTitle("Verification Failed")
        .setThumbnail(p.iconImg ?? null)
        .setDescription(
          `Your Reddit account **u/${p.name}** doesn't meet the minimum requirements:\n\n${reasons.join("\n")}\n\nGrow your Reddit account and try again.`
        )
        .addFields(
          { name: "Post Karma", value: postKarmaDisplay, inline: true },
          { name: "Comment Karma", value: commentKarmaDisplay, inline: true },
          { name: "Account Age", value: `${p.accountAgeDays} days`, inline: true },
        );

      const logEmbed = makeEmbed(COLORS.DANGER)
        .setTitle("⛔ Verification Failed — Auto Rejected")
        .addFields(
          { name: "Discord User", value: `<@${discordId}> (${discordUsername})`, inline: true },
          { name: "Reddit Account", value: `u/${p.name}`, inline: true },
          { name: "Account Age", value: `${p.accountAgeDays} days`, inline: true },
          { name: "Post Karma", value: postKarmaDisplay, inline: true },
          { name: "Comment Karma", value: commentKarmaDisplay, inline: true },
          { name: "Total Karma", value: karmaDisplay, inline: true },
          { name: "Reason", value: reasons.join("\n") },
        )
        .setFooter({ text: "Click 'Accept Anyway' to override and verify manually" });

      // Include the attempted Reddit username in the customId — without
      // it, handleVerifyAccept has no idea WHICH account to link (the
      // user might be already-verified with a different primary, in which
      // case "Accept Anyway" must add this as an ADDITIONAL reddit_accounts
      // row, not just toggle the verified flag).
      const overrideRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`verify:accept:${discordId}:${nameLower}`)
          .setLabel("Accept Anyway")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`verify:dismiss:${discordId}`)
          .setLabel("Dismiss")
          .setStyle(ButtonStyle.Secondary),
      );

      await verificationLogChannel.send({ embeds: [logEmbed], components: [overrideRow] });
      await interaction.editReply({ embeds: [failEmbed] });
      logger.info({ discordId, parsed, karma: p.totalKarma, age: p.accountAgeDays }, "Verification auto-rejected: failed criteria");
      return;
    }

    // ----- Multi-Reddit-account: ADDITIONAL account fast path -----
    // ONLY runs when the user is ALREADY verified (per cached state).
    // First-time users (isAdditional=false) skip this entire block and fall
    // through to the normal first-time verification path below.
    //
    // RACE-SAFE COMMIT: wrap the cap-check + insert in a single transaction
    // that locks the user row (SELECT ... FOR UPDATE) so two concurrent
    // verify modals from the same Discord user can't BOTH pass the pre-check
    // and insert past the 3-account limit. Also re-checks `users.verified`
    // at commit time — if an admin revoked the user mid-flow, we FALL THROUGH
    // to the normal verification path which re-verifies them.
    if (isAdditional) {
      type AdditionalOutcome = "ok" | "max" | "revoked" | "duplicate" | "race";
      const outcome: { value: AdditionalOutcome } = { value: "ok" };
      try {
        await db.transaction(async (tx) => {
          const userLockRes = await tx.execute<{ verified: boolean }>(
            sql`SELECT verified FROM users WHERE discord_id = ${discordId} FOR UPDATE`
          );
          if (userLockRes.rows.length === 0 || !userLockRes.rows[0]!.verified) {
            outcome.value = "revoked";
            return;
          }
          const countRes = await tx.execute<{ count: string }>(
            sql`SELECT COUNT(*)::text AS count FROM reddit_accounts WHERE discord_id = ${discordId}`
          );
          const currentCount = parseInt(countRes.rows[0]?.count ?? "0");
          const maxAcc = await getMaxRedditAccounts().catch(() => DEFAULT_MAX_REDDIT_ACCOUNTS);
          if (currentCount >= maxAcc) {
            outcome.value = "max";
            return;
          }
          const dupRes = await tx.execute<{ discord_id: string }>(
            sql`SELECT discord_id FROM reddit_accounts WHERE reddit_username = ${nameLower} LIMIT 1`
          );
          if (dupRes.rows.length > 0) {
            outcome.value = dupRes.rows[0]!.discord_id === discordId ? "duplicate" : "race";
            return;
          }
          await tx.insert(redditAccounts).values({
            discordId,
            redditUsername: nameLower,
            accountAgeDays: p.accountAgeDays,
            postKarma: p.linkKarma,
            commentKarma: p.commentKarma,
          });
        });
      } catch (err) {
        logger.warn({ err, discordId, nameLower }, "reddit_accounts insert tx failed");
        outcome.value = "race";
      }

      if (outcome.value === "revoked") {
        // Cache said verified=true but DB says verified=false. Either an admin
        // unverified mid-flow, or the cache went stale. Clear cache and FALL
        // THROUGH to the normal first-time verification path below — it will
        // re-verify them AND link this Reddit account in one shot.
        invalidateUser(discordId);
        logger.info({ discordId, nameLower }, "Additional path saw revoked → falling through to first-time verify");
        // (no return — fall through)
      } else if (outcome.value === "max") {
        const linked = await fetchLinkedRedditUsernames(discordId);
        return interaction.editReply({ embeds: [maxedOutEmbed(linked)] });
      } else if (outcome.value === "duplicate") {
        return interaction.editReply({
          embeds: [makeEmbed(COLORS.WARNING).setDescription(
            `ℹ️ You've already linked **u/${p.name}** to your Discord account. No action needed.`
          )],
        });
      } else if (outcome.value === "race") {
        return interaction.editReply({
          embeds: [makeEmbed(COLORS.DANGER).setDescription(
            `❌ Could not link **u/${p.name}** — it was just claimed by another Discord user.`
          )],
        });
      } else {
        // outcome.value === "ok" — additional account added successfully.
        const linked = await fetchLinkedRedditUsernames(discordId);
        const maxAcc2 = await getMaxRedditAccounts().catch(() => DEFAULT_MAX_REDDIT_ACCOUNTS);
        const remaining = maxAcc2 - linked.length;

        const addEmbed = makeEmbed(COLORS.SUCCESS)
          .setTitle("✅ Reddit Account Linked")
          .setThumbnail(p.iconImg ?? null)
          .setDescription(
            `**u/${p.name}** is now linked to your Discord account.\n\n` +
            `You can submit task proofs from any of your linked accounts.\n\n` +
            `**Linked accounts (${linked.length}/${maxAcc2}):**\n${linked.map((u) => `• u/${u}`).join("\n")}` +
            (remaining > 0 ? `\n\nYou can link **${remaining}** more account${remaining === 1 ? "" : "s"}.` : "")
          )
          .addFields(
            { name: "Account Age", value: `${p.accountAgeDays} days`, inline: true },
            { name: "Post Karma", value: p.linkKarma.toLocaleString(), inline: true },
            { name: "Comment Karma", value: p.commentKarma.toLocaleString(), inline: true },
          );

        const logEmbedAdd = makeEmbed(COLORS.SUCCESS)
          .setTitle("➕ Additional Reddit Account Linked")
          .setThumbnail(p.iconImg ?? null)
          .addFields(
            { name: "Discord User", value: `<@${discordId}> (${discordUsername})`, inline: true },
            { name: "New Reddit Account", value: `u/${p.name}`, inline: true },
            { name: "Total Linked", value: `${linked.length}/${maxAcc2}`, inline: true },
            { name: "Account Age", value: `${p.accountAgeDays} days`, inline: true },
            { name: "Post Karma", value: p.linkKarma.toLocaleString(), inline: true },
            { name: "Comment Karma", value: p.commentKarma.toLocaleString(), inline: true },
          )
          .setFooter({ text: "Take action below if this account looks suspicious." });

        // "Take Action" row on the additional-account log — admins/mods can
        // unlink the account in one click (e.g. it's an alt / low-effort
        // farmer / bought account). The View Profile button is a URL link
        // so anyone in the log channel can quickly QC the Reddit history.
        const addActionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`verify:unlinkacc:${discordId}:${nameLower}`)
            .setLabel("🗑️ Unlink Account")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setLabel("🔗 View Profile")
            .setStyle(ButtonStyle.Link)
            .setURL(`https://www.reddit.com/user/${encodeURIComponent(p.name)}`),
        );
        await verificationLogChannel.send({ embeds: [logEmbedAdd], components: [addActionRow] });

        // Notify the user in their own workspace channel so they get a
        // visible "this account is now linked" trail (not just the
        // ephemeral modal reply, which disappears the moment they close it).
        // Best-effort — if workspace channel is gone we just skip.
        if (existing?.workspaceChannelId) {
          try {
            const ws = await guild.channels.fetch(existing.workspaceChannelId);
            if (ws && ws.isTextBased() && "send" in ws) {
              await (ws as any).send({
                content: `<@${discordId}>`,
                embeds: [
                  makeEmbed(COLORS.SUCCESS)
                    .setTitle("✅ Additional Reddit account linked")
                    .setDescription(
                      `Your Reddit account **u/${p.name}** is now linked to this Discord.\n\n` +
                      `You can submit task proofs from any of your linked accounts:\n${linked.map((u) => `• u/${u}`).join("\n")}`
                    ),
                ],
              });
            }
          } catch (err) {
            logger.warn({ err, discordId }, "Could not post additional-account notice to workspace channel");
          }
        }

        await interaction.editReply({ embeds: [addEmbed] });
        logger.info({ discordId, parsed, total: linked.length }, "Additional Reddit account linked");
        return;
      }
    }
    // ----- end additional-account path -----

    const member = await guild.members.fetch(discordId);
    const { verifiedRole } = await setupGuild(guild);
    await addRoleOrThrowClear(member, verifiedRole);

    const workspaceCh = await getOrCreateWorkspaceChannel(guild, member);

    // Conditional update — only writes if user is still NOT verified.
    // Prevents stale modal from overwriting an account that became verified
    // during the async window (parallel verify flow / admin manual edit).
    const updated = await db.update(users).set({
      redditUsername: nameLower,
      redditAccountAgeDays: p.accountAgeDays,
      redditPostKarma: p.linkKarma,
      redditCommentKarma: p.commentKarma,
      verified: true,
      workspaceChannelId: workspaceCh.id,
    }).where(and(eq(users.discordId, discordId), eq(users.verified, false))).returning({ id: users.id });
    invalidateUser(discordId);

    if (updated.length === 0) {
      const fresh = await getUserByDiscordId(discordId);
      logger.info({ discordId, attempted: nameLower, currentReddit: fresh?.redditUsername }, "Verify finalize aborted — user already verified");
      const freshName = fresh?.redditUsername ?? null;
      return interaction.editReply({ embeds: [makeEmbed(COLORS.WARNING).setDescription(
        freshName
          ? `Your Discord account is already verified with **u/${freshName}**.\n\nClick **Verify Me** again to link an additional Reddit account.`
          : `Your Discord account is already verified.`
      )] });
    }

    // Mirror the primary into reddit_accounts so the multi-account list is
    // always complete. Idempotent — UNIQUE catches a backfill collision.
    await db.insert(redditAccounts).values({
      discordId,
      redditUsername: nameLower,
      accountAgeDays: p.accountAgeDays,
      postKarma: p.linkKarma,
      commentKarma: p.commentKarma,
    }).onConflictDoNothing({ target: redditAccounts.redditUsername });

    await workspaceCh.send({
      embeds: [
        makeEmbed(COLORS.SUCCESS)
          .setTitle("👋 Welcome to your workspace!")
          .setDescription(
            `Hey <@${discordId}>! You're verified and ready to earn.\n\nWhen you claim tasks, they'll appear here with all the details you need. Good luck!`
          ),
      ],
    });

    try {
      await member.send({
        embeds: [
          makeEmbed(COLORS.SUCCESS)
            .setTitle("You're verified! 🎉")
            .setDescription(
              `You've been auto-verified on **${guild.name}**!\n\n` +
              `📂 Workspace: <#${workspaceCh.id}>\n\n` +
              `**💰 Don't forget to set up payouts:**\n` +
              `• \`/setwallet coin:USDT address:<your-wallet>\` for crypto\n` +
              `• \`/setwallet coin:Binance Pay ID address:<your-pay-id>\` for Binance\n` +
              `• \`/setupi upi_id:yourname@bank\` for UPI\n` +
              `• \`/wallet\` to check your balance`
            ),
        ],
      });
    } catch {
      logger.warn({ discordId }, "Could not DM user on auto-verify");
    }

    await markReferralVerified(discordId).catch(() => {});

    const logEmbed = makeEmbed(COLORS.SUCCESS)
      .setTitle("✅ User Auto-Verified")
      .setThumbnail(p.iconImg ?? null)
      .addFields(
        { name: "Discord User", value: `<@${discordId}> (${discordUsername})`, inline: true },
        { name: "Reddit Account", value: `u/${p.name}`, inline: true },
        { name: "Account Age", value: `${p.accountAgeDays} days`, inline: true },
        { name: "Post Karma", value: p.karmaVerified ? p.linkKarma.toLocaleString() : "N/A (API blocked)", inline: true },
        { name: "Comment Karma", value: p.karmaVerified ? p.commentKarma.toLocaleString() : "N/A (API blocked)", inline: true },
        { name: "Total Karma", value: p.karmaVerified ? p.totalKarma.toLocaleString() : "N/A (API blocked)", inline: true },
      )
      .setFooter({ text: p.karmaVerified ? "Auto-verified — use 'Take Action' to revoke if needed" : "Auto-verified via RSS (karma unverifiable — Reddit API blocked). Revoke if account looks suspicious." });

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`verify:revoke:${discordId}`)
        .setLabel("Take Action / Revoke")
        .setStyle(ButtonStyle.Danger),
    );

    await verificationLogChannel.send({ embeds: [logEmbed], components: [actionRow] });

    await interaction.editReply({
      embeds: [
        makeEmbed(COLORS.SUCCESS)
          .setTitle("✅ Verified!")
          .setDescription(
            `Welcome! Your account is verified.\n\n` +
            `📂 Your workspace: <#${workspaceCh.id}>\n\n` +
            `**💰 Set up payouts so you can withdraw what you earn:**\n` +
            `• Crypto wallet → \`/setwallet coin:USDT address:<your-wallet>\`\n` +
            `• Binance Pay ID → \`/setwallet coin:Binance Pay ID address:<your-pay-id>\`\n` +
            `• UPI (India) → \`/setupi upi_id:yourname@bank\`\n` +
            `• View your balance anytime → \`/wallet\``
          ),
      ],
    });

    logger.info({ discordId, parsed, karma: p.totalKarma, age: p.accountAgeDays }, "User auto-verified");
    return;
  }

  if (result.notFound) {
    const msg = result.suspended
      ? `❌ Reddit account u/${parsed} is suspended.`
      : `❌ Reddit account u/${parsed} not found. Make sure the username is correct.`;
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(msg)],
    });
  }

  // Multi-Reddit-account: if this is an ADDITIONAL account and Reddit API is
  // unreachable, don't queue manual review (the existing manual-accept flow
  // is wired only to flip the user's verified flag, not to add an extra
  // reddit_accounts row). Ask the user to retry shortly. The primary verify
  // path is unaffected.
  if (isAdditional) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.WARNING).setDescription(
        `⏳ Reddit API was unreachable just now, so we couldn't add **u/${parsed}** as an additional account. Please try again in a minute.`
      )],
    });
  }

  const networkEmbed = makeEmbed(COLORS.WARNING)
    .setTitle("Verification Request — Manual Review Needed")
    .setDescription(
      `🚨 Reddit API was unreachable. A mod will verify manually.\n\n**Claimed username:** u/${parsed}`
    )
    .addFields(
      { name: "Discord User", value: `<@${discordId}> (${discordUsername})`, inline: true },
      { name: "Reddit Profile", value: `[u/${parsed}](https://reddit.com/u/${parsed})`, inline: true }
    );

  await db.update(users).set({
    redditUsername: nameLower,
  }).where(eq(users.discordId, discordId));
  invalidateUser(discordId);

  const manualRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`verify:accept:${discordId}`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`verify:reject:${discordId}`)
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger),
  );

  await verificationLogChannel.send({ embeds: [networkEmbed], components: [manualRow] });
  await interaction.editReply({
    embeds: [makeEmbed(COLORS.WARNING).setDescription("⏳ Verification request submitted — a moderator will review your account shortly.")],
  });

  logger.info({ discordId, parsed }, "Verification queued for manual review (API error)");
}

// Parse the karma/age values back out of the auto-reject log embed.
// The values are formatted via .toLocaleString() ("1,234") and the age as
// "150 days" — so strip commas / the " days" suffix before parseInt.
function parseEmbedNumberField(embed: any, name: string): number | null {
  const f = embed?.fields?.find((x: any) => x?.name === name);
  if (!f?.value) return null;
  const cleaned = String(f.value).replace(/,/g, "").trim();
  const n = parseInt(cleaned);
  return Number.isFinite(n) ? n : null;
}

export async function handleVerifyAccept(
  interaction: ButtonInteraction,
  discordId: string,
  // Optional: the exact Reddit username this auto-reject log was for.
  // New customId format (`verify:accept:<discordId>:<redditUsernameLower>`)
  // always sends this. Old in-flight buttons posted BEFORE this deploy
  // won't have it — for those we fall back to the legacy behavior
  // (which only works for first-time verifications).
  redditUsernameLower: string = "",
) {
  await interaction.deferUpdate();

  const guild = interaction.guild!;
  let member;
  try {
    member = await guild.members.fetch(discordId);
  } catch {
    await interaction.followUp({ content: "❌ Could not find that member in the server.", flags: 64 });
    return;
  }

  const user = await getUserByDiscordId(discordId);
  if (!user) {
    await interaction.followUp({ content: "❌ User not found in database.", flags: 64 });
    return;
  }

  // Pull the captured-at-rejection karma/age out of the log embed so we
  // don't have to refetch from Reddit (the account may have been banned
  // or the username changed in the meantime; admin is accepting the
  // snapshot they reviewed).
  const logEmbed = interaction.message.embeds[0];
  const ageDays = parseEmbedNumberField(logEmbed, "Account Age");
  const postKarma = parseEmbedNumberField(logEmbed, "Post Karma");
  const commentKarma = parseEmbedNumberField(logEmbed, "Comment Karma");

  // ─── ADDITIONAL ACCOUNT path ───────────────────────────────────────────
  // User is already verified AND we know which Reddit username this log
  // was for. Skip role/workspace setup; just append to reddit_accounts
  // (respecting the per-user cap + anti-alt uniqueness) and notify.
  if (user.verified && redditUsernameLower) {
    // Already linked? (admin double-click, or user re-clicked verify and
    // it auto-passed between the rejection and the accept click)
    const alreadyOwned = await db.execute<{ discord_id: string }>(
      sql`SELECT discord_id FROM reddit_accounts WHERE reddit_username = ${redditUsernameLower} LIMIT 1`
    );
    if (alreadyOwned.rows.length > 0) {
      const owner = alreadyOwned.rows[0]!.discord_id;
      if (owner === discordId) {
        // Idempotent — already on file. Just close the log and ack.
        const updated = EmbedBuilder.from(logEmbed)
          .setColor(COLORS.SUCCESS)
          .setFooter({ text: `Already linked — closed by ${interaction.user.username}` });
        await interaction.message.edit({ embeds: [updated], components: [] }).catch(() => {});
        await interaction.followUp({
          content: `ℹ️ <@${discordId}> already has **u/${redditUsernameLower}** linked. Nothing to do.`,
          flags: 64,
        });
        return;
      }
      // Owned by someone else — anti-alt blocks it.
      await interaction.followUp({
        content: `❌ Cannot link **u/${redditUsernameLower}** — it's already linked to <@${owner}>. Unlink it from the other user first.`,
        flags: 64,
      });
      return;
    }

    // Enforce the per-user cap.
    const cap = await getMaxRedditAccounts().catch(() => DEFAULT_MAX_REDDIT_ACCOUNTS);
    const current = await countRedditAccounts(discordId);
    if (current >= cap) {
      await interaction.followUp({
        content: `❌ <@${discordId}> is already at the **${cap}**-account limit. Unlink one of their accounts first, then try again.`,
        flags: 64,
      });
      return;
    }

    try {
      await db.insert(redditAccounts).values({
        discordId,
        redditUsername: redditUsernameLower,
        accountAgeDays: ageDays ?? null,
        postKarma: postKarma ?? null,
        commentKarma: commentKarma ?? null,
      });
    } catch (err: any) {
      logger.error({ err, discordId, redditUsernameLower }, "Manual-accept additional account insert failed");
      await interaction.followUp({
        content: `❌ Could not link account: ${err?.message ?? "database error"}`,
        flags: 64,
      });
      return;
    }
    invalidateUser(discordId);

    // Edit the log so it's clear this was accepted.
    const updated = EmbedBuilder.from(logEmbed)
      .setColor(COLORS.SUCCESS)
      .setTitle("✅ Additional Reddit Account — Manually Accepted")
      .setFooter({ text: `Accepted by ${interaction.user.username} (override)` });
    await interaction.message.edit({ embeds: [updated], components: [] }).catch(() => {});

    // Notify the user in their workspace channel — same pattern as the
    // auto-accept path so the worker sees the same confirmation either way.
    if (user.workspaceChannelId) {
      try {
        const ws = await guild.channels.fetch(user.workspaceChannelId).catch(() => null);
        if (ws && ws.isTextBased() && "send" in ws) {
          const linkedNow = await fetchLinkedRedditUsernames(discordId);
          await (ws as any).send({
            content: `<@${discordId}>`,
            embeds: [
              makeEmbed(COLORS.SUCCESS)
                .setTitle("✅ Additional Reddit account linked")
                .setDescription(
                  `An admin manually approved **u/${redditUsernameLower}** as an additional Reddit account.\n\n` +
                  `Your linked accounts:\n${linkedNow.map((u) => `• u/${u}`).join("\n")}`
                ),
            ],
          });
        }
      } catch (err) {
        logger.warn({ err, discordId }, "Could not post manual-accept additional-account notice to workspace channel");
      }
    }

    logger.info({ discordId, redditUsername: redditUsernameLower, reviewer: interaction.user.id }, "Additional Reddit account manually accepted");
    return;
  }

  // ─── FIRST-TIME verification path (legacy, kept intact) ─────────────────
  const { verifiedRole } = await setupGuild(guild);
  await addRoleOrThrowClear(member, verifiedRole);

  const workspaceCh = await getOrCreateWorkspaceChannel(guild, member);

  // PRE-EXISTING BUG FIX: when redditUsernameLower is passed (new customId),
  // also write it into users.reddit_username + the karma fields. Previously
  // the first-time Accept Anyway path left users.reddit_username at whatever
  // it was before (often NULL) and never inserted a reddit_accounts row
  // because the `if (user.redditUsername)` check below saw null.
  const primaryName = redditUsernameLower || user.redditUsername || null;
  if (primaryName && redditUsernameLower) {
    await db.update(users).set({
      redditUsername: primaryName,
      redditAccountAgeDays: ageDays ?? user.redditAccountAgeDays,
      redditPostKarma: postKarma ?? user.redditPostKarma,
      redditCommentKarma: commentKarma ?? user.redditCommentKarma,
      verified: true,
      workspaceChannelId: workspaceCh.id,
    }).where(eq(users.discordId, discordId));
  } else {
    await db.update(users).set({
      verified: true,
      workspaceChannelId: workspaceCh.id,
    }).where(eq(users.discordId, discordId));
  }
  invalidateUser(discordId);

  // Mirror the now-verified primary into reddit_accounts (idempotent).
  if (primaryName) {
    await db.insert(redditAccounts).values({
      discordId,
      redditUsername: primaryName,
      accountAgeDays: ageDays ?? user.redditAccountAgeDays,
      postKarma: postKarma ?? user.redditPostKarma,
      commentKarma: commentKarma ?? user.redditCommentKarma,
    }).onConflictDoNothing({ target: redditAccounts.redditUsername });
  }

  await workspaceCh.send({
    embeds: [
      makeEmbed(COLORS.SUCCESS)
        .setTitle("👋 Welcome to your workspace!")
        .setDescription(
          `Hey <@${discordId}>! You're verified and ready to earn.\n\nWhen you claim tasks, they'll appear here with all the details you need. Good luck!`
        ),
    ],
  });

  const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(COLORS.SUCCESS)
    .setFooter({ text: `Accepted by ${interaction.user.username}` });

  await interaction.message.edit({ embeds: [updatedEmbed], components: [] });

  try {
    await member.send({
      embeds: [
        makeEmbed(COLORS.SUCCESS)
          .setTitle("You're verified! 🎉")
          .setDescription(
            `You've been verified on **${guild.name}**! Head over to your workspace channel <#${workspaceCh.id}> to start claiming tasks.\n\n` +
            `**💰 Set up your payout method:**\n` +
            `• \`/setwallet\` — save a crypto wallet (ETH/USDT/BTC) or Binance Pay ID\n` +
            `• \`/setupi\` — save a UPI ID (India)\n` +
            `• \`/wallet\` — view your balance any time`
          ),
      ],
    });
  } catch {
    logger.warn({ discordId }, "Could not DM user on verify accept");
  }

  await markReferralVerified(discordId).catch(() => {});
  logger.info({ discordId, reviewer: interaction.user.id, redditUsername: primaryName }, "Verification manually accepted");
}

export async function handleVerifyDismiss(interaction: ButtonInteraction) {
  await interaction.deferUpdate();
  const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(COLORS.MUTED)
    .setFooter({ text: `Dismissed by ${interaction.user.username}` });
  await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
}

export async function handleAdminVerifyCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: 64 });

  const guild = interaction.guild!;
  const member = await guild.members.fetch(interaction.user.id);
  if (!hasModRole(member, guild)) {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ Only Admins and Mods can use `/verifyuser`.")] });
  }

  const targetUser = interaction.options.getUser("user", true);
  const action = interaction.options.getString("action", true) as "verify" | "unverify";
  const redditUsernameInput = (interaction.options.getString("reddit_username") ?? "").trim();

  const discordId = targetUser.id;

  let targetMember;
  try {
    targetMember = await guild.members.fetch(discordId);
  } catch {
    return interaction.editReply({ embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ That user is not in this server.")] });
  }

  await upsertUser(discordId, targetUser.username);
  const existingUser = await getUserByDiscordId(discordId);

  if (action === "unverify") {
    if (!existingUser?.verified) {
      return interaction.editReply({ embeds: [makeEmbed(COLORS.WARNING).setDescription(`⚠️ <@${discordId}> is not currently verified.`)] });
    }

    await db.update(users).set({ verified: false }).where(eq(users.discordId, discordId));
    await db.execute(sql`DELETE FROM reddit_accounts WHERE discord_id = ${discordId}`);
    invalidateUser(discordId);

    const { verifiedRole } = await setupGuild(guild);
    await targetMember.roles.remove(verifiedRole).catch(() => {});

    try {
      await targetMember.send({
        embeds: [makeEmbed(COLORS.WARNING)
          .setTitle("Verification Removed")
          .setDescription(`Your verified status on **${guild.name}** was removed by an admin.`)],
      });
    } catch { /* DM failed, ignore */ }

    logger.info({ discordId, actor: interaction.user.id }, "Admin manually unverified user");
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ <@${discordId}> has been unverified and their Discord role removed.`)],
    });
  }

  // action === "verify"
  if (existingUser?.verified) {
    const linked = await fetchLinkedRedditUsernames(discordId);
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.WARNING).setDescription(
        `⚠️ <@${discordId}> is already verified.\n\n**Linked accounts:** ${linked.map((u) => `u/${u}`).join(", ") || "none on file"}\n\nTo add another Reddit account, have them use \`/verify\` themselves.`
      )],
    });
  }

  let redditUsername = redditUsernameInput || existingUser?.redditUsername || null;
  if (!redditUsername) {
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription("❌ This user has no Reddit username on file. Provide `reddit_username` option or have them run `/verify` first.")],
    });
  }
  redditUsername = redditUsername.toLowerCase().replace(/^u\//i, "");

  const { verifiedRole } = await setupGuild(guild);
  await targetMember.roles.add(verifiedRole).catch(() => {});

  const workspaceCh = await getOrCreateWorkspaceChannel(guild, targetMember);

  await db.update(users).set({
    redditUsername,
    verified: true,
    workspaceChannelId: workspaceCh.id,
  }).where(eq(users.discordId, discordId));

  await db.insert(redditAccounts).values({
    discordId,
    redditUsername,
    accountAgeDays: existingUser?.redditAccountAgeDays,
    postKarma: existingUser?.redditPostKarma,
    commentKarma: existingUser?.redditCommentKarma,
  }).onConflictDoNothing({ target: redditAccounts.redditUsername });

  invalidateUser(discordId);

  try {
    await targetMember.send({
      embeds: [makeEmbed(COLORS.SUCCESS)
        .setTitle("You've been verified! 🎉")
        .setDescription(`An admin verified your account on **${guild.name}**.\n\n📂 Workspace: <#${workspaceCh.id}>`)],
    });
  } catch { /* DM failed, ignore */ }

  const { verificationLogChannel } = await setupGuild(guild);
  await verificationLogChannel.send({
    embeds: [makeEmbed(COLORS.SUCCESS)
      .setTitle("✅ User Manually Verified")
      .addFields(
        { name: "Discord User", value: `<@${discordId}> (${targetUser.username})`, inline: true },
        { name: "Reddit Account", value: `u/${redditUsername}`, inline: true },
        { name: "Verified By", value: `<@${interaction.user.id}> (${interaction.user.username})`, inline: true },
      )],
  }).catch(() => {});

  logger.info({ discordId, redditUsername, actor: interaction.user.id }, "Admin manually verified user");

  return interaction.editReply({
    embeds: [makeEmbed(COLORS.SUCCESS).setDescription(`✅ <@${discordId}> is now verified as **u/${redditUsername}** and has been given the Verified role.`)],
  });
}

export async function handleVerifyRevoke(interaction: ButtonInteraction, discordId: string) {
  const modal = new ModalBuilder()
    .setCustomId(`verify:rejectreason:${discordId}:${interaction.message.id}`)
    .setTitle("Revoke Verification");

  const input = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Reason (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

export async function handleVerifyReject(interaction: ButtonInteraction, discordId: string) {
  const modal = new ModalBuilder()
    .setCustomId(`verify:rejectreason:${discordId}:${interaction.message.id}`)
    .setTitle("Reject Verification");

  const input = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Reason (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(500);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

export async function handleVerifyRejectReason(
  interaction: ModalSubmitInteraction,
  discordId: string,
  originalMessageId: string
) {
  await interaction.deferUpdate();

  const reason = interaction.fields.getTextInputValue("reason") || "No reason provided";
  const guild = interaction.guild!;

  await db.update(users).set({
    redditUsername: null,
    redditAccountAgeDays: null,
    redditPostKarma: null,
    redditCommentKarma: null,
    verified: false,
  }).where(eq(users.discordId, discordId));
  // Multi-Reddit-account: revoking a user clears ALL their linked Reddit
  // accounts so the usernames are released for re-verification (matches the
  // existing single-account behavior — anti-alt would otherwise lock them).
  await db.execute(sql`DELETE FROM reddit_accounts WHERE discord_id = ${discordId}`);
  invalidateUser(discordId);

  try {
    const member = await guild.members.fetch(discordId);
    const { verifiedRole } = await setupGuild(guild);
    await member.roles.remove(verifiedRole).catch(() => {});

    await member.send({
      embeds: [
        makeEmbed(COLORS.DANGER)
          .setTitle("Verification Rejected")
          .setDescription(`Your verification on **${guild.name}** was rejected.\n\n**Reason:** ${reason}`),
      ],
    });
  } catch {
    logger.warn({ discordId }, "Could not DM user on verify reject");
  }

  const originalEmbed = interaction.message?.embeds[0];
  if (originalEmbed) {
    const updatedEmbed = EmbedBuilder.from(originalEmbed)
      .setColor(COLORS.DANGER)
      .setFooter({ text: `Rejected by ${interaction.user.username}: ${reason}` });
    await interaction.message?.edit({ embeds: [updatedEmbed], components: [] });
  }

  logger.info({ discordId, reviewer: interaction.user.id, reason }, "Verification rejected/revoked");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared unlink helper — used by BOTH the dashboard's DELETE
// /reddit-accounts/:discordId/:redditUsername route AND the in-Discord
// "🗑️ Unlink Account" button on the additional-account verification log.
// Single source of truth so the two paths can't drift apart.
// ─────────────────────────────────────────────────────────────────────────────
export async function unlinkRedditAccount(opts: {
  discordId: string;
  redditUsernameLower: string;
  guild: Guild | null;
  actorLabel: string;
}): Promise<{ remainingCount: number; unverified: boolean }> {
  const { discordId, redditUsernameLower, guild, actorLabel } = opts;

  // 1) Remove the row from reddit_accounts.
  await db.execute(
    sql`DELETE FROM reddit_accounts WHERE discord_id = ${discordId} AND reddit_username = ${redditUsernameLower}`
  );

  // 2) If this was the primary mirrored on users.reddit_username, promote
  //    the next-oldest linked account (oldest = first verified). Ordered by
  //    created_at because reddit_accounts has NO verified_at column here.
  const userRow = await db.execute<{ reddit_username: string | null }>(
    sql`SELECT reddit_username FROM users WHERE discord_id = ${discordId} LIMIT 1`
  );
  if (userRow.rows[0]?.reddit_username === redditUsernameLower) {
    const nextAcc = await db.execute<{ reddit_username: string }>(
      sql`SELECT reddit_username FROM reddit_accounts WHERE discord_id = ${discordId} ORDER BY created_at ASC LIMIT 1`
    );
    await db.execute(
      sql`UPDATE users SET reddit_username = ${nextAcc.rows[0]?.reddit_username ?? null} WHERE discord_id = ${discordId}`
    );
  }

  // 3) If zero accounts remain, the user is no longer verified at all —
  //    flip verified=false and strip the Discord verified role.
  const remaining = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count FROM reddit_accounts WHERE discord_id = ${discordId}`
  );
  const remainingCount = parseInt(remaining.rows[0]?.count ?? "0");
  let unverified = false;
  if (remainingCount === 0) {
    await db.execute(sql`UPDATE users SET verified = false WHERE discord_id = ${discordId}`);
    unverified = true;
    if (guild) {
      try {
        const setup = await setupGuild(guild);
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (member) await member.roles.remove(setup.verifiedRole).catch(() => {});
      } catch (err) {
        logger.warn({ err, discordId }, "Could not strip verified role after unlink");
      }
    }
  }

  invalidateUser(discordId);

  // 4) Best-effort: tell the worker in their workspace channel what just
  //    happened. They've been pinging admins about silent unlinks; a clear
  //    in-channel notice closes the loop.
  if (guild) {
    try {
      const fresh = await getUserByDiscordId(discordId);
      const wsId = fresh?.workspaceChannelId;
      if (wsId) {
        const ws = await guild.channels.fetch(wsId).catch(() => null);
        if (ws && ws.isTextBased() && "send" in ws) {
          const desc = unverified
            ? `Your Reddit account **u/${redditUsernameLower}** was unlinked by an admin. ` +
              `You had no other linked accounts, so your verification has been reset. ` +
              `Run \`/verify\` again to re-link a Reddit account.`
            : `Your Reddit account **u/${redditUsernameLower}** was unlinked by an admin. ` +
              `Your other linked accounts are still active and you can keep submitting proofs from them.`;
          await (ws as any).send({
            content: `<@${discordId}>`,
            embeds: [
              makeEmbed(unverified ? COLORS.DANGER : COLORS.WARNING)
                .setTitle(unverified ? "⚠️ Reddit account unlinked — verification reset" : "⚠️ Reddit account unlinked")
                .setDescription(desc)
                .setFooter({ text: `Action by ${actorLabel}` }),
            ],
          });
        }
      }
    } catch (err) {
      logger.warn({ err, discordId }, "Could not post unlink notice to workspace channel");
    }
  }

  logger.info({ discordId, redditUsername: redditUsernameLower, remainingCount, unverified, actor: actorLabel }, "Reddit account unlinked");
  return { remainingCount, unverified };
}

// In-Discord button handler for "🗑️ Unlink Account" on the additional-account log.
export async function handleVerifyUnlinkAccount(
  interaction: ButtonInteraction,
  discordId: string,
  redditUsernameLower: string,
) {
  // Permission gate — admins + mods only. Must run BEFORE deferReply so
  // the "Only admins" message is the actual response, not an empty
  // ephemeral edit.
  if (!interaction.guild) {
    return interaction.reply({ content: "❌ This button only works inside a server.", ephemeral: true });
  }
  const member = interaction.member as any;
  if (!hasAdminRole(member, interaction.guild) && !hasModRole(member, interaction.guild)) {
    return interaction.reply({
      content: "❌ Only admins or mods can unlink Reddit accounts.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const guild = interaction.guild;
    const result = await unlinkRedditAccount({
      discordId,
      redditUsernameLower,
      guild,
      actorLabel: `@${interaction.user.username}`,
    });

    // Edit the original log message: disable buttons + add who-unlinked footer
    // so the log channel shows a clear audit trail.
    const original = interaction.message;
    if (original?.embeds?.[0]) {
      const updated = EmbedBuilder.from(original.embeds[0])
        .setColor(COLORS.DANGER)
        .setFooter({ text: `🗑️ Unlinked by ${interaction.user.username}${result.unverified ? " — user fully unverified" : ""}` });
      // Keep the link button (View Profile) usable; only disable the Unlink button.
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`noop:unlinked:${Date.now()}`)
          .setLabel("✅ Unlinked")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setLabel("🔗 View Profile")
          .setStyle(ButtonStyle.Link)
          .setURL(`https://www.reddit.com/user/${encodeURIComponent(redditUsernameLower)}`),
      );
      await original.edit({ embeds: [updated], components: [disabledRow] }).catch(() => {});
    }

    return interaction.editReply({
      embeds: [
        makeEmbed(COLORS.SUCCESS).setDescription(
          `✅ Unlinked **u/${redditUsernameLower}** from <@${discordId}>.\n\n` +
          (result.unverified
            ? `That was their last linked account — user has been **unverified** and the Verified role removed.`
            : `User still has **${result.remainingCount}** other linked account${result.remainingCount === 1 ? "" : "s"}.`)
        ),
      ],
    });
  } catch (err: any) {
    logger.error({ err, discordId, redditUsernameLower }, "handleVerifyUnlinkAccount failed");
    return interaction.editReply({
      embeds: [makeEmbed(COLORS.DANGER).setDescription(`❌ Could not unlink account: ${err?.message ?? "unknown error"}`)],
    });
  }
}
