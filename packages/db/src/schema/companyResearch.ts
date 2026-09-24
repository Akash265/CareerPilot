import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, integer, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";

export const companyResearchStatusEnum = pgEnum("company_research_status", ["ok", "no_results", "failed"]);

/**
 * One row per (user, company) -- design doc §3. companyKey is jobs.companyKey (the Phase 4 identity);
 * two companies that normalize to the same key share research (accepted limitation). A refresh
 * upserts this row in place (same id) and replaces its facts. status: ok = >=1 cited web fact;
 * no_results = search ran, nothing cited; failed = API error / refusal (retried on the next pitch
 * request). errorCode is a short machine code only, never response text (no logging of content).
 */
export const companyResearch = pgTable(
  "company_research",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    companyKey: text("company_key").notNull(),
    companyName: text("company_name").notNull(),
    status: companyResearchStatusEnum("status").notNull(),
    errorCode: text("error_code"),
    researchModel: text("research_model"),
    searchCount: integer("search_count").notNull().default(0),
    researchedAt: timestamp("researched_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCompanyUniq: uniqueIndex("company_research_user_company_uniq").on(t.userId, t.companyKey),
    searchCountNonNegative: check("company_research_search_count_nonneg", sql`${t.searchCount} >= 0`),
  })
);
