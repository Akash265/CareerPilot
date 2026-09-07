import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, numeric, boolean, timestamp, pgEnum,
} from "drizzle-orm/pg-core";

export const workModePreferenceEnum = pgEnum("work_mode_preference", [
  "remote", "hybrid", "onsite", "any",
]);

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
  workModePreference: workModePreferenceEnum("work_mode_preference")
    .notNull()
    .default("any"),
  salaryExpectationMin: numeric("salary_expectation_min"),
  salaryExpectationMax: numeric("salary_expectation_max"),
  salaryCurrency: text("salary_currency"),
  visaSponsorshipRequired: boolean("visa_sponsorship_required")
    .notNull()
    .default(false),
  workAuthorizationNotes: text("work_authorization_notes"),
  preferredRoleTitles: text("preferred_role_titles")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  preferredIndustries: text("preferred_industries")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  excludedIndustries: text("excluded_industries")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
