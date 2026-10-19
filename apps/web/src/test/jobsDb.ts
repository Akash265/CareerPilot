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
  await adminSql`DELETE FROM applications WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_sources WHERE user_id = ${userId}`;
}

/** Also wipes the tables wipeJobData already covers, plus the matching-specific ones. */
export async function wipeMatchingData(adminSql: postgres.Sql, userId: string): Promise<void> {
  // Phase 11a: ai_calls rows (budget seeds and calls recorded by the routes under test).
  await adminSql`DELETE FROM ai_calls WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_matches WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM matching_runs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM search_runs WHERE user_id = ${userId}`;
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

/** The 9 match factor names (job_matches columns / feature snapshot match fields). */
export type ModelFactorKey =
  | "skillsScore" | "experienceScore" | "locationScore" | "sponsorshipScore" | "roleScore" | "salaryScore" | "industryScore"
  | "freshnessScore" | "semanticScore";

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
    /** Phase 10b: the other eight factor scores (0-1); omitted ones stay null. */
    factors?: Partial<Record<Exclude<ModelFactorKey, "skillsScore">, number>>;
  } = {}
): Promise<string> {
  const eligible = opts.eligible ?? true;
  const f = eligible ? (opts.factors ?? {}) : {};
  const [row] = await adminSql`
    INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, ineligible_reason, overall_score, skills_score,
                              experience_score, location_score, sponsorship_score, role_score, salary_score, industry_score,
                              freshness_score, semantic_score, explanation, user_action, computed_at)
    VALUES (${userId}, ${jobId}, ${careerGoalId}, ${eligible}, ${opts.ineligibleReason ?? null},
            ${eligible ? (opts.overallScore ?? 75) : null}, ${eligible ? (opts.skillsScore ?? 0.8) : null},
            ${f.experienceScore ?? null}, ${f.locationScore ?? null}, ${f.sponsorshipScore ?? null}, ${f.roleScore ?? null},
            ${f.salaryScore ?? null}, ${f.industryScore ?? null}, ${f.freshnessScore ?? null}, ${f.semanticScore ?? null},
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

const DEFAULT_COVER_LETTER_PARAGRAPHS = ["opening", "company", "evidence", "closing"].map((role) => ({
  role, text: `The ${role} paragraph.`, supported: true, unsupportedReason: null, evidence: [],
}));

export async function insertCoverLetter(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  opts: { version?: number; origin?: "generated" | "user_edited"; paragraphs?: object[] } = {}
): Promise<string> {
  const origin = opts.origin ?? "generated";
  const [row] = await adminSql`
    INSERT INTO cover_letters (user_id, job_id, version, origin, research_status_snapshot, researched_at_snapshot,
                               paragraphs, requires_review, generation_model)
    VALUES (${userId}, ${jobId}, ${opts.version ?? 1}, ${origin}, 'ok', now(),
            ${JSON.stringify(opts.paragraphs ?? DEFAULT_COVER_LETTER_PARAGRAPHS)}::jsonb, false, ${origin === "generated" ? "test-model" : null})
    RETURNING id`;
  return row.id as string;
}

export const DEFAULT_INTERVIEW_PREP_SECTIONS = {
  likelyQuestions: [1, 2, 3, 4, 5].map((i) => ({ question: `Likely question ${i}?`, category: "technical", answerOutline: [`Outline ${i}`], supported: true, unsupportedReason: null, evidence: [] })),
  gapQuestions: [{ question: "Kubernetes?", requirementTerm: "Kubernetes", framing: "Be honest.", supported: true, unsupportedReason: null, evidence: [] }],
  talkingPoints: [1, 2, 3].map((i) => ({ text: `Talking point ${i}.`, supported: true, unsupportedReason: null, evidence: [] })),
  questionsToAsk: [1, 2, 3].map((i) => ({ question: `Ask ${i}?`, supported: true, unsupportedReason: null, evidence: [] })),
};

export async function insertInterviewPrep(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  opts: { version?: number } = {}
): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO interview_preparations (user_id, job_id, version, research_status_snapshot, researched_at_snapshot, sections,
                                        gap_terms_snapshot, requires_review, source_profile_content_hash, generation_model)
    VALUES (${userId}, ${jobId}, ${opts.version ?? 1}, 'ok', now(), ${JSON.stringify(DEFAULT_INTERVIEW_PREP_SECTIONS)}::jsonb,
            '["Kubernetes"]'::jsonb, false, 'h', 'test-model')
    RETURNING id`;
  return row.id as string;
}

