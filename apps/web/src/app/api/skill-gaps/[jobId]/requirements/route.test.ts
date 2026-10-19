import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertCareerGoal, insertMatch } from "../../../../../test/jobsDb";

// Phase 13b test user (…0d14); verify unused with grep first.
const USER = "00000000-0000-0000-0000-000000000d16";
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000d16",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379", SKILL_GAP_TOP_N: 25, ANTHROPIC_MODEL_FAST: "fast",
    RATE_LIMIT_AI_PER_MINUTE: 0, RATE_LIMIT_JOBS_PER_MINUTE: 0,
  }),
}));

let admin: postgres.Sql;
beforeAll(async () => { admin = await openAdminDb(); });
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => { await wipeMatchingData(admin, USER); await admin.end(); });

const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
const create = vi.fn();
vi.mock("@ai-career/ai", async (orig) => ({
  ...(await orig<typeof import("@ai-career/ai")>()),
  createAnthropicFor: () => () => ({ messages: { create } }),
}));
const { POST } = await import("./route");

describe("POST /api/skill-gaps/[jobId]/requirements (Phase 13b)", () => {
  it("extracts the job's requirements and returns its gaps", async () => {
    create.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "t", name: "record_job_requirements",
        input: { requirements: [{ termText: "Kubernetes", termType: "tool", requirementLevel: "required", evidenceQuote: null }] } }],
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
    });
    const goal = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, {});
    await insertMatch(admin, USER, jobId, goal);
    const res = await POST(new Request("http://x", { method: "POST" }), ctx(jobId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requirementsStatus: "ready", unanswered: [{ termKey: "kubernetes" }] });
  });

  it("answers 502 when the model's answer is invalid", async () => {
    create.mockResolvedValueOnce({ content: [{ type: "text", text: "no" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    const goal = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, {});
    await insertMatch(admin, USER, jobId, goal);
    expect((await POST(new Request("http://x", { method: "POST" }), ctx(jobId))).status).toBe(502);
  });
});
