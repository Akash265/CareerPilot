import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertCareerGoal } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000c4",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));
import { vi } from "vitest";

const USER = "00000000-0000-0000-0000-0000000000c4";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET } = await import("./route");

describe("GET /api/matches/runs/latest", () => {
  it("returns null when no run has ever happened", async () => {
    const res = await GET();
    expect((await res.json()).run).toBeNull();
  });

  it("returns the most recent run's status and counts", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    await admin`INSERT INTO matching_runs (user_id, career_goal_id, started_at, finished_at, status, jobs_evaluated, jobs_eligible, jobs_explained)
                VALUES (${USER}, ${goalId}, now() - interval '1 hour', now() - interval '55 minutes', 'completed', 10, 6, 3)`;
    await admin`INSERT INTO matching_runs (user_id, career_goal_id, started_at, status)
                VALUES (${USER}, ${goalId}, now(), 'running')`;

    const res = await GET();
    const body = await res.json();
    expect(body.run.status).toBe("running");
  });
});
