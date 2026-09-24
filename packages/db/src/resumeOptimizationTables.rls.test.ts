import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { withUserContext } from "./rls";
import { createDbClient } from "./client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const adminSql = postgres(ADMIN_URL);
const db = createDbClient({ DATABASE_URL: APP_URL });

const USER_A = "00000000-0000-0000-0000-0000000000f3";
const USER_B = "00000000-0000-0000-0000-0000000000f4";
const TABLES = ["job_requirements", "resume_optimizations", "ats_evaluations"] as const;
// Same lock id as every other suite's migrate(): parallel migrate() on an empty DB races
// (packages/db/src/applicationPackageTables.rls.test.ts's beforeAll).
const MIGRATION_LOCK = 7420001;

async function wipe() {
  // Delete FK-children first.
  await adminSql`DELETE FROM ats_evaluations WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM resume_optimizations WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM job_requirements WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM jobs WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM career_goals WHERE user_id IN (${USER_A}, ${USER_B})`;
}

beforeAll(async () => {
  const lock = await adminSql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
    await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
    await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  } finally {
    await lock`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    lock.release();
  }
  await wipe();
});

afterAll(async () => {
  await wipe();
  await adminSql.end();
});

async function seedUserA(): Promise<void> {
  const [goal] = await adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER_A}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER_A}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  await adminSql`
    INSERT INTO job_requirements (user_id, job_id, term_text, term_type, requirement_level, extraction_model, extraction_source_description_hash)
    VALUES (${USER_A}, ${job.id}, 'SQL', 'skill', 'required', 'test-model', 'dh')`;
  const [optimization] = await adminSql`
    INSERT INTO resume_optimizations (
      user_id, job_id, career_goal_id, version, source_profile_content_hash,
      selected_bullets, added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model
    )
    VALUES (
      ${USER_A}, ${job.id}, ${goal.id}, 1, 'ph',
      '[]'::jsonb, '{}', '{}', false, '[]'::jsonb, 'test-model'
    ) RETURNING id`;
  await adminSql`
    INSERT INTO ats_evaluations (
      user_id, resume_optimization_id, required_keyword_coverage, preferred_keyword_coverage,
      semantic_similarity, factual_consistency, action_verb_score, machine_readability_score, overall_score, evaluator_version
    )
    VALUES (
      ${USER_A}, ${optimization.id}, 1, 0.5, 0.8, 1, 1, 1, 92.5, 'v1'
    )`;
}

describe("resume optimization tables — RLS", () => {
  it("isolates job_requirements, resume_optimizations, and ats_evaluations by user_id", async () => {
    await seedUserA();
    for (const table of TABLES) {
      const asA = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      const asB = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      expect((asA as unknown as { n: number }[])[0].n, `${table} as A`).toBeGreaterThan(0);
      expect((asB as unknown as { n: number }[])[0].n, `${table} as B`).toBe(0);
    }
  });

  it("prevents user B from reading user A's rows by id even when the id is known", async () => {
    await wipe();
    await seedUserA();
    const [job] = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT id FROM jobs LIMIT 1`)) as unknown as { id: string }[];
    const [optimization] = await withUserContext(db, USER_A, (tx) =>
      tx.execute(sql`SELECT id FROM resume_optimizations LIMIT 1`)
    ) as unknown as { id: string }[];

    const requirementsAsB = await withUserContext(db, USER_B, (tx) =>
      tx.execute(sql`SELECT id FROM job_requirements WHERE job_id = ${job.id}`)
    );
    expect(requirementsAsB).toHaveLength(0);

    const optimizationsAsB = await withUserContext(db, USER_B, (tx) =>
      tx.execute(sql`SELECT id FROM resume_optimizations WHERE job_id = ${job.id}`)
    );
    expect(optimizationsAsB).toHaveLength(0);

    const evaluationsAsB = await withUserContext(db, USER_B, (tx) =>
      tx.execute(sql`SELECT id FROM ats_evaluations WHERE resume_optimization_id = ${optimization.id}`)
    );
    expect(evaluationsAsB).toHaveLength(0);
  });
});
