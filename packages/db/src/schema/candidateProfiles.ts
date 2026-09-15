import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

// work_mode_preference, salary_expectation_min/max/currency,
// visa_sponsorship_required, preferred_role_titles, preferred_industries,
// excluded_industries, and the company_preferences table were retired here
// -- career_goal_constraints (careerGoalConstraints.ts) is now the single
// source of truth for search-relevant preferences (DECISIONS.md D21).
export const candidateProfiles = pgTable("candidate_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phoneNumber: text("phone_number"),
  linkedinUrl: text("linkedin_url"),
  addressLine1: text("address_line1"),
  yearsOfExperience: integer("years_of_experience"),
  workAuthorizationNotes: text("work_authorization_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
