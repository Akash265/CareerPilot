import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { schema, withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { runResumeOptimization } from "./runResumeOptimization";

// Both mocks preserve real exports (importOriginal) other than the function itself, since the
// Anthropic.APIError-mapping tests below need the real *ValidationError classes to construct
// rejections with -- a bare `{ fn: vi.fn() }` factory would make those imports `undefined`.
vi.mock("../optimization/optimizeResume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../optimization/optimizeResume")>();
  return { ...actual, optimizeResume: vi.fn() };
});
vi.mock("@ai-career/ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("@ai-career/ai")>()), embedTexts: vi.fn() }));
// Not in the brief's original mock list: ensureJobRequirements (Task 3) always calls the real
// extractJobRequirements when no fresh job_requirements row exists yet, and this fixture never seeds
// one -- so without this mock every test past the early-return checks would attempt a real
// anthropicClient.messages.create() call against FAKE_CLIENT, which has no `messages` property.
// Same mocking technique as ensureJobRequirements.test.ts itself.
vi.mock("../requirements/extractJobRequirements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../requirements/extractJobRequirements")>();
  return { ...actual, extractJobRequirements: vi.fn() };
});
import { optimizeResume, OptimizeResumeValidationError } from "../optimization/optimizeResume";
import { AiBudgetExceededError, NoopUsageSink, embedTexts, type AiOperation, type MessagesClient } from "@ai-career/ai";
import { extractJobRequirements, JobRequirementExtractionValidationError } from "../requirements/extractJobRequirements";

const USER = "00000000-0000-0000-0000-0000000000f9";
const ENV = { ANTHROPIC_MODEL_FAST: "test-model", EMBEDDING_PROVIDER: "voyage" as const, VOYAGE_API_KEY: "k", VOYAGE_EMBEDDING_MODEL: "voyage-3.5", AI_MONTHLY_BUDGET_USD: 20 };
const FAKE_CLIENT = {} as MessagesClient;
// One distinct fake client per operation, so tests can see which label each generator was handed.
const LABELLED_CLIENTS = new Map<AiOperation, MessagesClient>();
const FAKE_FOR = (operation: AiOperation): MessagesClient => {
  if (!LABELLED_CLIENTS.has(operation)) LABELLED_CLIENTS.set(operation, { ...FAKE_CLIENT } as MessagesClient);
  return LABELLED_CLIENTS.get(operation)!;
};
let testDb: TestDb;

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  vi.mocked(optimizeResume).mockReset();
  vi.mocked(embedTexts).mockReset();
  vi.mocked(extractJobRequirements).mockReset();
  vi.mocked(extractJobRequirements).mockResolvedValue({ requirements: [] });
  await wipeUser(testDb.adminSql, USER);
});

async function seedFixture(opts: { eligible?: boolean; hasGoal?: boolean } = {}) {
  const [goal] = opts.hasGoal === false
    ? [null]
    : await testDb.adminSql`
        INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
        VALUES (${USER}, 'Data roles', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER}, 'Acme', 'acme', 'Engineer', 'engineer', 'We use SQL.', 'hash-1', now(), now()) RETURNING id`;
  if (opts.hasGoal !== false) {
    await testDb.adminSql`
      INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, computed_at)
      VALUES (${USER}, ${job.id}, ${goal!.id}, ${opts.eligible ?? true}, now())`;
  }
  const [exp] = await testDb.adminSql`
    INSERT INTO work_experiences (user_id, company, title, display_order) VALUES (${USER}, 'Acme', 'Engineer', 0) RETURNING id`;
  await testDb.adminSql`
    INSERT INTO work_experience_bullets (user_id, work_experience_id, text, display_order)
    VALUES (${USER}, ${exp.id}, 'Built a data pipeline', 0)`;
  return { jobId: job.id as string, goalId: (goal as { id: string } | null)?.id ?? null };
}

