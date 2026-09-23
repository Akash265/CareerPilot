// apps/web/src/app/api/resume-optimizations/[jobId]/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000fa",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000fa";
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
const get = (jobId: string) => GET(new Request(`http://localhost/api/resume-optimizations/${jobId}`), { params: Promise.resolve({ jobId }) });

describe("GET /api/resume-optimizations/[jobId]", () => {
  it("returns an empty list when no optimization has been generated yet", async () => {
    const jobId = await insertJob(admin, USER, {});
    const res = await get(jobId);
    expect(res.status).toBe(200);
    expect((await res.json()).optimizations).toEqual([]);
  });

  it("returns 404 for a non-UUID jobId", async () => {
    const res = await get("not-a-uuid");
    expect(res.status).toBe(404);
  });
});
