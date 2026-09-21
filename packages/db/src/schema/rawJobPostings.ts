import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { jobSources } from "./jobSources";

// Latest source payload per (source, external id) -- a snapshot, not a history.
// Kept so normalizer/parser improvements can be re-run without refetching, and
// so postings that vanish from a source's API stay debuggable.
export const rawJobPostings = pgTable(
  "raw_job_postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => jobSources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    payload: jsonb("payload").notNull(),
    contentHash: text("content_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceExternalUniq: uniqueIndex("raw_job_postings_source_external_uniq").on(t.sourceId, t.externalId),
  })
);
