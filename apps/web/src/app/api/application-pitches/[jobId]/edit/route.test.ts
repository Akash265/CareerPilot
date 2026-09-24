// apps/web/src/app/api/application-pitches/[jobId]/edit/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertPitch } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000d6",
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

const USER = "00000000-0000-0000-0000-0000000000d6";
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
const edit = (jobId: string, body: string) =>
  POST(
    new Request(`http://localhost/api/application-pitches/${jobId}/edit`, { method: "POST", body, headers: { "Content-Type": "application/json" } }),
    { params: Promise.resolve({ jobId }) }
  );

describe("POST /api/application-pitches/[jobId]/edit", () => {
  it("returns 404 for a non-UUID jobId", async () => {
    expect((await edit("not-a-uuid", "{}")).status).toBe(404);
  });

  it("returns 400 for a body that is not JSON", async () => {
    const jobId = await insertJob(admin, USER, {});
    expect((await edit(jobId, "{not json")).status).toBe(400);
  });

  it("returns 400 naming the field for an invalid body", async () => {
    const jobId = await insertJob(admin, USER, {});
    const pitchId = await insertPitch(admin, USER, jobId, {});
    const res = await edit(jobId, JSON.stringify({ baseVersionId: pitchId, bullets: ["only", "two"] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/bullets/);
  });

  it("returns 400 when the base version does not belong to this job", async () => {
    const jobId = await insertJob(admin, USER, { title: "Data Engineer" });
    const otherJobId = await insertJob(admin, USER, { title: "Analytics Engineer" });
    const otherPitch = await insertPitch(admin, USER, otherJobId, {});
    const res = await edit(jobId, JSON.stringify({ baseVersionId: otherPitch, bullets: ["a", "b", "c"] }));
    expect(res.status).toBe(400);
  });

  it("creates the next version as user_edited and returns it with 201", async () => {
    const jobId = await insertJob(admin, USER, {});
    const pitchId = await insertPitch(admin, USER, jobId, {});
    const res = await edit(jobId, JSON.stringify({ baseVersionId: pitchId, bullets: ["My C", "My R", "My P"] }));
    expect(res.status).toBe(201);
    const { pitch } = await res.json();
    expect(pitch).toMatchObject({ version: 2, origin: "user_edited", parentPitchId: pitchId, requiresReview: false });
    expect(pitch.bullets.map((b: { text: string; supported: boolean | null }) => [b.text, b.supported])).toEqual([
      ["My C", null], ["My R", null], ["My P", null],
    ]);
  });
});
