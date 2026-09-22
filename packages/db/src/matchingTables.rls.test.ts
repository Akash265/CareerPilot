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

const USER_A = "00000000-0000-0000-0000-0000000000f5";
const USER_B = "00000000-0000-0000-0000-0000000000f6";
const TABLES = ["job_matches", "matching_runs"] as const;

async function wipe() {
  await adminSql`DELETE FROM job_matches WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM matching_runs WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM jobs WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM career_goals WHERE user_id IN (${USER_A}, ${USER_B})`;
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

async function seedUserA(): Promise<void> {
  const [goal] = await adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER_A}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER_A}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  const [run] = await adminSql`
    INSERT INTO matching_runs (user_id, career_goal_id, started_at, status)
    VALUES (${USER_A}, ${goal.id}, now(), 'completed') RETURNING id`;
  await adminSql`
    INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, computed_at)
    VALUES (${USER_A}, ${job.id}, ${goal.id}, true, now())`;
  return run.id;
}

describe("matching tables — RLS", () => {
  it("isolates job_matches and matching_runs by user_id", async () => {
    await seedUserA();
    for (const table of TABLES) {
      const asA = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      const asB = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      expect((asA as unknown as { n: number }[])[0].n, `${table} as A`).toBeGreaterThan(0);
      expect((asB as unknown as { n: number }[])[0].n, `${table} as B`).toBe(0);
    }
  });

  it("enforces one job_matches row per (user_id, job_id)", async () => {
    await wipe();
    await seedUserA();
    const [job] = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT id FROM jobs LIMIT 1`)) as unknown as { id: string }[];
    const [goal] = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT id FROM career_goals LIMIT 1`)) as unknown as { id: string }[];
    await expect(
      withUserContext(db, USER_A, (tx) =>
        tx.execute(sql`INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, computed_at)
                        VALUES (${USER_A}, ${job.id}, ${goal.id}, true, now())`)
      )
    ).rejects.toThrow();
  });

  it("defaults job_matches.user_action to 'none'", async () => {
    await wipe();
    await seedUserA();
    const rows = await withUserContext(db, USER_A, (tx) =>
      tx.execute(sql`SELECT user_action FROM job_matches LIMIT 1`)
    ) as unknown as { user_action: string }[];
    expect(rows[0].user_action).toBe("none");
  });
});
