import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { jobSourceKindEnum, jobSources } from "./jobSources";

export const discoveredBoardStatusEnum = pgEnum("discovered_board_status", ["pending", "enabled", "rejected", "gone"]);
export const boardFoundViaEnum = pgEnum("board_found_via", ["posting_link", "pasted", "name_probe", "web_search"]);

/**
 * Phase 12 (D186). A company job board found in a posting's links (or pasted by the user). It is validated
 * by one fetch, then becomes a job_sources row (`source_id`); a board that does not exist or has no jobs is
 * `rejected`, one that later disappears is `gone`. One row per (user, kind, slug) -- see the custom migration.
 */
export const discoveredBoards = pgTable(
  "discovered_boards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    kind: jobSourceKindEnum("kind").notNull(),
    slug: text("slug").notNull(),
    status: discoveredBoardStatusEnum("status").notNull().default("pending"),
    /** The source whose posting linked to this board; null for a pasted board or once that source is deleted. */
    foundViaSourceId: uuid("found_via_source_id").references(() => jobSources.id, { onDelete: "set null" }),
    sourceId: uuid("source_id").references(() => jobSources.id, { onDelete: "set null" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    /** Phase 13a: how the board was found. Pasted boards are the user's own choice (see validatePendingBoards). */
    foundVia: boardFoundViaEnum("found_via").notNull().default("posting_link"),
    /** Phase 13a: the employer a probed or web-searched board is expected to belong to (checked on validation). */
    expectedCompany: text("expected_company"),
    /** Phase 13a: a fixed code when rejected (company_mismatch, company_unverified, or the fetch's error class). */
    rejectReason: text("reject_reason"),
  },
  (t) => ({
    // Phase 11c (D181): one index per foreign key, so a change to the parent row never scans this table.
    foundViaSourceIdFkIdx: index("discovered_boards_found_via_source_id_idx").on(t.foundViaSourceId).where(sql`${t.foundViaSourceId} IS NOT NULL`),
    sourceIdFkIdx: index("discovered_boards_source_id_idx").on(t.sourceId).where(sql`${t.sourceId} IS NOT NULL`),
    statusIdx: index("discovered_boards_user_status_idx").on(t.userId, t.status),
  })
);

/**
 * Phase 12 (D185). The standing consent that replaces D3's per-source checkbox for discovered and search
 * sources: nothing in discovery runs until `consented_at` is set.
 */
export const discoverySettings = pgTable("discovery_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  autoDiscover: boolean("auto_discover").notNull().default(false),
  consentedAt: timestamp("consented_at", { withTimezone: true }),
  /** Phase 13a: when the goal-driven web search last completed, and for which goal constraints row. */
  lastWebSearchAt: timestamp("last_web_search_at", { withTimezone: true }),
  lastWebSearchGoalId: uuid("last_web_search_goal_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
