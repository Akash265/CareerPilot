import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Client } from "minio";
import { closeDbClient, createDbClient, type DbClient } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import type { AppliedBullet } from "@ai-career/resume-optimization";

// packages/document-export/src/testing -> packages/db/migrations
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const MIGRATION_LOCK = 7420001;

export interface TestDb {
  adminSql: postgres.Sql;
  db: DbClient;
  close(): Promise<void>;
}

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
  return { adminSql, db, close: async () => { await closeDbClient(db); await adminSql.end(); } };
}

export function testStorageClient(): Client {
  return createStorageClient({
    MINIO_ENDPOINT: process.env.TEST_MINIO_ENDPOINT ?? "http://localhost:9000",
    MINIO_ACCESS_KEY: process.env.TEST_MINIO_ACCESS_KEY ?? "minioadmin",
    MINIO_SECRET_KEY: process.env.TEST_MINIO_SECRET_KEY ?? "minioadmin",
  });
}

/** User-scoped; application_pitches / cover_letters / interview_preparations / generated_documents /
 *  resume_optimizations cascade from jobs. */
export async function wipeUser(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM skill_verifications WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
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

/** A confirmed profile (contact, one role with two bullets, one skill), a goal and a job at "GitLab". */
export async function seedResumeFixture(testDb: TestDb, userId: string): Promise<{ jobId: string; goalId: string; bulletIds: string[] }> {
  const s = testDb.adminSql;
  await s`INSERT INTO candidate_profiles (user_id, full_name, email, phone_number, address_line1)
          VALUES (${userId}, 'Jane Doe', 'jane@example.com', '+49 1', '1 Secret Street')`;
  const [exp] = await s`INSERT INTO work_experiences (user_id, company, title, start_date, display_order)
                        VALUES (${userId}, 'Globex', 'Engineer', '2021', 0) RETURNING id`;
  const bullets = await s`INSERT INTO work_experience_bullets (user_id, work_experience_id, text, display_order)
                          VALUES (${userId}, ${exp.id}, 'Built A', 0), (${userId}, ${exp.id}, 'Built B', 1) RETURNING id`;
  await s`INSERT INTO skills (user_id, name, display_order) VALUES (${userId}, 'Python', 0)`;
  const [goal] = await s`INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
                         VALUES (${userId}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await s`INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
                        VALUES (${userId}, 'GitLab', 'gitlab', 'Backend Engineer', 'backend engineer', 'dh', now(), now()) RETURNING id`;
  return { jobId: job.id as string, goalId: goal.id as string, bulletIds: bullets.map((b) => b.id as string) };
}

export async function insertOptimization(
  testDb: TestDb, userId: string, jobId: string, goalId: string, selectedBullets: AppliedBullet[], sourceProfileContentHash: string
): Promise<string> {
  const [row] = await testDb.adminSql`
    INSERT INTO resume_optimizations (user_id, job_id, career_goal_id, version, source_profile_content_hash, selected_bullets,
                                      added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model)
    VALUES (${userId}, ${jobId}, ${goalId}, 1, ${sourceProfileContentHash}, ${JSON.stringify(selectedBullets)}::jsonb,
            '{}', '{}', false, ${JSON.stringify([{ sourceFactId: "rejected-1", reason: "REJECTED CLAIM" }])}::jsonb, 'm')
    RETURNING id`;
  return row.id as string;
}

export async function insertRequirement(
  testDb: TestDb, userId: string, jobId: string, termText: string, level: "required" | "preferred"
): Promise<void> {
  await testDb.adminSql`
    INSERT INTO job_requirements (user_id, job_id, term_text, term_type, requirement_level, extraction_model, extraction_source_description_hash)
    VALUES (${userId}, ${jobId}, ${termText}, 'skill', ${level}, 'm', 'dh')`;
}
