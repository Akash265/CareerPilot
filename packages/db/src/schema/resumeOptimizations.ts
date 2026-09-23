import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { careerGoals } from "./careerGoals";

/**
 * One row per generation attempt, never overwritten (design doc §1 decision 3: manual "Regenerate"
 * only). `version` increments per (user_id, job_id), enforced by the unique index below.
 * selectedBullets: AppliedBullet[] (Task 6) -- [{ sourceFactId, sourceType, originalText,
 * optimizedText, changeType, justification }]. rejectedClaims: RejectedClaim[] -- [{ sourceFactId,
 * reason }], guard-rejected (Task 6), never "applied".
 */
export const resumeOptimizations = pgTable(
  "resume_optimizations",
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
    version: integer("version").notNull(),
    // Hash of the evidence catalog used; recorded for a future staleness check (like
    // jobMatches.explanationDescriptionHash) but not read or enforced by anything in Phase 6 itself.
    sourceProfileContentHash: text("source_profile_content_hash").notNull(),
    selectedBullets: jsonb("selected_bullets").notNull(),
    addedTerms: text("added_terms").array().notNull().default(sql`'{}'::text[]`),
    unsupportedClaimsDetected: text("unsupported_claims_detected").array().notNull().default(sql`'{}'::text[]`),
    requiresReview: boolean("requires_review").notNull(),
    rejectedClaims: jsonb("rejected_claims").notNull(),
    generationModel: text("generation_model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userJobVersionUniq: uniqueIndex("resume_optimizations_user_job_version_uniq").on(t.userId, t.jobId, t.version),
  })
);
