import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const careerGoalParseStatusEnum = pgEnum("career_goal_parse_status", [
  "pending", "parsed", "failed",
]);

export const careerGoalConfirmationStatusEnum = pgEnum("career_goal_confirmation_status", [
  "draft", "confirmed",
]);

export const careerGoals = pgTable("career_goals", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  rawText: text("raw_text").notNull(),
  version: integer("version").notNull(),
  parseStatus: careerGoalParseStatusEnum("parse_status").notNull().default("pending"),
  parseError: text("parse_error"),
  confirmationStatus: careerGoalConfirmationStatusEnum("confirmation_status")
    .notNull()
    .default("draft"),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});
