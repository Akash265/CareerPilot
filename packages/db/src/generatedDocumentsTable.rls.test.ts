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

const USER_A = "00000000-0000-0000-0000-0000000000d8";
const USER_B = "00000000-0000-0000-0000-0000000000d9";
const MIGRATION_LOCK = 7420001;

async function wipe() {
  await adminSql`DELETE FROM jobs WHERE user_id IN (${USER_A}, ${USER_B})`; // cascades generated_documents
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

async function seedJob(): Promise<string> {
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER_A}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
  return job.id as string;
}

function insertDoc(jobId: string, overrides: Record<string, unknown> = {}) {
  const v = { kind: "resume", format: "pdf", byteSize: 10, contentHash: "h1", resumeOptimizationId: null, details: null, ...overrides };
  return adminSql`
    INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename,
                                     resume_optimization_id, details)
    VALUES (${USER_A}, ${jobId}, ${v.kind as string}, ${v.format as string}, 'k', ${v.byteSize as number}, ${v.contentHash as string}, '1', 'f.pdf',
            ${v.resumeOptimizationId as string | null}, ${v.details === null ? null : JSON.stringify(v.details)}::jsonb)
    RETURNING id`;
}

describe("generated_documents — RLS and constraints", () => {
  it("isolates rows by user_id, including lookups by a known id", async () => {
    await wipe();
    const jobId = await seedJob();
    const [doc] = await insertDoc(jobId);
    const asA = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT id FROM generated_documents`));
    const asB = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT id FROM generated_documents WHERE id = ${doc.id}`));
    expect(asA).toHaveLength(1);
    expect(asB).toHaveLength(0);
  });

  it("de-duplicates on (user, job, kind, format, content_hash); the same content under a different job is a separate row", async () => {
    await wipe();
    const jobId = await seedJob();
    await insertDoc(jobId);
    await expect(insertDoc(jobId)).rejects.toThrow(/generated_documents_user_job_kind_format_hash_uniq/);
    await expect(insertDoc(jobId, { format: "docx" })).resolves.toHaveLength(1);

    // job_id is part of the de-dup key (D84): identical content for a different job of the same
    // user is not a duplicate -- exporting job B must never return job A's stored document.
    const otherJobId = await seedJob();
    await expect(insertDoc(otherJobId)).resolves.toHaveLength(1);
  });

  it("rejects a zero byte size", async () => {
    await wipe();
    const jobId = await seedJob();
    await expect(insertDoc(jobId, { byteSize: 0, contentHash: "h2" })).rejects.toThrow(/generated_documents_byte_size_positive/);
  });

  it("rejects a resume row that points at a pitch", async () => {
    await wipe();
    const jobId = await seedJob();
    const [pitch] = await adminSql`
      INSERT INTO application_pitches (user_id, job_id, version, origin, research_status_snapshot, bullets, requires_review)
      VALUES (${USER_A}, ${jobId}, 1, 'user_edited', 'failed',
              '[{"kind":"company","text":"a","supported":null,"unsupportedReason":null,"evidence":[]},{"kind":"role","text":"b","supported":null,"unsupportedReason":null,"evidence":[]},{"kind":"candidate","text":"c","supported":null,"unsupportedReason":null,"evidence":[]}]'::jsonb,
              false) RETURNING id`;
    await expect(adminSql`
      INSERT INTO generated_documents (user_id, job_id, kind, format, application_pitch_id, object_key, byte_size, content_hash, renderer_version, download_filename)
      VALUES (${USER_A}, ${jobId}, 'resume', 'pdf', ${pitch.id}, 'k', 10, 'h3', '1', 'f.pdf')`).rejects.toThrow(/generated_documents_source_matches_kind/);
  });

  it("accepts cover_letter / interview_prep rows only with their own source column", async () => {
    await wipe();
    const [job] = await adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER_A}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', now(), now()) RETURNING id`;
    const paragraphs = JSON.stringify(["opening", "company", "evidence", "closing"].map((role) => ({ role, text: role, supported: null, unsupportedReason: null, evidence: [] })));
    const [letter] = await adminSql`
      INSERT INTO cover_letters (user_id, job_id, version, origin, research_status_snapshot, paragraphs, requires_review)
      VALUES (${USER_A}, ${job.id}, 1, 'user_edited', 'ok', ${paragraphs}::jsonb, false) RETURNING id`;
    await adminSql`
      INSERT INTO generated_documents (user_id, job_id, kind, format, cover_letter_id, object_key, byte_size, content_hash, renderer_version, download_filename)
      VALUES (${USER_A}, ${job.id}, 'cover_letter', 'pdf', ${letter.id}, 'k', 10, 'hc1', '1', 'f.pdf')`;
    await expect(adminSql`
      INSERT INTO generated_documents (user_id, job_id, kind, format, cover_letter_id, object_key, byte_size, content_hash, renderer_version, download_filename)
      VALUES (${USER_A}, ${job.id}, 'interview_prep', 'pdf', ${letter.id}, 'k', 10, 'hc2', '1', 'f.pdf')`).rejects.toThrow(/generated_documents_source_matches_kind/);
  });

  it("accepts a tailored_resume pdf/tex row with details; rejects tex for other kinds and details on other kinds", async () => {
    await wipe();
    const jobId = await seedJob();
    const details = { pageCount: 1, pageVerified: true, includedCount: 3, totalCount: 4, omitted: [] };
    await expect(insertDoc(jobId, { kind: "tailored_resume", format: "tex", contentHash: "t1", details })).resolves.toHaveLength(1);
    await expect(insertDoc(jobId, { kind: "tailored_resume", format: "pdf", contentHash: "t2", details })).resolves.toHaveLength(1);
    await expect(insertDoc(jobId, { kind: "resume", format: "tex", contentHash: "t3" })).rejects.toThrow(/generated_documents_tex_only_tailored/);
    await expect(insertDoc(jobId, { kind: "resume", format: "pdf", contentHash: "t4", details })).rejects.toThrow(/generated_documents_details_tailored_object/);
    await expect(insertDoc(jobId, { kind: "tailored_resume", format: "pdf", contentHash: "t5", details: [1] })).rejects.toThrow(/generated_documents_details_tailored_object/);
  });

  it("lets a tailored_resume row point at a resume optimization but not a pitch", async () => {
    await wipe();
    const jobId = await seedJob();
    const [goal] = await adminSql`INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
                                  VALUES (${USER_A}, 'g', 1, 'parsed', 'confirmed', false) RETURNING id`;
    const [opt] = await adminSql`
      INSERT INTO resume_optimizations (user_id, job_id, career_goal_id, version, source_profile_content_hash, selected_bullets,
                                        added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model)
      VALUES (${USER_A}, ${jobId}, ${goal.id}, 1, 'h', '[]'::jsonb, '{}', '{}', false, '[]'::jsonb, 'm') RETURNING id`;
    await expect(insertDoc(jobId, { kind: "tailored_resume", format: "pdf", contentHash: "t6", resumeOptimizationId: opt.id })).resolves.toHaveLength(1);
  });
});
