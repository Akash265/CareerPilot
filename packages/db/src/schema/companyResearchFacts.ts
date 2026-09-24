import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { companyResearch } from "./companyResearch";

export const companyResearchSourceKindEnum = pgEnum("company_research_source_kind", ["web", "internal"]);

/**
 * web: one API-cited text block from the research call (sourceUrl is always http/https, validated
 * before insert); internal: a deterministic sentence derived from this company's jobs rows (no URL).
 * Replaced wholesale on refresh, so ids are not stable -- application_pitches snapshots the text it
 * cited instead of relying on these rows surviving.
 */
export const companyResearchFacts = pgTable("company_research_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  researchId: uuid("research_id")
    .notNull()
    .references(() => companyResearch.id, { onDelete: "cascade" }),
  sourceKind: companyResearchSourceKindEnum("source_kind").notNull(),
  factText: text("fact_text").notNull(),
  sourceUrl: text("source_url"),
  sourceTitle: text("source_title"),
  citedText: text("cited_text"),
  displayOrder: integer("display_order").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
