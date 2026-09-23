import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { schema, withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { runMatching, MatchingError } from "./runMatching";
import { MatchExplanationValidationError } from "../explanation/generateMatchExplanation";

vi.mock("@ai-career/ai", () => ({ embedTexts: vi.fn().mockResolvedValue([]) }));
import { embedTexts } from "@ai-career/ai";

const USER = "00000000-0000-0000-0000-0000000000e5";
let testDb: TestDb;

const ENV = {
  ANTHROPIC_MODEL_FAST: "test-model",
  EMBEDDING_PROVIDER: "voyage" as const,
  VOYAGE_API_KEY: "k",
  VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  MATCHING_EXPLAIN_TOP_N: 1,
  MATCHING_EXPERIENCE_GRACE_YEARS: 1,
  MATCHING_FRESHNESS_HALF_LIFE_HOURS: 168,
  MATCHING_EXPLANATION_TTL_DAYS: 7,
};

function fakeAnthropic(explanation: unknown = { strongMatches: ["x"], partialMatches: [], gaps: [], summary: "s" }): Pick<Anthropic, "messages"> {
  return { messages: { create: async () => ({ content: [{ type: "tool_use", id: "t1", name: "record_match_explanation", input: explanation }] }) } as unknown as Anthropic["messages"] };
}

function erroringAnthropic(error: Error): Pick<Anthropic, "messages"> {
  return {
    messages: {
      create: async () => {
        throw error;
      },
    } as unknown as Anthropic["messages"],
  };
}

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  vi.mocked(embedTexts).mockReset().mockResolvedValue([]);
  await wipeUser(testDb.adminSql, USER);
});

async function seedGoalAndProfile(): Promise<string> {
  const [goal] = await testDb.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'Data roles', 1, 'parsed', 'confirmed', true) RETURNING id`;
  await testDb.adminSql`
    INSERT INTO career_goal_constraints (user_id, career_goal_id, target_roles, skills, work_mode)
    VALUES (${USER}, ${goal.id}, ARRAY['Data Engineer'], ARRAY['SQL'], 'any')`;
  await testDb.adminSql`
    INSERT INTO candidate_profiles (user_id, full_name, email, years_of_experience)
    VALUES (${USER}, 'Test User', 't@example.com', 5)`;
  return goal.id as string;
}

async function seedJob(opts: { title: string; companyName?: string }): Promise<string> {
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash,
                       status, first_seen_at, last_verified_at)
    VALUES (${USER}, ${opts.companyName ?? "Acme"}, ${(opts.companyName ?? "Acme").toLowerCase()}, ${opts.title}, 'title-key',
            'We use SQL daily.', ${"hash-" + opts.title}, 'open', now(), now())
    RETURNING id`;
  return job.id as string;
}

describe("runMatching", () => {
  it("throws MatchingError('no_active_goal') and records a failed run when there is no confirmed active goal", async () => {
    await expect(
      runMatching(testDb.db, { userId: USER, anthropicClient: fakeAnthropic(), env: ENV })
    ).rejects.toMatchObject({ errorClass: "no_active_goal" });
  });

  it("scores eligible jobs, excludes ineligible ones with a reason, and explains only the top N", async () => {
    await seedGoalAndProfile();
    await seedJob({ title: "Data Engineer" });
    await seedJob({ title: "Data Analyst" });
    await seedJob({ title: "Excluded Role", companyName: "Excluded Co" });
    await withUserContext(testDb.db, USER, (tx) =>
      tx.update(schema.careerGoalConstraints).set({ excludedCompanies: ["Excluded Co"] })
    );

    const summary = await runMatching(testDb.db, { userId: USER, anthropicClient: fakeAnthropic(), env: ENV });

    expect(summary.status).toBe("completed");
    expect(summary.jobsEvaluated).toBe(3);
    expect(summary.jobsEligible).toBe(2);
    expect(summary.jobsExplained).toBe(1); // MATCHING_EXPLAIN_TOP_N: 1

    const rows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches));
    const excluded = rows.find((r) => r.ineligibleReason?.includes("Excluded"));
    expect(excluded?.eligible).toBe(false);
    expect(rows.filter((r) => r.eligible)).toHaveLength(2);
    expect(rows.filter((r) => r.explanation !== null)).toHaveLength(1);

    const [run] = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.matchingRuns));
    expect(run.status).toBe("completed");
    expect(run.jobsEligible).toBe(2);
  });

  it("keeps a dismissed job ineligible on the next run and carries its userAction forward", async () => {
    await seedGoalAndProfile();
    const jobId = await seedJob({ title: "Data Engineer" });
    await runMatching(testDb.db, { userId: USER, anthropicClient: fakeAnthropic(), env: { ...ENV, MATCHING_EXPLAIN_TOP_N: 0 } });
    await testDb.adminSql`UPDATE job_matches SET user_action = 'dismissed', user_action_at = now() WHERE job_id = ${jobId}`;

    await runMatching(testDb.db, { userId: USER, anthropicClient: fakeAnthropic(), env: ENV });

    const rows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches));
    const dismissed = rows.find((r) => r.jobId === jobId)!;
    expect(dismissed.eligible).toBe(false);
    expect(dismissed.userAction).toBe("dismissed");
  });

  it("does not fail the run when one explanation response is malformed -- the job keeps its scores", async () => {
    await seedGoalAndProfile();
    await seedJob({ title: "Data Engineer" });
    const badClient = fakeAnthropic({ strongMatches: "not-an-array" });

    const summary = await runMatching(testDb.db, { userId: USER, anthropicClient: badClient, env: ENV });

    expect(summary.status).toBe("completed");
    expect(summary.jobsExplained).toBe(0);
    const rows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches));
    expect(rows[0].eligible).toBe(true);
    expect(rows[0].explanation).toBeNull();
  });

  it("does not fail the run when the explanation call throws a transient Anthropic API error -- the job keeps its scores", async () => {
    await seedGoalAndProfile();
    await seedJob({ title: "Data Engineer" });
    const rateLimited = new Anthropic.RateLimitError(429, { type: "rate_limit_error", message: "slow down" }, "Rate limited", undefined);
    const failingClient = erroringAnthropic(rateLimited);

    const summary = await runMatching(testDb.db, { userId: USER, anthropicClient: failingClient, env: ENV });

    expect(summary.status).toBe("completed");
    expect(summary.jobsExplained).toBe(0);
    const rows = await withUserContext(testDb.db, USER, (tx) => tx.select().from(schema.jobMatches));
    expect(rows[0].eligible).toBe(true);
    expect(rows[0].overallScore).not.toBeNull();
    expect(rows[0].explanation).toBeNull();
  });

  it("still fails the run on a genuinely unexpected error from explanation generation", async () => {
    await seedGoalAndProfile();
    await seedJob({ title: "Data Engineer" });
    const failingClient = erroringAnthropic(new TypeError("something the design doesn't anticipate"));

    await expect(
      runMatching(testDb.db, { userId: USER, anthropicClient: failingClient, env: ENV })
    ).rejects.toMatchObject({ errorClass: "unknown" });
  });
});
