import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertCareerGoal, insertMatch } from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000c6",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

import { vi } from "vitest";

const USER = "00000000-0000-0000-0000-0000000000c6";
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
const list = (qs = "") => GET(new Request(`http://localhost/api/matches${qs}`));

describe("GET /api/matches", () => {
  it("lists eligible matches sorted by overall score, best first, by default", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const lowJob = await insertJob(admin, USER, { title: "Low" });
    const highJob = await insertJob(admin, USER, { title: "High" });
    await insertMatch(admin, USER, lowJob, goalId, { overallScore: 40 });
    await insertMatch(admin, USER, highJob, goalId, { overallScore: 90 });

    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matches.map((m: { jobTitle: string }) => m.jobTitle)).toEqual(["High", "Low"]);
    expect(body.total).toBe(2);
  });

  it("lists ineligible matches with their reason when eligible=false", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, { title: "Excluded" });
    await insertMatch(admin, USER, jobId, goalId, { eligible: false, ineligibleReason: "You dismissed this job." });

    const res = await list("?eligible=false");
    const body = await res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].match.ineligibleReason).toBe("You dismissed this job.");
    expect(body.matches[0].match.overallScore).toBeNull();
  });
});
