import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";

export const skillVerificationStatusEnum = pgEnum("skill_verification_status", ["have", "dont_have", "alias"]);
export type SkillVerificationStatus = (typeof skillVerificationStatusEnum.enumValues)[number];

/**
 * Phase 13b: the user's answer to "this job requires <term>; do you have it?", one row per normalized term
 * (normalizeTermKey in @ai-career/resume-optimization). Deliberately separate from `skills`: saveProfile deletes and
 * re-inserts every skills row, so an answer stored there would be lost on the next profile edit. An alias names the
 * profile skill by name, not id, for the same reason. "have" rows (and live aliases) become `verified_skill`
 * entries in the resume evidence catalog (buildResumeSnapshot).
 */
export const skillVerifications = pgTable(
  "skill_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    termKey: text("term_key").notNull(),
    termDisplay: text("term_display").notNull(),
    status: skillVerificationStatusEnum("status").notNull(),
    evidence: text("evidence"),
    aliasSkillName: text("alias_skill_name"),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userTermUniq: uniqueIndex("skill_verifications_user_term_uniq").on(t.userId, t.termKey),
    fieldsMatchStatus: check(
      "skill_verifications_fields_match_status",
      sql`(${t.status} = 'have' AND ${t.evidence} IS NOT NULL AND ${t.aliasSkillName} IS NULL)
        OR (${t.status} = 'dont_have' AND ${t.evidence} IS NULL AND ${t.aliasSkillName} IS NULL)
        OR (${t.status} = 'alias' AND ${t.evidence} IS NULL AND ${t.aliasSkillName} IS NOT NULL)`
    ),
    evidenceLength: check(
      "skill_verifications_evidence_length",
      sql`${t.evidence} IS NULL OR char_length(btrim(${t.evidence})) BETWEEN 1 AND 300`
    ),
    termLength: check(
      "skill_verifications_term_length",
      sql`char_length(${t.termKey}) BETWEEN 1 AND 200 AND char_length(btrim(${t.termDisplay})) BETWEEN 1 AND 200`
    ),
    aliasLength: check(
      "skill_verifications_alias_length",
      sql`${t.aliasSkillName} IS NULL OR char_length(btrim(${t.aliasSkillName})) BETWEEN 1 AND 200`
    ),
  })
);
