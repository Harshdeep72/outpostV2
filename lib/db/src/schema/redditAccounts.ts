import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Multi-Reddit-account support: a single Discord user may link up to 3
 * Reddit accounts. The first one ever linked is mirrored into
 * `users.reddit_username` (kept for backward compatibility with existing
 * code that reads a single primary username); every linked account — primary
 * included — gets a row here.
 *
 * `reddit_username` is UNIQUE across the whole table to keep the original
 * anti-alt rule: one Reddit account can only ever belong to ONE Discord user.
 */
export const redditAccounts = pgTable("reddit_accounts", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull(),
  redditUsername: text("reddit_username").notNull().unique(),
  accountAgeDays: integer("account_age_days"),
  postKarma: integer("post_karma"),
  commentKarma: integer("comment_karma"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RedditAccount = typeof redditAccounts.$inferSelect;
export type InsertRedditAccount = typeof redditAccounts.$inferInsert;
