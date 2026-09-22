import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, numeric, boolean, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { careerGoals } from "./careerGoals";

export const jobMatchUserActionEnum = pgEnum("job_match_user_action", ["none", "saved", "dismissed"]);

/**
 * One row per (user, job), overwritten in place on each matching run -- not versioned like
 * career_goals (design doc §3). Also the "saved/dismissed jobs" mechanism (spec §19) until Phase 9's
 * application tracker exists. An ineligible job still gets a row (eligible=false + reason) instead
 * of being silently dropped, so eligibility stays explainable (CLAUDE.md §6).
 */
export const jobMatches = pgTable(
  "job_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    careerGoalId: uuid("career_goal_id")
      .notNull()
      .references(() => careerGoals.id, { onDelete: "cascade" }),
    eligible: boolean("eligible").notNull(),
    ineligibleReason: text("ineligible_reason"),

    skillsScore: numeric("skills_score"),
    experienceScore: numeric("experience_score"),
    locationScore: numeric("location_score"),
    sponsorshipScore: numeric("sponsorship_score"),
    roleScore: numeric("role_score"),
    salaryScore: numeric("salary_score"),
    industryScore: numeric("industry_score"),
    freshnessScore: numeric("freshness_score"),
    semanticScore: numeric("semantic_score"),
    overallScore: numeric("overall_score"),

    // { strongMatches: string[], partialMatches: string[], gaps: string[], summary: string } | null
    explanation: jsonb("explanation"),
    explanationModel: text("explanation_model"),
    // Refinement #1: the jobs.description_hash the current explanation was generated against, so
    // staleness can be detected (design doc §7) instead of only ever comparing to the live hash.
    explanationDescriptionHash: text("explanation_description_hash"),
    explanationGeneratedAt: timestamp("explanation_generated_at", { withTimezone: true }),

    userAction: jobMatchUserActionEnum("user_action").notNull().default("none"),
    userActionAt: timestamp("user_action_at", { withTimezone: true }),

    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userJobUniq: uniqueIndex("job_matches_user_job_uniq").on(t.userId, t.jobId),
  })
);
