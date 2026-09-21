import { sql } from "drizzle-orm";
import { pgTable, uuid, integer, boolean, text, timestamp } from "drizzle-orm/pg-core";
import { jobSources, ingestionRunStatusEnum } from "./jobSources";

// One row per fetch attempt. Only `complete = true` runs may close jobs.
export const ingestionRuns = pgTable("ingestion_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => jobSources.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: ingestionRunStatusEnum("status").notNull().default("running"),
  complete: boolean("complete").notNull().default(false),
  fetchedCount: integer("fetched_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  unchangedCount: integer("unchanged_count").notNull().default(0),
  closedCount: integer("closed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  errorClass: text("error_class"),
});
