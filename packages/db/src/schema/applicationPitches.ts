import { sql } from "drizzle-orm";
import {
  pgTable, pgEnum, uuid, text, integer, boolean, jsonb, timestamp, uniqueIndex, check, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { companyResearch, companyResearchStatusEnum } from "./companyResearch";

export const applicationPitchOriginEnum = pgEnum("application_pitch_origin", ["generated", "user_edited"]);

/**
 * One row per generated or user-edited version; never updated in place. version increments per
 * (user_id, job_id) under an advisory lock (packages/application-package insertPitchVersion).
 * bullets: StoredPitchBullet[] -- exactly 3, ordered company, role, candidate (CHECK below):
 * [{ kind, text, supported: boolean | null (null = user_edited), unsupportedReason: string | null,
 *    evidence: [{ id, kind: "research"|"requirement"|"profile", text, sourceUrl: string | null }] }].
 * evidence[].text is a snapshot copy so an old pitch stays auditable after a research refresh or a
 * profile change. researchStatusSnapshot/researchedAtSnapshot record the research used at the time.
 */
export const applicationPitches = pgTable(
  "application_pitches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    origin: applicationPitchOriginEnum("origin").notNull(),
    parentPitchId: uuid("parent_pitch_id").references((): AnyPgColumn => applicationPitches.id, { onDelete: "set null" }),
    companyResearchId: uuid("company_research_id").references(() => companyResearch.id, { onDelete: "set null" }),
    researchStatusSnapshot: companyResearchStatusEnum("research_status_snapshot").notNull(),
    researchedAtSnapshot: timestamp("researched_at_snapshot", { withTimezone: true }),
    bullets: jsonb("bullets").notNull(),
    requiresReview: boolean("requires_review").notNull(),
    sourceProfileContentHash: text("source_profile_content_hash"),
    generationModel: text("generation_model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userJobVersionUniq: uniqueIndex("application_pitches_user_job_version_uniq").on(t.userId, t.jobId, t.version),
    versionPositive: check("application_pitches_version_positive", sql`${t.version} >= 1`),
    // CASE, not AND: Postgres does not guarantee AND short-circuits, and jsonb_array_length raises on a non-array.
    bulletsAreThree: check(
      "application_pitches_bullets_three",
      sql`CASE WHEN jsonb_typeof(${t.bullets}) = 'array' THEN jsonb_array_length(${t.bullets}) = 3 ELSE false END`
    ),
  })
);
