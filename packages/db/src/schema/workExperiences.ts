import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer } from "drizzle-orm/pg-core";

export const workExperiences = pgTable("work_experiences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  company: text("company").notNull(),
  title: text("title").notNull(),
  location: text("location"),
  employmentType: text("employment_type"),
  startDate: text("start_date"),
  endDate: text("end_date"), // null = current role
  displayOrder: integer("display_order").notNull().default(0),
});

export const workExperienceBullets = pgTable("work_experience_bullets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  workExperienceId: uuid("work_experience_id")
    .notNull()
    .references(() => workExperiences.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
});
