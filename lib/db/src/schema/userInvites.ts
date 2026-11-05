import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const userInvites = pgTable("user_invites", {
  inviteCode: text("invite_code").primaryKey(),
  discordId: text("discord_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserInvite = typeof userInvites.$inferSelect;
export type InsertUserInvite = typeof userInvites.$inferInsert;
