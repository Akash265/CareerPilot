import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, numeric, boolean, pgEnum } from "drizzle-orm/pg-core";
import { careerGoals } from "./careerGoals";

// Reuses the "work_mode_preference" Postgres enum type that used to belong
// to candidate_profiles.work_mode_preference (retired -- DECISIONS.md D21).
// Renaming the SQL type would be pure migration churn for a value set that
// hasn't changed.
export const workModePreferenceEnum = pgEnum("work_mode_preference", [
  "remote", "hybrid", "onsite", "any",
]);

export const careerGoalConstraints = pgTable("career_goal_constraints", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  careerGoalId: uuid("career_goal_id")
    .notNull()
    .unique()
    .references(() => careerGoals.id, { onDelete: "cascade" }),
  targetRoles: text("target_roles").array().notNull().default(sql`ARRAY[]::text[]`),
  seniority: text("seniority"),
  locations: text("locations").array().notNull().default(sql`ARRAY[]::text[]`),
  workMode: workModePreferenceEnum("work_mode").notNull().default("any"),
  minExperienceYears: integer("min_experience_years"),
  employmentType: text("employment_type"),
  salaryFloorRaw: text("salary_floor_raw"),
  salaryFloorNormalized: numeric("salary_floor_normalized"),
  salaryCurrency: text("salary_currency"),
  salaryIsParsed: boolean("salary_is_parsed").notNull().default(false),
  visaSponsorshipRequired: boolean("visa_sponsorship_required"),
  skills: text("skills").array().notNull().default(sql`ARRAY[]::text[]`),
  preferredIndustries: text("preferred_industries").array().notNull().default(sql`ARRAY[]::text[]`),
  excludedIndustries: text("excluded_industries").array().notNull().default(sql`ARRAY[]::text[]`),
  preferredCompanies: text("preferred_companies").array().notNull().default(sql`ARRAY[]::text[]`),
  excludedCompanies: text("excluded_companies").array().notNull().default(sql`ARRAY[]::text[]`),
  hardConstraints: text("hard_constraints").array().notNull().default(sql`ARRAY[]::text[]`),
});