describe("runResumeOptimization", () => {
  it("throws no_match when there is no job_matches row for this job", async () => {
    const { jobId } = await seedFixture({ hasGoal: false });
    await expect(runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV })).rejects.toMatchObject({ errorClass: "no_match" });
  });

  it("throws not_eligible when the match exists but is ineligible", async () => {
    const { jobId } = await seedFixture({ eligible: false });
    await expect(runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV })).rejects.toMatchObject({ errorClass: "not_eligible" });
  });

  it("persists a resume_optimizations row and a matching ats_evaluations row on success", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(optimizeResume).mockResolvedValue({
      selectedBullets: [], addedTerms: [], unsupportedClaimsDetected: [], requiresReview: false,
    });

    const result = await runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV });

    expect(result.optimization.version).toBe(1);
    expect(result.evaluation.resumeOptimizationId).toBe(result.optimization.id);
    const stored = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.resumeOptimizations).where(eq(schema.resumeOptimizations.id, result.optimization.id)));
    expect(stored).toHaveLength(1);
  });

  it("accepts a selected bullet that cites a verified_skill evidence entry", async () => {
    const { jobId } = await seedFixture();
    await testDb.adminSql`
      INSERT INTO skill_verifications (user_id, term_key, term_display, status, evidence)
      VALUES (${USER}, 'kubernetes', 'Kubernetes', 'have', 'Ran our staging cluster for a year.')`;
    const [v] = await testDb.adminSql`SELECT id FROM skill_verifications WHERE user_id = ${USER}`;
    const verificationId = v.id as string;
    vi.mocked(optimizeResume).mockResolvedValue({
      selectedBullets: [{ sourceFactId: verificationId, optimizedText: "Kubernetes: Ran our staging cluster for a year.", changeType: "unchanged", justification: "x" }],
      addedTerms: [], unsupportedClaimsDetected: [], requiresReview: false,
    });

    const result = await runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV });

    expect(result.optimization.selectedBullets).toEqual([
      expect.objectContaining({ sourceFactId: verificationId, sourceType: "verified_skill", originalText: "Kubernetes: Ran our staging cluster for a year." }),
    ]);
    expect(result.optimization.rejectedClaims).toEqual([]);
  });

  // Also a regression test for the pg_advisory_xact_lock added to the final transaction's
  // version-allocation query: two sequential calls must still get versions 1 and 2.
  it("increments version on a second call for the same job", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(optimizeResume).mockResolvedValue({ selectedBullets: [], addedTerms: [], unsupportedClaimsDetected: [], requiresReview: false });

    const first = await runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV });
    const second = await runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV });

    expect(first.optimization.version).toBe(1);
    expect(second.optimization.version).toBe(2);
  });

  it("sets requiresReview when the guard rejects a claim, even if the model did not self-flag it", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(optimizeResume).mockResolvedValue({
      selectedBullets: [{ sourceFactId: "fabricated", optimizedText: "Led a team", changeType: "reworded", justification: "x" }],
      addedTerms: [], unsupportedClaimsDetected: [], requiresReview: false,
    });

    const result = await runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV });

    expect(result.optimization.requiresReview).toBe(true);
    expect((result.optimization.rejectedClaims as unknown[]).length).toBe(1);
  });

  it("sets requiresReview from unsupportedClaimsDetected even when the model inconsistently self-reports requiresReview: false", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(optimizeResume).mockResolvedValue({
      selectedBullets: [], addedTerms: [],
      unsupportedClaimsDetected: ["Claimed 10 years of Rust experience with no supporting evidence"],
      requiresReview: false,
    });

    const result = await runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV });

    expect(result.optimization.requiresReview).toBe(true);
  });

  it("respects the model's own requiresReview:true self-report even with no unsupportedClaimsDetected and no guard rejections", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(optimizeResume).mockResolvedValue({
      selectedBullets: [], addedTerms: [], unsupportedClaimsDetected: [], requiresReview: true,
    });

    const result = await runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV });

    // The self-report can only ADD caution, never remove it -- there's no other signal here that
    // would set requiresReview, so this proves draft.requiresReview alone is still honored.
    expect(result.optimization.requiresReview).toBe(true);
  });

  it("maps an Anthropic.APIError from optimizeResume to a ResumeOptimizationError with errorClass 'unknown'", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(optimizeResume).mockRejectedValue(new Anthropic.APIError(429, {}, "rate limited", undefined));

    await expect(
      runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV })
    ).rejects.toMatchObject({ errorClass: "unknown" });
  });

  it("maps an OptimizeResumeValidationError from optimizeResume to a ResumeOptimizationError with errorClass 'unknown'", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(optimizeResume).mockRejectedValue(new OptimizeResumeValidationError("bad schema"));

    await expect(
      runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV })
    ).rejects.toMatchObject({ errorClass: "unknown" });
  });

  it("maps a JobRequirementExtractionValidationError from ensureJobRequirements to a ResumeOptimizationError with errorClass 'unknown'", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(extractJobRequirements).mockRejectedValue(new JobRequirementExtractionValidationError("bad schema"));

    await expect(
      runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV })
    ).rejects.toMatchObject({ errorClass: "unknown" });
  });

  it("rethrows an unrelated error unchanged rather than swallowing it as 'unknown'", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(optimizeResume).mockRejectedValue(new TypeError("genuine bug"));

    await expect(
      runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV })
    ).rejects.toThrow("genuine bug");
  });

  it("leaves semanticSimilarity null and does not fail the run when Voyage fails transiently", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(optimizeResume).mockResolvedValue({
      selectedBullets: [{ sourceFactId: "will-not-match", optimizedText: "x", changeType: "unchanged", justification: "x" }],
      addedTerms: [], unsupportedClaimsDetected: [], requiresReview: false,
    });
    vi.mocked(embedTexts).mockRejectedValue(new Error("voyage down"));

    const result = await runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV });

    expect(result.evaluation.semanticSimilarity).toBeNull();
  });

  it("labels the similarity embedding call and degrades to a null score when the AI budget blocks it", async () => {
    const { jobId } = await seedFixture();
    const vector = `[${new Array(1024).fill(0.01).join(",")}]`;
    await testDb.adminSql`UPDATE jobs SET embedding = ${vector}::vector WHERE id = ${jobId}`;
    const [bullet] = await testDb.adminSql`SELECT id FROM work_experience_bullets WHERE user_id = ${USER}`;
    vi.mocked(optimizeResume).mockResolvedValue({
      selectedBullets: [{ sourceFactId: bullet.id as string, optimizedText: "Built a data pipeline", changeType: "unchanged", justification: "x" }],
      addedTerms: [], unsupportedClaimsDetected: [], requiresReview: false,
    });
    vi.mocked(embedTexts).mockRejectedValue(new AiBudgetExceededError(20, 20, new Date("2026-11-01T00:00:00Z")));
    const sink = { spendSinceUsd: async () => 0, record: async () => undefined };

    const result = await runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: sink, env: ENV });

    expect(embedTexts).toHaveBeenCalledWith(ENV, ["Built a data pipeline"], { sink, operation: "resume_similarity_embedding" });
    expect(result.evaluation.semanticSimilarity).toBeNull();
  });

  it("hands each generator the client labelled with its own operation", async () => {
    const { jobId } = await seedFixture();
    vi.mocked(optimizeResume).mockResolvedValue({ selectedBullets: [], addedTerms: [], unsupportedClaimsDetected: [], requiresReview: false });

    await runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV });

    expect(vi.mocked(extractJobRequirements).mock.calls[0][0]).toBe(FAKE_FOR("job_requirements_extraction"));
    expect(vi.mocked(optimizeResume).mock.calls[0][0]).toBe(FAKE_FOR("resume_optimization"));
  });

  it("lets a budget block propagate unchanged instead of mapping it to 'unknown'", async () => {
    const { jobId } = await seedFixture();
    const blocked = new AiBudgetExceededError(20, 20, new Date("2026-11-01T00:00:00Z"));
    vi.mocked(extractJobRequirements).mockRejectedValue(blocked);

    await expect(
      runResumeOptimization(testDb.db, { userId: USER, jobId, anthropicFor: FAKE_FOR, usageSink: NoopUsageSink, env: ENV })
    ).rejects.toBe(blocked);
  });
});

