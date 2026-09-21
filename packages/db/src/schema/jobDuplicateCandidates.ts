import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, real, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";

export const duplicateCandidateStatusEnum = pgEnum("duplicate_candidate_status", ["pending", "same", "different"]);

// Trigram near-matches. Never auto-merged: a false merge hides a real job, a
// false split only shows one extra row. Phase 4 writes `pending` only. The
// pair is stored with job_id_a < job_id_b so the unique index de-duplicates it.
export const jobDuplicateCandidates = pgTable(
  "job_duplicate_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobIdA: uuid("job_id_a")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    jobIdB: uuid("job_id_b")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    similarity: real("similarity").notNull(),
    status: duplicateCandidateStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUniq: uniqueIndex("job_duplicate_candidates_pair_uniq").on(t.jobIdA, t.jobIdB),
  })
);