export async function insertApplication(
  adminSql: postgres.Sql,
  userId: string,
  opts: { jobId?: string | null; companyName?: string; status?: string; terminal?: boolean; followUpAt?: string | null; appliedAt?: string } = {}
): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO applications (user_id, job_id, company_name, job_title, status, status_changed_at, applied_at, follow_up_at,
                              feature_snapshot, terminal_at)
    VALUES (${userId}, ${opts.jobId ?? null}, ${opts.companyName ?? "Acme"}, 'Data Engineer', ${opts.status ?? "applied"}, now(),
            ${opts.appliedAt ?? "2026-09-30"}, ${opts.followUpAt ?? null},
            '{"snapshotVersion":1,"external":false,"match":{"overallScore":78},"ats":{"overallScore":82},"documents":{"resume":{"version":3},"pitch":null,"coverLetter":null}}'::jsonb,
            ${opts.terminal ? new Date().toISOString() : null}::timestamptz)
    RETURNING id`;
  await adminSql`INSERT INTO application_events (user_id, application_id, type, occurred_at, to_status)
                 VALUES (${userId}, ${row.id}, 'status_change', now(), ${opts.status ?? "applied"})`;
  return row.id as string;
}

/** Phase 8. candidate_profiles has one row per user and does not cascade from jobs: tests delete it themselves. */
export async function insertProfile(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`
    INSERT INTO candidate_profiles (user_id, full_name, email) VALUES (${userId}, 'Jane Doe', 'jane@example.com')
    ON CONFLICT (user_id) DO NOTHING`;
}

export async function insertGeneratedPdf(adminSql: postgres.Sql, userId: string, jobId: string, kind: "resume" | "cover_letter"): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename)
    VALUES (${userId}, ${jobId}, ${kind}, 'pdf', ${`${userId}/${kind}-${jobId}.pdf`}, 10, ${"h-" + kind}, 'r1', ${kind + ".pdf"})
    RETURNING id`;
  return row.id as string;
}

export async function insertAutomationSession(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  opts: { status?: string; fieldAudit?: object[] } = {}
): Promise<string> {
  const status = opts.status ?? "queued";
  const terminal = ["submission_detected", "abandoned", "needs_manual", "failed"].includes(status);
  const [row] = await adminSql`
    INSERT INTO automation_sessions (user_id, job_id, portal, adapter_version, form_url, status, ended_at, field_audit)
    VALUES (${userId}, ${jobId}, 'greenhouse', 'greenhouse-v1', 'https://job-boards.greenhouse.io/acme/jobs/123', ${status},
            ${terminal ? new Date().toISOString() : null}::timestamptz, ${JSON.stringify(opts.fieldAudit ?? [])}::jsonb)
    RETURNING id`;
  return row.id as string;
}

/**
 * Phase 10b: `n` decided ingested applications (no job row; snapshot v2 with an eligible match) whose response follows
 * the skills factor -- skills above 0.5 reached screening, the rest were rejected. The other varying factors are fixed
 * permutations, so the history is deterministic and the response model trained on it is active (>= 30 decided,
 * >= 8 per class, beats the base rate on leave-one-out).
 */
export async function insertModelHistory(adminSql: postgres.Sql, userId: string, n = 40): Promise<void> {
  const step = (k: number, i: number) => (((i * k) % n) + 0.5) / n;
  for (let i = 0; i < n; i++) {
    const skills = (i + 0.5) / n;
    const responded = skills > 0.5;
    const status = responded ? "screening" : "rejected";
    const snapshot = {
      snapshotVersion: 2, external: false, job: {}, ats: null, documents: null,
      match: {
        careerGoalId: null, eligible: true, overallScore: 70, computedAt: "2026-09-01T00:00:00.000Z",
        skillsScore: skills, experienceScore: step(7, i), locationScore: step(11, i), sponsorshipScore: step(13, i),
        roleScore: step(17, i), salaryScore: null, industryScore: step(19, i), freshnessScore: step(23, i), semanticScore: step(29, i),
      },
    };
    const [row] = await adminSql`
      INSERT INTO applications (user_id, job_id, company_name, job_title, status, status_changed_at, applied_at, feature_snapshot, terminal_at)
      VALUES (${userId}, null, 'Acme', 'Data Engineer', ${status}, now(), '2026-09-01', ${JSON.stringify(snapshot)}::jsonb,
              ${responded ? null : new Date().toISOString()}::timestamptz)
      RETURNING id`;
    await adminSql`
      INSERT INTO application_events (user_id, application_id, type, occurred_at, from_status, to_status) VALUES
        (${userId}, ${row.id}, 'status_change', '2026-09-01T09:00:00Z', null, 'applied'),
        (${userId}, ${row.id}, 'status_change', '2026-09-03T09:00:00Z', 'applied', ${status})`;
  }
}

/** Phase 11a: a recorded call costing `usd` now, so this month's estimated spend reaches a test's ceiling. */
export async function insertAiSpend(adminSql: postgres.Sql, userId: string, usd: number): Promise<void> {
  await adminSql`
    INSERT INTO ai_calls (user_id, operation, provider, model, latency_ms, estimated_cost_usd, price_known, outcome)
    VALUES (${userId}, 'pitch_generation', 'anthropic', 'claude-haiku-4-5', 1000, ${usd}, true, 'ok')`;
}

/** Phase 11a: the ai_calls rows a route recorded for this user, oldest first. */
export async function aiCallRows(adminSql: postgres.Sql, userId: string) {
  return adminSql<{ operation: string; outcome: string; error_code: string | null }[]>`
    SELECT operation, outcome, error_code FROM ai_calls WHERE user_id = ${userId} ORDER BY created_at, operation`;
}

/** Phase 11a: one work-experience bullet, so the resume snapshot has evidence and generation gets past no_profile. */
export async function insertResumeEvidence(adminSql: postgres.Sql, userId: string): Promise<void> {
  const [exp] = await adminSql`
    INSERT INTO work_experiences (user_id, company, title, display_order) VALUES (${userId}, 'Acme', 'Engineer', 0) RETURNING id`;
  await adminSql`
    INSERT INTO work_experience_bullets (user_id, work_experience_id, text, display_order)
    VALUES (${userId}, ${exp.id}, 'Built a data pipeline', 0)`;
}

export async function wipeResumeEvidence(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM work_experience_bullets WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM work_experiences WHERE user_id = ${userId}`;
}

