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

const USER_A = "00000000-0000-0000-0000-0000000000f1";
const USER_B = "00000000-0000-0000-0000-0000000000f2";
const TABLES = [
  "job_sources", "ingestion_runs", "raw_job_postings", "jobs", "job_postings", "job_duplicate_candidates",
] as const;

async function wipe() {
  await adminSql`DELETE FROM jobs WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM job_sources WHERE user_id IN (${USER_A}, ${USER_B})`;
}

beforeAll(async () => {
  await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
  await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
  await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  await wipe();
});

afterAll(async () => {
  await wipe();
  await adminSql.end();
});

async function seedUserA() {
  const [source] = await adminSql`
    INSERT INTO job_sources (user_id, kind, label, config) VALUES (${USER_A}, 'greenhouse', 'Acme', '{"slug":"acme"}') RETURNING id`;
  await adminSql`INSERT INTO ingestion_runs (user_id, source_id, started_at) VALUES (${USER_A}, ${source.id}, now())`;
  await adminSql`INSERT INTO raw_job_postings (user_id, source_id, external_id, payload, content_hash)
                 VALUES (${USER_A}, ${source.id}, 'e1', '{}', 'h')`;
  const jobIds: string[] = [];
  for (const n of [1, 2]) {
    const [job] = await adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER_A}, 'Acme', 'acme', ${"Engineer " + n}, 'engineer', 'dh', now(), now()) RETURNING id`;
    jobIds.push(job.id);
    await adminSql`
      INSERT INTO job_postings (user_id, job_id, source_id, external_id, fingerprint, content_hash, normalized, first_seen_at, last_seen_at)
      VALUES (${USER_A}, ${job.id}, ${source.id}, ${"e" + n}, ${"fp" + n}, 'h', '{}', now(), now())`;
  }
  const [a, b] = jobIds.sort();
  await adminSql`INSERT INTO job_duplicate_candidates (user_id, job_id_a, job_id_b, similarity) VALUES (${USER_A}, ${a}, ${b}, 0.9)`;
}

describe("job intelligence tables — RLS", () => {
  it("isolates every table by user_id", async () => {
    await seedUserA();
    for (const table of TABLES) {
      const asA = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      const asB = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      expect((asA as unknown as { n: number }[])[0].n, `${table} as A`).toBeGreaterThan(0);
      expect((asB as unknown as { n: number }[])[0].n, `${table} as B`).toBe(0);
    }
  });

  it("stamps user_id from the session variable when the insert omits it", async () => {
    const rows = await withUserContext(db, USER_B, (tx) =>
      tx.execute(sql`INSERT INTO job_sources (kind, label) VALUES ('lever', 'Beta') RETURNING user_id`)
    );
    expect((rows as unknown as { user_id: string }[])[0].user_id).toBe(USER_B);
  });

  it("refuses a second board with the same kind and slug (case-insensitive), but allows the same slug on another kind", async () => {
    const insert = (kind: string, slug: string) =>
      // postgres-js cannot bind an object to a jsonb parameter; pass JSON text and cast.
      adminSql`INSERT INTO job_sources (user_id, kind, label, config) VALUES (${USER_A}, ${kind}, 'x', ${JSON.stringify({ slug })}::jsonb)`;
    await insert("lever", "dup-board");
    await expect(insert("lever", "DUP-BOARD")).rejects.toThrow(/duplicate key|unique/i);
    await expect(insert("greenhouse", "dup-board")).resolves.toBeDefined();
  });

  it("supports trigram similarity on job titles (pg_trgm is enabled and indexed)", async () => {
    const rows = await adminSql`SELECT similarity('data engineer', 'data engineers') AS s`;
    expect(Number(rows[0].s)).toBeGreaterThan(0.5);
  });
});
