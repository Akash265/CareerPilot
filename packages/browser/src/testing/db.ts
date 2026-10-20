import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDbClient, createDbClient, type DbClient } from "@ai-career/db";

// packages/browser/src/testing -> packages/db/migrations
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
  return {
    adminSql,
    db,
    close: async () => {
      await closeDbClient(db);
      await adminSql.end();
    },
  };
}

/** Scoped to one user: other suites share the database concurrently. Sessions/documents/postings cascade from jobs. */
export async function wipeUser(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM applications WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_sources WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM career_goals WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM candidate_profiles WHERE user_id = ${userId}`;
}

export interface SeedAutofillOptions {
  sourceKind?: "greenhouse" | "lever" | "upload";
  slug?: string;
  externalId?: string;
  /** Default true. */
  withProfile?: boolean;
  /** Default { visaSponsorshipRequired: false, salary target 85000 EUR parsed }. null = no active goal. */
  goal?: { visaSponsorshipRequired: boolean | null } | null;
  /** Default true: a resume PDF generated_documents row (object key is fake; tests that download must upload it). */
  withResume?: boolean;
  withCoverLetter?: boolean;
  /** Phase 13c: also a tailored_resume PDF row, created after the resume row. */
  withTailoredResume?: boolean;
}

export interface SeededAutofillJob {
  jobId: string;
  resumeDocumentId: string | null;
  coverLetterDocumentId: string | null;
  tailoredResumeDocumentId: string | null;
}

export async function seedAutofillJob(adminSql: postgres.Sql, userId: string, opts: SeedAutofillOptions = {}): Promise<SeededAutofillJob> {
  const kind = opts.sourceKind ?? "greenhouse";
  if (opts.withProfile ?? true) {
    await adminSql`
      INSERT INTO candidate_profiles (user_id, full_name, email, phone_number, linkedin_url, address_line1)
      VALUES (${userId}, 'Jane Doe', 'jane@example.com', '+49 30 1234', 'https://linkedin.com/in/jane', 'Berlin')
      ON CONFLICT (user_id) DO NOTHING`;
  }
  const goal = opts.goal === undefined ? { visaSponsorshipRequired: false } : opts.goal;
  if (goal) {
    const [g] = await adminSql`
      INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
      VALUES (${userId}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
    await adminSql`
      INSERT INTO career_goal_constraints (user_id, career_goal_id, visa_sponsorship_required,
                                           salary_target_normalized, salary_target_currency, salary_target_is_parsed)
      VALUES (${userId}, ${g.id}, ${goal.visaSponsorshipRequired}, 85000, 'EUR', true)`;
  }
  const [job] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${userId}, 'Acme', 'acme', 'Data Engineer', 'data engineer', 'dh', now(), now()) RETURNING id`;
  const config = kind === "upload" ? {} : { slug: opts.slug ?? "acme" };
  const [source] = await adminSql`
    INSERT INTO job_sources (user_id, kind, label, config, enabled)
    VALUES (${userId}, ${kind}, 'Acme', ${JSON.stringify(config)}::jsonb, false) RETURNING id`;
  await adminSql`
    INSERT INTO job_postings (user_id, job_id, source_id, external_id, url, fingerprint, content_hash, normalized, status, first_seen_at, last_seen_at)
    VALUES (${userId}, ${job.id}, ${source.id}, ${opts.externalId ?? "1234567"}, null, 'fp', 'h', '{}'::jsonb, 'open', now(), now())`;
  const doc = async (docKind: "resume" | "cover_letter") => {
    const [row] = await adminSql`
      INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename)
      VALUES (${userId}, ${job.id}, ${docKind}, 'pdf', ${`${userId}/${docKind}-${job.id}.pdf`}, 10, ${"h-" + docKind}, 'r1', ${docKind + ".pdf"})
      RETURNING id`;
    return row.id as string;
  };
  const tailoredDoc = async () => {
    const [row] = await adminSql`
      INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename, created_at)
      VALUES (${userId}, ${job.id}, 'tailored_resume', 'pdf', ${`${userId}/tailored-${job.id}.pdf`}, 10, 'tailored-h', 'tex-1', 'r.pdf', now() + interval '1 second')
      RETURNING id`;
    return row.id as string;
  };
  return {
    jobId: job.id as string,
    resumeDocumentId: (opts.withResume ?? true) ? await doc("resume") : null,
    coverLetterDocumentId: opts.withCoverLetter ? await doc("cover_letter") : null,
    tailoredResumeDocumentId: opts.withTailoredResume ? await tailoredDoc() : null,
  };
}

export async function insertSessionRow(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  opts: { status?: string; formUrl?: string; portal?: "greenhouse" | "lever"; cancelRequested?: boolean } = {}
): Promise<string> {
  const status = opts.status ?? "queued";
  const terminal = ["submission_detected", "abandoned", "needs_manual", "failed"].includes(status);
  const portal = opts.portal ?? "greenhouse";
  const [row] = await adminSql`
    INSERT INTO automation_sessions (user_id, job_id, portal, adapter_version, form_url, status, ended_at, cancel_requested_at)
    VALUES (${userId}, ${jobId}, ${portal}, ${portal + "-v1"}, ${opts.formUrl ?? "https://job-boards.greenhouse.io/acme/jobs/1234567"},
            ${status}, ${terminal ? new Date().toISOString() : null}::timestamptz,
            ${opts.cancelRequested ? new Date().toISOString() : null}::timestamptz)
    RETURNING id`;
  return row.id as string;
}
