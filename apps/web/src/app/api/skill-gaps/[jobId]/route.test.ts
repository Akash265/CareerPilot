import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertCareerGoal, insertMatch } from "../../../../test/jobsDb";

// Phase 13b test user (…0d14); verify unused with grep first.
const USER = "00000000-0000-0000-0000-000000000d15";
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000d15",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379", SKILL_GAP_TOP_N: 25, ANTHROPIC_MODEL_FAST: "fast",
    RATE_LIMIT_AI_PER_MINUTE: 0, RATE_LIMIT_JOBS_PER_MINUTE: 0,
  }),
}));

let admin: postgres.Sql;
beforeAll(async () => { admin = await openAdminDb(); });
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => { await wipeMatchingData(admin, USER); await admin.end(); });

const { GET } = await import("./route");
const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

describe("GET /api/skill-gaps/[jobId] (Phase 13b)", () => {
  it("404s for a non-uuid and for a job without a match", async () => {
    expect((await GET(new Request("http://x"), ctx("nope"))).status).toBe(404);
    const jobId = await insertJob(admin, USER, {});
    expect((await GET(new Request("http://x"), ctx(jobId))).status).toBe(404);
  });

  it("returns the job's gaps", async () => {
    const goal = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, {});
    await insertMatch(admin, USER, jobId, goal);
    const res = await GET(new Request("http://x"), ctx(jobId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requirementsStatus: "missing", unanswered: [] });
  });
});
