import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { jobs, jobStatusEnum } from "./jobs";
import { jobSources } from "./jobSources";

// One row per source appearance of a job. `normalized` is the NormalizedJob
// snapshot the canonical job is recomputed from; `fingerprint` drives tier-2
// identity; `content_hash` (of the raw payload) lets unchanged records skip
// the pipeline.
export const jobPostings = pgTable(
  "job_postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => jobSources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    url: text("url"),
    fingerprint: text("fingerprint").notNull(),
    contentHash: text("content_hash").notNull(),
    normalized: jsonb("normalized").notNull(),
    status: jobStatusEnum("status").notNull().default("open"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    sourceExternalUniq: uniqueIndex("job_postings_source_external_uniq").on(t.sourceId, t.externalId),
  })
);
