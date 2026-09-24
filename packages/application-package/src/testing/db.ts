import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDbClient, createDbClient, type DbClient } from "@ai-career/db";

// packages/application-package/src/testing -> packages/db/migrations
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";

export interface TestDb {
  adminSql: postgres.Sql;
  db: DbClient;
  close(): Promise<void>;
}

// Same advisory-lock rationale as packages/resume-optimization/src/testing/db.ts.
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

/** Deletes in FK-dependency order, scoped to one user (other suites share the database concurrently). */
export async function wipeUser(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM application_pitches WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM company_research WHERE user_id = ${userId}`; // cascades company_research_facts
  await adminSql`DELETE FROM job_requirements WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_matches WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_postings WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_sources WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM career_goals WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM work_experience_bullets WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM work_experiences WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM achievements WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM projects WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM certifications WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM education WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM skills WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM candidate_profiles WHERE user_id = ${userId}`;
}
