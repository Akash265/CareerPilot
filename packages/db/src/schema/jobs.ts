import { sql } from "drizzle-orm";
import {
  pgTable, pgEnum, uuid, text, integer, numeric, boolean, jsonb, timestamp, vector,
} from "drizzle-orm/pg-core";

export const jobStatusEnum = pgEnum("job_status", ["open", "closed"]);
export const jobWorkModeEnum = pgEnum("job_work_mode", ["remote", "hybrid", "onsite", "unknown"]);
export const jobSponsorshipEnum = pgEnum("job_sponsorship", ["offered", "not_offered", "unknown"]);
export const salaryPeriodEnum = pgEnum("salary_period", ["year", "month", "hour"]);

// Canonical job with a persistent identity. Rows are (re)computed from the
// job's postings by packages/ingestion's pure mergePostings; `field_provenance`
// records which posting supplied each field group.
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),

  companyName: text("company_name").notNull(),
  companyKey: text("company_key").notNull(),
  title: text("title").notNull(),
  titleKey: text("title_key").notNull(),
  seniority: text("seniority"),

  locationRaw: text("location_raw"),
  locationKey: text("location_key").notNull().default(""),
  // Only when the source states it structurally (Lever); Greenhouse leaves this null.
  countryCode: text("country_code"),
  workMode: jobWorkModeEnum("work_mode").notNull().default("unknown"),
  employmentType: text("employment_type"),

  // Sanitized plain text. Untrusted input: never interpreted as HTML.
  descriptionText: text("description_text").notNull().default(""),
  descriptionHash: text("description_hash").notNull(),

  // D6: raw + normalized + currency + period + is_parsed. Missing is null, never zero.
  salaryRaw: text("salary_raw"),
  salaryMin: numeric("salary_min"),
  salaryMax: numeric("salary_max"),
  salaryCurrency: text("salary_currency"),
  salaryPeriod: salaryPeriodEnum("salary_period"),
  salaryIsParsed: boolean("salary_is_parsed").notNull().default(false),

  minExperienceYears: integer("min_experience_years"),
  minExperienceEvidence: text("min_experience_evidence"),
  sponsorship: jobSponsorshipEnum("sponsorship").notNull().default("unknown"),
  sponsorshipEvidence: text("sponsorship_evidence"),
  sponsorshipConflict: boolean("sponsorship_conflict").notNull().default(false),

  postedAt: timestamp("posted_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull(),

  status: jobStatusEnum("status").notNull().default("open"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  fieldProvenance: jsonb("field_provenance").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),

  // Phase 5: title + descriptionText embedding for hybrid semantic retrieval. Nullable until a
  // matching run first generates it (packages/matching/src/embeddings/ensureJobEmbeddings.ts).
  // Same 1024-dim convention as profile_facts.embedding.
  embedding: vector("embedding", { dimensions: 1024 }),
  // The descriptionHash this embedding was generated from -- a permanent, content-hash-keyed cache,
  // same pattern as profile_facts (D-line52). Regenerated only when descriptionHash no longer matches.
  embeddingContentHash: text("embedding_content_hash"),
  embeddingModel: text("embedding_model"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
