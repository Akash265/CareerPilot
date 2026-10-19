import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { withUserContext } from "@ai-career/db";
import { AiBudgetExceededError, type AnthropicFor } from "@ai-career/ai";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { ensureTopMatchRequirements, selectTopMatchJobs } from "./topMatchRequirements";

// Phase 13b test user (…0d12); verified unused with grep.
const USER = "00000000-0000-0000-0000-000000000d12";
let t: TestDb;
beforeAll(async () => { t = await openTestDb(); });
afterAll(() => t.close());
beforeEach(() => wipeUser(t.adminSql, USER));

async function seedMatch(title: string, score: number | null, opts: { eligible?: boolean; status?: "open" | "closed" } = {}) {
  const [goal] = await t.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'g', 1, 'parsed', 'confirmed', false) RETURNING id`;
  const [job] = await t.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash, status, first_seen_at, last_verified_at)
    VALUES (${USER}, 'Acme', 'acme', ${title}, ${title.toLowerCase()}, 'Needs Kubernetes.', ${"h-" + title}, ${opts.status ?? "open"}, now(), now())
    RETURNING id`;
  await t.adminSql`
    INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, overall_score, computed_at)
    VALUES (${USER}, ${job.id}, ${goal.id}, ${opts.eligible ?? true}, ${score}, now())`;
  return job.id as string;
}

const toolAnswer = {
  content: [{ type: "tool_use", id: "t1", name: "record_job_requirements",
    input: { requirements: [{ termText: "Kubernetes", termType: "tool", requirementLevel: "required", evidenceQuote: null }] } }],
  stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
};
const ENV = { ANTHROPIC_MODEL_FAST: "fast-model", SKILL_GAP_TOP_N: 2 };

describe("selectTopMatchJobs", () => {
  it("returns open, eligible matches by score, highest first, up to the limit", async () => {
    const low = await seedMatch("Low", 50);
    const high = await seedMatch("High", 90);
    await seedMatch("Mid", 70);
    await seedMatch("Closed", 99, { status: "closed" });
    await seedMatch("Ineligible", null, { eligible: false });
    const jobs = await withUserContext(t.db, USER, (tx) => selectTopMatchJobs(tx, 2));
    expect(jobs.map((j) => j.title)).toEqual(["High", "Mid"]);
    expect(jobs[0]).toMatchObject({ id: high, companyName: "Acme", descriptionHash: "h-High" });
    expect(jobs.map((j) => j.id)).not.toContain(low);
  });
});

describe("ensureTopMatchRequirements", () => {
  it("extracts only for jobs without fresh requirements", async () => {
    await seedMatch("A", 90);
    await seedMatch("B", 80);
    const create = vi.fn(async () => toolAnswer);
    const anthropicFor: AnthropicFor = () => ({ messages: { create } }) as never;
    const first = await ensureTopMatchRequirements(t.db, { userId: USER, env: ENV, anthropicFor });
    expect(first).toEqual({ jobs: 2, failed: 0, budgetStopped: false });
    expect(create).toHaveBeenCalledTimes(2);
    await ensureTopMatchRequirements(t.db, { userId: USER, env: ENV, anthropicFor });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("makes no second AI call for a job whose extraction found zero requirements (D205)", async () => {
    await seedMatch("A", 90);
    const create = vi.fn(async () => ({
      content: [{ type: "tool_use", id: "t1", name: "record_job_requirements", input: { requirements: [] } }],
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
    }));
    const anthropicFor: AnthropicFor = () => ({ messages: { create } }) as never;
    await ensureTopMatchRequirements(t.db, { userId: USER, env: ENV, anthropicFor });
    await ensureTopMatchRequirements(t.db, { userId: USER, env: ENV, anthropicFor });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("skips a failing job and reports it, then stops at the AI budget", async () => {
    const a = await seedMatch("A", 90);
    await seedMatch("B", 80);
    const onJobError = vi.fn();
    const failing: AnthropicFor = () => ({ messages: { create: vi.fn(async () => { throw new Error("boom"); }) } }) as never;
    expect(await ensureTopMatchRequirements(t.db, { userId: USER, env: ENV, anthropicFor: failing, onJobError }))
      .toEqual({ jobs: 2, failed: 2, budgetStopped: false });
    expect(onJobError).toHaveBeenCalledWith(a, expect.any(Error));

    const create = vi.fn(async () => { throw new AiBudgetExceededError(20, 20, new Date()); });
    const broke: AnthropicFor = () => ({ messages: { create } }) as never;
    expect(await ensureTopMatchRequirements(t.db, { userId: USER, env: ENV, anthropicFor: broke }))
      .toEqual({ jobs: 2, failed: 0, budgetStopped: true });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
