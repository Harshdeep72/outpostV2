import { Client, GatewayIntentBits, EmbedBuilder, type TextChannel } from "discord.js";

async function main() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  await client.login(process.env.DISCORD_BOT_TOKEN);

  const guild = client.guilds.cache.get("1565314110621753495") || client.guilds.cache.first();
  if (!guild) throw new Error("Guild not found");
  const ch = (await guild.channels.fetch("1565798973690876044")) as TextChannel;
  if (!ch) throw new Error("Channel not found");

  // 1. Fetch recent messages
  const msgs = await ch.messages.fetch({ limit: 100 });
  const toDelete: any[] = [];
  msgs.forEach((m) => {
    // If no attachments and no image link in text, mark for deletion
    if (m.attachments.size === 0 && !/(https?:\/\/.*\.(png|jpe?g|webp|gif))/i.test(m.content)) {
      toDelete.push(m);
    }
  });

  console.log(`Deleting ${toDelete.length} non-media chat messages...`);
  if (toDelete.length > 0) {
    const deleted = await ch.bulkDelete(toDelete, true);
    console.log(`Bulk-deleted ${deleted.size} messages.`);

    // Any remaining older messages delete individually
    const remaining = toDelete.filter((m) => !deleted.has(m.id));
    for (const m of remaining) {
      await m.delete().catch(() => {});
    }
  }

  // 2. Set channel topic
  await ch.setTopic(
    "💳 Payment Proofs Only • Post screenshots of your received payouts here. No casual chatting — use #chitchat!"
  ).catch((e) => console.log("Topic update note:", e.message));

  // 3. Post a pinned reminder embed
  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle("💳 #payment-proof — Channel Guidelines")
    .setDescription(
      "This channel is strictly reserved for **payout screenshots & payment receipts** (UPI, PayPal, GCash, USDT).\n\n" +
      "**Rules:**\n" +
      "• ✅ **Allowed:** Screenshots of received payments, bank receipts, or crypto tx confirmations (with or without a caption).\n" +
      "• ❌ **Disallowed:** Plain text messages, general chatter, and questions. Our AutoMod bot will automatically remove text-only messages!\n\n" +
      "💬 Want to chat or hang out? Head over to <#1565314111372394583>!\n" +
      "❓ Questions about tasks or payouts? Use <#1568682213925593189> or <#1568623001551896698>."
    )
    .setFooter({ text: "Reddit Microtasks • Rules & Transparency" })
    .setTimestamp();

  const reminder = await ch.send({ embeds: [embed] });
  await reminder.pin().catch((e) => console.log("Pin note:", e.message));
  console.log("Posted and pinned guidance embed:", reminder.id);

  await client.destroy();
}

main().catch(console.error);
