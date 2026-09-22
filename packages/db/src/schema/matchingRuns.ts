import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, integer, text, timestamp } from "drizzle-orm/pg-core";
import { careerGoals } from "./careerGoals";

export const matchingRunStatusEnum = pgEnum("matching_run_status", ["running", "completed", "failed"]);

/** One row per recompute, mirrors ingestion_runs (design doc §3). */
export const matchingRuns = pgTable("matching_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  careerGoalId: uuid("career_goal_id")
    .notNull()
    .references(() => careerGoals.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: matchingRunStatusEnum("status").notNull().default("running"),
  errorClass: text("error_class"),
  jobsEvaluated: integer("jobs_evaluated").notNull().default(0),
  jobsEligible: integer("jobs_eligible").notNull().default(0),
  jobsExplained: integer("jobs_explained").notNull().default(0),
});
