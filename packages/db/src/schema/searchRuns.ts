import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { careerGoalConstraints } from "./careerGoalConstraints";

export const searchRunStatusEnum = pgEnum("search_run_status", ["queued", "running", "matching", "completed", "failed"]);
export type SearchRunStatus = (typeof searchRunStatusEnum.enumValues)[number];

/** One source's part in a run. `reason` is always a fixed code (an ingestion error class), never provider text. */
export interface SearchRunSource {
  sourceId: string;
  name: string;
  kind: string;
  state: "reused" | "queued" | "running" | "done" | "failed" | "late";
  reason?: string;
  newCount?: number;
}

export interface SearchRunSeeding {
  probe?: { state: "ran" | "failed"; names: number; boardsQueued: number; reason?: string };
  webSearch?: {
    state: "ran" | "skipped_recent" | "skipped_disabled" | "skipped_budget" | "failed";
    boardsQueued: number;
    unsupported: number;
    reason?: string;
  };
}

/**
 * Phase 13a: one "Find matching jobs" click. Created by the web app (`queued`), driven by the coordinator worker in
 * services/job-ingestion. At most one non-terminal run per user (partial unique index, migration 0034).
 */
export const searchRuns = pgTable(
  "search_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    status: searchRunStatusEnum("status").notNull().default("queued"),
    goalConstraintsId: uuid("goal_constraints_id").references(() => careerGoalConstraints.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    sources: jsonb("sources").$type<SearchRunSource[]>().notNull().default([]),
    seeding: jsonb("seeding").$type<SearchRunSeeding>().notNull().default({}),
    errorCode: text("error_code"),
  },
  (t) => ({
    goalConstraintsIdFkIdx: index("search_runs_goal_constraints_id_idx").on(t.goalConstraintsId).where(sql`${t.goalConstraintsId} IS NOT NULL`),
    userCreatedIdx: index("search_runs_user_created_idx").on(t.userId, t.createdAt),
  })
);
