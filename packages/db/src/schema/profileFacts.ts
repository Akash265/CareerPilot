import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, pgEnum, vector } from "drizzle-orm/pg-core";

export const profileFactSourceTypeEnum = pgEnum("profile_fact_source_type", [
  "education", "work_experience_bullet", "skill", "project", "certification", "achievement",
]);

// voyage-3.5's output dimension (VOYAGE_EMBEDDING_MODEL, see .env.example).
// If that env var is ever changed to a model with a different output size,
// this constant and the migration generated from it must be updated first —
// pgvector's vector(n) column has a fixed dimension.
export const PROFILE_FACT_EMBEDDING_DIMENSIONS = 1024;

export const profileFacts = pgTable("profile_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  sourceType: profileFactSourceTypeEnum("source_type").notNull(),
  // App-enforced polymorphic reference (paired with sourceType), not a DB
  // foreign key — Postgres can't FK one column to different target tables
  // by discriminator (DECISIONS.md D14).
  sourceId: uuid("source_id").notNull().unique(),
  factText: text("fact_text").notNull(),
  embedding: vector("embedding", { dimensions: PROFILE_FACT_EMBEDDING_DIMENSIONS }),
  embeddingModel: text("embedding_model"),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
