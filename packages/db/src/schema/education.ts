import { sql } from "drizzle-orm";
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

// Dates are free text (e.g. "Sep 2020", "2020") rather than a strict date
// type — resumes rarely give full ISO dates, and structured date parsing
// isn't needed until a later phase actually sorts/filters on it.
export const education = pgTable("education", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  institution: text("institution").notNull(),
  degree: text("degree").notNull(),
  fieldOfStudy: text("field_of_study"),
  startDate: text("start_date"),
  endDate: text("end_date"),
  gpa: text("gpa"),
});
