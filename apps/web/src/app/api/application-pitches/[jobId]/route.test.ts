// apps/web/src/app/api/application-pitches/[jobId]/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob, insertCompanyResearch, insertPitch } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000d4",
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

const USER = "00000000-0000-0000-0000-0000000000d4";
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
const get = (jobId: string) => GET(new Request(`http://localhost/api/application-pitches/${jobId}`), { params: Promise.resolve({ jobId }) });

describe("GET /api/application-pitches/[jobId]", () => {
  it("returns 404 for a non-UUID jobId", async () => {
    expect((await get("not-a-uuid")).status).toBe(404);
  });

  it("returns no versions and null research when nothing has been generated", async () => {
    const jobId = await insertJob(admin, USER, {});
    const res = await get(jobId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versions: [], research: null });
  });

  it("returns versions newest first and the job's company research with unsafe URLs nulled", async () => {
    const jobId = await insertJob(admin, USER, { companyName: "Acme" });
    const researchId = await insertCompanyResearch(admin, USER, {
      companyKey: "acme",
      facts: [
        { factText: "Acme builds rockets.", sourceUrl: "https://acme.example", sourceTitle: "Acme" },
        { factText: "Bad link.", sourceUrl: "javascript:alert(1)" },
      ],
    });
    await insertPitch(admin, USER, jobId, { version: 1, companyResearchId: researchId });
    await insertPitch(admin, USER, jobId, { version: 2, origin: "user_edited", companyResearchId: researchId });

    const body = await (await get(jobId)).json();
    expect(body.versions.map((v: { version: number; origin: string }) => [v.version, v.origin])).toEqual([[2, "user_edited"], [1, "generated"]]);
    expect(body.research.companyName).toBe("Acme");
    expect(body.research.facts.map((f: { sourceUrl: string | null }) => f.sourceUrl)).toEqual(["https://acme.example", null]);
  });

  it("does not return research for a different company", async () => {
    const jobId = await insertJob(admin, USER, { companyName: "Acme" });
    await insertCompanyResearch(admin, USER, { companyKey: "globex", companyName: "Globex" });
    expect((await (await get(jobId)).json()).research).toBeNull();
  });
});
