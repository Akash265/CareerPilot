import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDbClient, createDbClient, type DbClient } from "@ai-career/db";

// packages/ingestion/src/testing -> packages/db/migrations
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";

export interface TestDb {
  /** Superuser connection: seeds, inspects and wipes. Bypasses RLS -- never use it for behavior under test. */
  adminSql: postgres.Sql;
  /** App-role client: what the code under test uses, RLS enforced. */
  db: DbClient;
  close(): Promise<void>;
}

// Test files and packages run concurrently against one shared database. On an empty database two
// simultaneous migrate() calls collide creating the same enum type ("pg_type_typname_nsp_index"), so
// migration is serialized with an advisory lock. (CI additionally migrates once before the tests.)
const MIGRATION_LOCK = 7420001;

export async function openTestDb(): Promise<TestDb> {
  const adminSql = postgres(ADMIN_URL);
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
  const db = createDbClient({ DATABASE_URL: APP_URL });
  return {
    adminSql,
    db,
    close: async () => {
      await closeDbClient(db);
      await adminSql.end();
    },
  };
}

/** Scoped to one user id: turbo/vitest run suites concurrently against the shared test database. */
export async function wipeUser(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_sources WHERE user_id = ${userId}`;
}

export async function insertSource(
  adminSql: postgres.Sql,
  userId: string,
  opts: { kind?: "greenhouse" | "lever" | "upload"; label?: string; slug?: string; enabled?: boolean; consent?: boolean } = {}
): Promise<string> {
  const kind = opts.kind ?? "greenhouse";
  const config = kind === "upload" ? {} : { slug: opts.slug ?? `board-${Math.random().toString(36).slice(2, 10)}` };
  const [row] = await adminSql`
    INSERT INTO job_sources (user_id, kind, label, config, enabled, consent_confirmed_at)
    VALUES (${userId}, ${kind}, ${opts.label ?? "Acme"}, ${JSON.stringify(config)}::jsonb,
            ${opts.enabled ?? true}, ${(opts.consent ?? true) ? new Date().toISOString() : null}::timestamptz)
    RETURNING id`;
  return row.id as string;
}
