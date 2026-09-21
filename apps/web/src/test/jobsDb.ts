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

export async function insertJob(
  adminSql: postgres.Sql,
  userId: string,
  opts: {
    title?: string;
    companyName?: string;
    status?: "open" | "closed";
    postedAt?: string | null;
    firstSeenAt?: string;
    locationRaw?: string | null;
    workMode?: "remote" | "hybrid" | "onsite" | "unknown";
    salaryRaw?: string | null;
    salaryMin?: number | null;
    salaryMax?: number | null;
    salaryCurrency?: string | null;
    salaryPeriod?: "year" | "month" | "hour" | null;
    salaryIsParsed?: boolean;
    sponsorship?: "offered" | "not_offered" | "unknown";
    sponsorshipEvidence?: string | null;
    minExperienceYears?: number | null;
    descriptionText?: string;
  } = {}
): Promise<string> {
  const title = opts.title ?? "Data Engineer";
  const companyName = opts.companyName ?? "Acme";
  const [row] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, location_raw, location_key, work_mode,
                      description_text, description_hash, salary_raw, salary_min, salary_max, salary_currency,
                      salary_period, salary_is_parsed, sponsorship, sponsorship_evidence, min_experience_years,
                      posted_at, first_seen_at, last_verified_at, status)
    VALUES (${userId}, ${companyName}, ${companyName.toLowerCase()}, ${title}, ${title.toLowerCase()},
            ${opts.locationRaw === undefined ? "Berlin" : opts.locationRaw},
            ${(opts.locationRaw === undefined ? "Berlin" : opts.locationRaw ?? "").toLowerCase()},
            ${opts.workMode ?? "unknown"}, ${opts.descriptionText ?? "Build pipelines."}, ${"hash-" + title},
            ${opts.salaryRaw ?? null}, ${opts.salaryMin ?? null}, ${opts.salaryMax ?? null},
            ${opts.salaryCurrency ?? null}, ${opts.salaryPeriod ?? null}, ${opts.salaryIsParsed ?? false},
            ${opts.sponsorship ?? "unknown"}, ${opts.sponsorshipEvidence ?? null}, ${opts.minExperienceYears ?? null},
            ${opts.postedAt ?? null}::timestamptz, ${opts.firstSeenAt ?? "2026-09-01T00:00:00Z"}::timestamptz,
            ${opts.firstSeenAt ?? "2026-09-01T00:00:00Z"}::timestamptz, ${opts.status ?? "open"})
    RETURNING id`;
  return row.id as string;
}

export async function insertPosting(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  sourceId: string,
  opts: { externalId?: string; url?: string | null; status?: "open" | "closed" } = {}
): Promise<string> {
  const externalId = opts.externalId ?? `ext-${Math.random().toString(36).slice(2, 10)}`;
  const [row] = await adminSql`
    INSERT INTO job_postings (user_id, job_id, source_id, external_id, url, fingerprint, content_hash, normalized, status, first_seen_at, last_seen_at)
    VALUES (${userId}, ${jobId}, ${sourceId}, ${externalId}, ${opts.url ?? null}, ${"fp-" + externalId}, 'h', '{}'::jsonb,
            ${opts.status ?? "open"}, '2026-09-01T00:00:00Z'::timestamptz, '2026-09-02T00:00:00Z'::timestamptz)
    RETURNING id`;
  return row.id as string;
}
