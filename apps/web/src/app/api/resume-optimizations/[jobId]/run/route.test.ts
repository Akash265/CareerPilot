// apps/web/src/app/api/resume-optimizations/[jobId]/run/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertCareerGoal, insertMatch } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000fb",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_MODEL_FAST: "test-model",
    ANTHROPIC_MODEL_RESEARCH: "test-model",
    EMBEDDING_PROVIDER: "voyage",
    VOYAGE_API_KEY: "voyage-test",
    VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  }),
}));

// These 3 tests deliberately only exercise the pre-LLM error paths (below), so the Anthropic SDK is
// never actually called and needs no mock here -- see the note after this test's Step 11 listing.

const USER = "00000000-0000-0000-0000-0000000000fb";
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
const run = (jobId: string) => POST(new Request(`http://localhost/api/resume-optimizations/${jobId}/run`, { method: "POST" }), { params: Promise.resolve({ jobId }) });

describe("POST /api/resume-optimizations/[jobId]/run", () => {
  it("returns 404 when there is no job_matches row for this job", async () => {
    const jobId = await insertJob(admin, USER, {});
    const res = await run(jobId);
    expect(res.status).toBe(404);
  });

  it("returns 400 when the match exists but is ineligible", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, {});
    await insertMatch(admin, USER, jobId, goalId, { eligible: false });
    const res = await run(jobId);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a non-UUID jobId", async () => {
    const res = await run("not-a-uuid");
    expect(res.status).toBe(404);
  });
});
