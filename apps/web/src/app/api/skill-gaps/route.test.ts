import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData } from "../../../test/jobsDb";

// Phase 13b test user (…0d14); verify unused with grep first.
const USER = "00000000-0000-0000-0000-000000000d14";
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000d14",
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

describe("GET /api/skill-gaps (Phase 13b)", () => {
  it("returns an empty overview when there are no matches", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ topN: 25, unanswered: [], answered: [], jobsWithoutRequirements: 0, profileSkills: [] });
  });
});
