// apps/web/src/app/api/application-pitches/[jobId]/run/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertCareerGoal, insertMatch } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000d5",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_MODEL_FAST: "test-model",
    ANTHROPIC_MODEL_RESEARCH: "test-research-model",
    COMPANY_RESEARCH_MAX_SEARCHES: 5,
    EMBEDDING_PROVIDER: "voyage",
    VOYAGE_API_KEY: "voyage-test",
    VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  }),
}));

// Only pre-LLM paths are exercised here (the pipeline's success/502 paths are covered with fakes in
// packages/application-package), so the Anthropic SDK is never called.
const USER = "00000000-0000-0000-0000-0000000000d5";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");
const run = (jobId: string) =>
  POST(new Request(`http://localhost/api/application-pitches/${jobId}/run`, { method: "POST" }), { params: Promise.resolve({ jobId }) });

describe("POST /api/application-pitches/[jobId]/run", () => {
  it("returns 404 for a non-UUID jobId", async () => {
    expect((await run("not-a-uuid")).status).toBe(404);
  });

  it("returns 404 when there is no job_matches row", async () => {
    const jobId = await insertJob(admin, USER, {});
    expect((await run(jobId)).status).toBe(404);
  });

  it("returns 400 when the match is ineligible", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, {});
    await insertMatch(admin, USER, jobId, goalId, { eligible: false });
    expect((await run(jobId)).status).toBe(400);
  });

  it("returns 409 with a clear message when the user has no profile evidence", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, {});
    await insertMatch(admin, USER, jobId, goalId, { eligible: true });
    const res = await run(jobId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/profile/i);
  });
});
