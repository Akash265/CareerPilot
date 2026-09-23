import { sql } from "drizzle-orm";
import { pgTable, uuid, numeric, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { resumeOptimizations } from "./resumeOptimizations";

/**
 * One row per resume_optimizations row (1:1 -- a fresh score always accompanies a fresh
 * optimization, design doc §3; the unique index below makes this a DB-enforced guarantee, not just
 * a documented convention -- a second row for the same optimization would otherwise silently
 * duplicate the parent in listOptimizations' innerJoin). All sub-scores are 0-1 fractions except
 * overallScore, which is 0-100 with one decimal place -- same convention as job_matches' factor
 * scores vs overall_score; both ranges are CHECK-constrained so a scoring bug can never persist an
 * out-of-range value. semanticSimilarity is nullable: null when the job has no embedding yet or
 * Voyage failed transiently (computeOverallScore, Task 10, redistributes a null factor's weight).
 */
export const atsEvaluations = pgTable(
  "ats_evaluations",
  {
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
  },
  (t) => ({
    resumeOptimizationIdUniq: uniqueIndex("ats_evaluations_resume_optimization_id_uniq").on(t.resumeOptimizationId),
    requiredKeywordCoverageRange: check("ats_evaluations_required_keyword_coverage_range", sql`${t.requiredKeywordCoverage} >= 0 AND ${t.requiredKeywordCoverage} <= 1`),
    preferredKeywordCoverageRange: check("ats_evaluations_preferred_keyword_coverage_range", sql`${t.preferredKeywordCoverage} >= 0 AND ${t.preferredKeywordCoverage} <= 1`),
    semanticSimilarityRange: check("ats_evaluations_semantic_similarity_range", sql`${t.semanticSimilarity} IS NULL OR (${t.semanticSimilarity} >= 0 AND ${t.semanticSimilarity} <= 1)`),
    factualConsistencyRange: check("ats_evaluations_factual_consistency_range", sql`${t.factualConsistency} >= 0 AND ${t.factualConsistency} <= 1`),
    actionVerbScoreRange: check("ats_evaluations_action_verb_score_range", sql`${t.actionVerbScore} >= 0 AND ${t.actionVerbScore} <= 1`),
    machineReadabilityScoreRange: check("ats_evaluations_machine_readability_score_range", sql`${t.machineReadabilityScore} >= 0 AND ${t.machineReadabilityScore} <= 1`),
    overallScoreRange: check("ats_evaluations_overall_score_range", sql`${t.overallScore} >= 0 AND ${t.overallScore} <= 100`),
  })
);
