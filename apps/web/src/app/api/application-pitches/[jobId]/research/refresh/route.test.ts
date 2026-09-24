// apps/web/src/app/api/application-pitches/[jobId]/research/refresh/route.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertJob } from "../../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000d7",
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
vi.mock("@ai-career/application-package", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-career/application-package")>();
  return { ...actual, ensureCompanyResearch: vi.fn() };
});
import { ensureCompanyResearch, CompanyResearchRefreshFailedError } from "@ai-career/application-package";

const USER = "00000000-0000-0000-0000-0000000000d7";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  vi.mocked(ensureCompanyResearch).mockReset();
  await wipeMatchingData(admin, USER);
});
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");
const refresh = (jobId: string) =>
  POST(new Request(`http://localhost/api/application-pitches/${jobId}/research/refresh`, { method: "POST" }), { params: Promise.resolve({ jobId }) });

describe("POST /api/application-pitches/[jobId]/research/refresh", () => {
  it("returns 404 for a non-UUID jobId", async () => {
    expect((await refresh("not-a-uuid")).status).toBe(404);
  });

  it("returns 404 for a job that does not exist", async () => {
    expect((await refresh("33333333-3333-3333-3333-333333333333")).status).toBe(404);
    expect(ensureCompanyResearch).not.toHaveBeenCalled();
  });

  it("force-refreshes the job's company research and returns it", async () => {
    const jobId = await insertJob(admin, USER, { companyName: "Acme", title: "Data Engineer" });
    vi.mocked(ensureCompanyResearch).mockResolvedValue({
      research: { id: "r1", companyName: "Acme", status: "ok", researchedAt: new Date("2026-09-24T00:00:00Z"), searchCount: 2 },
      facts: [{ id: "f1", sourceKind: "web", factText: "A.", sourceUrl: "https://acme.example", sourceTitle: "Acme" }],
    } as never);

    const res = await refresh(jobId);

    expect(res.status).toBe(200);
    expect((await res.json()).research).toMatchObject({ id: "r1", status: "ok", searchCount: 2 });
    const [, userId, , , job, opts] = vi.mocked(ensureCompanyResearch).mock.calls[0];
    expect(userId).toBe(USER);
    expect(job).toEqual({ id: jobId, companyKey: "acme", companyName: "Acme", title: "Data Engineer" });
    expect(opts).toEqual({ forceRefresh: true });
  });

  it("returns 502 and says the existing research was kept when the refresh failed", async () => {
    const jobId = await insertJob(admin, USER, {});
    vi.mocked(ensureCompanyResearch).mockRejectedValue(new CompanyResearchRefreshFailedError());
    const res = await refresh(jobId);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/existing research was kept/i);
  });
});
