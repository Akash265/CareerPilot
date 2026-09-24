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

const USER_A = "00000000-0000-0000-0000-0000000000d2";
const USER_B = "00000000-0000-0000-0000-0000000000d3";
const TABLES = ["company_research", "company_research_facts", "application_pitches"] as const;
// Same lock id as every other suite's migrate(): parallel migrate() on an empty DB races.
const MIGRATION_LOCK = 7420001;

async function wipe() {
  // application_pitches cascade from jobs; company_research_facts cascade from company_research.
  await adminSql`DELETE FROM jobs WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM company_research WHERE user_id IN (${USER_A}, ${USER_B})`;
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

const BULLETS = JSON.stringify([
  { kind: "company", text: "c", supported: true, unsupportedReason: null, evidence: [] },
  { kind: "role", text: "r", supported: true, unsupportedReason: null, evidence: [] },
  { kind: "candidate", text: "p", supported: true, unsupportedReason: null, evidence: [] },
]);

async function seedUserA(): Promise<{ jobId: string; researchId: string; pitchId: string }> {
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER_A}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  const [research] = await adminSql`
    INSERT INTO company_research (user_id, company_key, company_name, status, research_model, search_count, researched_at)
    VALUES (${USER_A}, 'acme', 'Acme', 'ok', 'test-model', 2, now()) RETURNING id`;
  await adminSql`
    INSERT INTO company_research_facts (user_id, research_id, source_kind, fact_text, source_url, display_order)
    VALUES (${USER_A}, ${research.id}, 'web', 'Acme builds rockets.', 'https://acme.example', 0)`;
  const [pitch] = await adminSql`
    INSERT INTO application_pitches (user_id, job_id, version, origin, company_research_id, research_status_snapshot,
                                     researched_at_snapshot, bullets, requires_review, generation_model)
    VALUES (${USER_A}, ${job.id}, 1, 'generated', ${research.id}, 'ok', now(), ${BULLETS}::jsonb, false, 'test-model')
    RETURNING id`;
  return { jobId: job.id, researchId: research.id, pitchId: pitch.id };
}

describe("application package tables — RLS", () => {
  it("isolates company_research, company_research_facts and application_pitches by user_id", async () => {
    await wipe();
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
    const { jobId, researchId, pitchId } = await seedUserA();
    const research = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT id FROM company_research WHERE id = ${researchId}`));
    const facts = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT id FROM company_research_facts WHERE research_id = ${researchId}`));
    const pitches = await withUserContext(db, USER_B, (tx) =>
      tx.execute(sql`SELECT id FROM application_pitches WHERE id = ${pitchId} OR job_id = ${jobId}`)
    );
    expect(research).toHaveLength(0);
    expect(facts).toHaveLength(0);
    expect(pitches).toHaveLength(0);
  });

  it("rejects a pitch whose bullets array does not have exactly three entries", async () => {
    await wipe();
    const { jobId, researchId } = await seedUserA();
    await expect(adminSql`
      INSERT INTO application_pitches (user_id, job_id, version, origin, company_research_id, research_status_snapshot, bullets, requires_review)
      VALUES (${USER_A}, ${jobId}, 2, 'generated', ${researchId}, 'ok', '[]'::jsonb, false)`).rejects.toThrow(/application_pitches_bullets_three/);
    await expect(adminSql`
      INSERT INTO application_pitches (user_id, job_id, version, origin, company_research_id, research_status_snapshot, bullets, requires_review)
      VALUES (${USER_A}, ${jobId}, 2, 'generated', ${researchId}, 'ok', '{}'::jsonb, false)`).rejects.toThrow(/application_pitches_bullets_three/);
  });

  it("allows only one company_research row per (user, company_key)", async () => {
    await wipe();
    await seedUserA();
    await expect(adminSql`
      INSERT INTO company_research (user_id, company_key, company_name, status, search_count, researched_at)
      VALUES (${USER_A}, 'acme', 'Acme Inc', 'ok', 0, now())`).rejects.toThrow(/company_research_user_company_uniq/);
  });
});
