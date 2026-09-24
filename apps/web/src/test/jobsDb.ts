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

/** Also wipes the tables wipeJobData already covers, plus the matching-specific ones. */
export async function wipeMatchingData(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM job_matches WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM matching_runs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM career_goals WHERE user_id = ${userId}`;
  // Phase 7a: company_research is keyed by company, not job, so it does not cascade from jobs.
  await adminSql`DELETE FROM company_research WHERE user_id = ${userId}`;
  await wipeJobData(adminSql, userId);
}

export async function insertCareerGoal(
  adminSql: postgres.Sql,
  userId: string,
  opts: { isActive?: boolean; confirmationStatus?: "draft" | "confirmed" } = {}
): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${userId}, 'Data roles', 1, 'parsed', ${opts.confirmationStatus ?? "confirmed"}, ${opts.isActive ?? true})
    RETURNING id`;
  return row.id as string;
}

export async function insertMatch(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  careerGoalId: string,
  opts: {
    eligible?: boolean;
    ineligibleReason?: string | null;
    overallScore?: number | null;
    skillsScore?: number | null;
    explanation?: object | null;
    userAction?: "none" | "saved" | "dismissed";
  } = {}
): Promise<string> {
  const eligible = opts.eligible ?? true;
  const [row] = await adminSql`
    INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, ineligible_reason, overall_score, skills_score,
                              explanation, user_action, computed_at)
    VALUES (${userId}, ${jobId}, ${careerGoalId}, ${eligible}, ${opts.ineligibleReason ?? null},
            ${eligible ? (opts.overallScore ?? 75) : null}, ${eligible ? (opts.skillsScore ?? 0.8) : null},
            ${opts.explanation ? JSON.stringify(opts.explanation) : null}::jsonb, ${opts.userAction ?? "none"}, now())
    RETURNING id`;
  return row.id as string;
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
  opts: { externalId?: string; url?: string | null; status?: "open" | "closed"; firstSeenAt?: string } = {}
): Promise<string> {
  const externalId = opts.externalId ?? `ext-${Math.random().toString(36).slice(2, 10)}`;
  const [row] = await adminSql`
    INSERT INTO job_postings (user_id, job_id, source_id, external_id, url, fingerprint, content_hash, normalized, status, first_seen_at, last_seen_at)
    VALUES (${userId}, ${jobId}, ${sourceId}, ${externalId}, ${opts.url ?? null}, ${"fp-" + externalId}, 'h', '{}'::jsonb,
            ${opts.status ?? "open"}, ${opts.firstSeenAt ?? "2026-09-01T00:00:00Z"}::timestamptz, '2026-09-02T00:00:00Z'::timestamptz)
    RETURNING id`;
  return row.id as string;
}

export const DEFAULT_PITCH_BULLETS = [
  { kind: "company", text: "Acme's rocket work matches my interests.", supported: true, unsupportedReason: null,
    evidence: [{ id: "r:1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" }] },
  { kind: "role", text: "The role centres on SQL.", supported: true, unsupportedReason: null,
    evidence: [{ id: "q:1", kind: "requirement", text: "[required] SQL", sourceUrl: null }] },
  { kind: "candidate", text: "I built SQL pipelines.", supported: true, unsupportedReason: null,
    evidence: [{ id: "p:1", kind: "profile", text: "Built SQL pipelines", sourceUrl: null }] },
];

export async function insertCompanyResearch(
  adminSql: postgres.Sql,
  userId: string,
  opts: {
    companyKey?: string;
    companyName?: string;
    status?: "ok" | "no_results" | "failed";
    facts?: { sourceKind?: "web" | "internal"; factText: string; sourceUrl?: string | null; sourceTitle?: string | null }[];
  } = {}
): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO company_research (user_id, company_key, company_name, status, research_model, search_count, researched_at)
    VALUES (${userId}, ${opts.companyKey ?? "acme"}, ${opts.companyName ?? "Acme"}, ${opts.status ?? "ok"}, 'test-model', 1, now())
    RETURNING id`;
  for (const [i, f] of (opts.facts ?? []).entries()) {
    await adminSql`
      INSERT INTO company_research_facts (user_id, research_id, source_kind, fact_text, source_url, source_title, display_order)
      VALUES (${userId}, ${row.id}, ${f.sourceKind ?? "web"}, ${f.factText}, ${f.sourceUrl ?? null}, ${f.sourceTitle ?? null}, ${i})`;
  }
  return row.id as string;
}

export async function insertPitch(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  opts: { version?: number; origin?: "generated" | "user_edited"; companyResearchId?: string | null; requiresReview?: boolean; bullets?: object[] } = {}
): Promise<string> {
  const origin = opts.origin ?? "generated";
  const [row] = await adminSql`
    INSERT INTO application_pitches (user_id, job_id, version, origin, company_research_id, research_status_snapshot,
                                     researched_at_snapshot, bullets, requires_review, generation_model)
    VALUES (${userId}, ${jobId}, ${opts.version ?? 1}, ${origin}, ${opts.companyResearchId ?? null}, 'ok', now(),
            ${JSON.stringify(opts.bullets ?? DEFAULT_PITCH_BULLETS)}::jsonb, ${opts.requiresReview ?? false},
            ${origin === "generated" ? "test-model" : null})
    RETURNING id`;
  return row.id as string;
}
