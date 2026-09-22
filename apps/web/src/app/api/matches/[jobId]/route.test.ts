import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { eq } from "drizzle-orm";
import { schema, withUserContext, createDbClient } from "@ai-career/db";
import { openAdminDb, wipeMatchingData, insertJob, insertCareerGoal, insertMatch } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000c5",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000c5";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { GET, PATCH } = await import("./route");
const get = (jobId: string) => GET(new Request(`http://localhost/api/matches/${jobId}`), { params: Promise.resolve({ jobId }) });
const patch = (jobId: string, body: unknown) =>
  PATCH(new Request(`http://localhost/api/matches/${jobId}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ jobId }) });

describe("GET /api/matches/[jobId]", () => {
  it("returns the job detail and match fields together", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, { title: "Data Engineer" });
    await insertMatch(admin, USER, jobId, goalId, { overallScore: 82 });

    const res = await get(jobId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.title).toBe("Data Engineer");
    expect(body.match.overallScore).toBe(82);
  });

  it("answers 404 when no match row exists for the job", async () => {
    const jobId = await insertJob(admin, USER);
    expect((await get(jobId)).status).toBe(404);
  });

  it("answers 404 for an unknown or malformed job id", async () => {
    expect((await get("00000000-0000-0000-0000-00000000ffff")).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });
});

describe("PATCH /api/matches/[jobId]", () => {
  it("sets userAction to 'dismissed' and stamps userActionAt", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER);
    await insertMatch(admin, USER, jobId, goalId);

    const res = await patch(jobId, { userAction: "dismissed" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.match.userAction).toBe("dismissed");

    const db = createDbClient({ DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test" });
    const [row] = await withUserContext(db, USER, (tx) => tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)));
    expect(row.userActionAt).not.toBeNull();
  });

  it("answers 400 on an invalid userAction value", async () => {
    const goalId = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER);
    await insertMatch(admin, USER, jobId, goalId);
    expect((await patch(jobId, { userAction: "nope" })).status).toBe(400);
  });

  it("answers 404 when no match row exists for the job", async () => {
    const jobId = await insertJob(admin, USER);
    expect((await patch(jobId, { userAction: "saved" })).status).toBe(404);
  });
});
