import { sql } from "drizzle-orm";
import { pgTable, uuid, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { resumeOptimizations } from "./resumeOptimizations";

/**
 * One row per resume_optimizations row (1:1 -- a fresh score always accompanies a fresh
 * optimization, design doc §3). All sub-scores are 0-1 fractions except overallScore, which is
 * 0-100 with one decimal place -- same convention as job_matches' factor scores vs overall_score.
 * semanticSimilarity is nullable: null when the job has no embedding yet or Voyage failed
 * transiently (computeOverallScore, Task 10, redistributes a null factor's weight).
 */
export const atsEvaluations = pgTable("ats_evaluations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  resumeOptimizationId: uuid("resume_optimization_id")
    .notNull()
    .references(() => resumeOptimizations.id, { onDelete: "cascade" }),
  requiredKeywordCoverage: numeric("required_keyword_coverage").notNull(),
  preferredKeywordCoverage: numeric("preferred_keyword_coverage").notNull(),
  semanticSimilarity: numeric("semantic_similarity"),
  factualConsistency: numeric("factual_consistency").notNull(),
  actionVerbScore: numeric("action_verb_score").notNull(),
  machineReadabilityScore: numeric("machine_readability_score").notNull(),
  overallScore: numeric("overall_score").notNull(),
  evaluatorVersion: text("evaluator_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
