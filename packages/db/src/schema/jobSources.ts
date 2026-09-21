import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, jsonb, boolean, timestamp } from "drizzle-orm/pg-core";

export const jobSourceKindEnum = pgEnum("job_source_kind", ["greenhouse", "lever", "upload"]);
export const ingestionRunStatusEnum = pgEnum("ingestion_run_status", ["running", "succeeded", "failed"]);

// The watch-list. `consent_confirmed_at` is the D3 gate: the worker refuses to
// run a source where it is null. A partial unique index (custom migration)
// prevents adding the same board twice.
export const jobSources = pgTable("job_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  kind: jobSourceKindEnum("kind").notNull(),
  label: text("label").notNull(),
  config: jsonb("config").$type<{ slug?: string; companyName?: string }>().notNull().default(sql`'{}'::jsonb`),
  enabled: boolean("enabled").notNull().default(false),
  consentConfirmedAt: timestamp("consent_confirmed_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastRunStatus: ingestionRunStatusEnum("last_run_status"),
  // An error CLASS only (D29) -- never a message that could carry posting content.
  lastErrorClass: text("last_error_class"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
