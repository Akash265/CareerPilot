import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// apps/web/src/test -> packages/db/migrations
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/migrations");
const MIGRATION_LOCK = 7420001;

/**
 * Superuser connection for seeding/inspecting/wiping (bypasses RLS -- never use it for behavior under
 * test). Migrates the shared test database under an advisory lock, because vitest and turbo run test
 * files and packages concurrently against the same database.
 */
export async function openAdminDb(): Promise<postgres.Sql> {
  const adminSql = postgres(
    process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test"
  );
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
  return adminSql;
}

/** Scoped to one user id, since other suites use the same database at the same time. */
export async function wipeJobData(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_sources WHERE user_id = ${userId}`;
}

export async function insertSource(
  adminSql: postgres.Sql,
  userId: string,
  opts: { kind?: "greenhouse" | "lever" | "upload"; label?: string; slug?: string; enabled?: boolean; consent?: boolean } = {}
): Promise<string> {
  const kind = opts.kind ?? "greenhouse";
  const config = kind === "upload" ? {} : { slug: opts.slug ?? `b-${Math.random().toString(36).slice(2, 10)}` };
  const [row] = await adminSql`
    INSERT INTO job_sources (user_id, kind, label, config, enabled, consent_confirmed_at)
    VALUES (${userId}, ${kind}, ${opts.label ?? "Acme"}, ${JSON.stringify(config)}::jsonb,
            ${opts.enabled ?? false}, ${(opts.consent ?? false) ? new Date().toISOString() : null}::timestamptz)
    RETURNING id`;
  return row.id as string;
}
