import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";

export const requirementTermTypeEnum = pgEnum("requirement_term_type", ["skill", "tool", "certification", "other"]);
export const requirementLevelEnum = pgEnum("requirement_level", ["required", "preferred"]);

/**
 * One row per extracted term (design doc §3) -- not a JSON blob, so coverage math in
 * evaluation/scoreKeywordCoverage.ts (Task 7) is a simple count. Cached by
 * extractionSourceDescriptionHash against jobs.descriptionHash (same staleness pattern as
 * jobs.embeddingContentHash); re-extraction deletes and replaces every row for the job rather than
 * versioning them -- this table is a cache of the current description, not a history (design doc §1).
 */
export const jobRequirements = pgTable("job_requirements", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  jobId: uuid("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  termText: text("term_text").notNull(),
  termType: requirementTermTypeEnum("term_type").notNull(),
  requirementLevel: requirementLevelEnum("requirement_level").notNull(),
  evidenceQuote: text("evidence_quote"),
  extractionModel: text("extraction_model").notNull(),
  extractionSourceDescriptionHash: text("extraction_source_description_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
