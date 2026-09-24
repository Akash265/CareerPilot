import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";

vi.mock("./runCompanyResearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runCompanyResearch")>();
  return { ...actual, runCompanyResearch: vi.fn() };
});
import { runCompanyResearch, type CompanyResearchResult } from "./runCompanyResearch";
import { ensureCompanyResearch, CompanyResearchRefreshFailedError, type JobForResearch } from "./ensureCompanyResearch";

const USER = "00000000-0000-0000-0000-0000000000c8";
const ENV = { ANTHROPIC_MODEL_RESEARCH: "research-model", COMPANY_RESEARCH_MAX_SEARCHES: 5 };
const CLIENT = {} as Pick<Anthropic, "messages">;
let testDb: TestDb;

const okResult = (...texts: string[]): CompanyResearchResult => ({
  status: "ok", errorCode: null, researchModel: "research-model", searchCount: 2,
  webFacts: texts.map((factText) => ({ sourceKind: "web", factText, sourceUrl: "https://acme.example", sourceTitle: "Acme", citedText: factText })),
});
const failedResult: CompanyResearchResult = { status: "failed", errorCode: "api_error", researchModel: null, searchCount: 0, webFacts: [] };

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  vi.mocked(runCompanyResearch).mockReset();
  await wipeUser(testDb.adminSql, USER);
});

async function seedJob(opts: { title?: string; status?: "open" | "closed"; postingUrl?: string | null } = {}): Promise<JobForResearch> {
  const title = opts.title ?? "Data Engineer";
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, location_raw, work_mode, description_hash, first_seen_at, last_verified_at, status)
    VALUES (${USER}, 'Acme', 'acme', ${title}, ${title.toLowerCase()}, 'Berlin', 'remote', ${"h-" + title}, now(), now(), ${opts.status ?? "open"})
    RETURNING id`;
  if (opts.postingUrl !== undefined) {
    const [source] = await testDb.adminSql`
      INSERT INTO job_sources (user_id, kind, label, config, enabled)
      VALUES (${USER}, 'greenhouse', 'Acme', ${JSON.stringify({ slug: "acme-" + title.toLowerCase().replace(/\W/g, "") })}::jsonb, false)
      RETURNING id`;
    await testDb.adminSql`
      INSERT INTO job_postings (user_id, job_id, source_id, external_id, url, fingerprint, content_hash, normalized, status, first_seen_at, last_seen_at)
      VALUES (${USER}, ${job.id}, ${source.id}, ${"ext-" + title}, ${opts.postingUrl}, ${"fp-" + title}, 'h', '{}'::jsonb, 'open', now(), now())`;
  }
  return { id: job.id, companyKey: "acme", companyName: "Acme", title };
}

const call = (job: JobForResearch, opts?: { forceRefresh?: boolean }) => ensureCompanyResearch(testDb.db, USER, CLIENT, ENV, job, opts);

describe("ensureCompanyResearch", () => {
  it("on a miss, researches with only company/title/posting URL and stores web facts then internal facts", async () => {
    const job = await seedJob({ postingUrl: "https://boards.example/acme/1" });
    vi.mocked(runCompanyResearch).mockResolvedValue(okResult("Acme builds rockets."));

    const result = await call(job);

    expect(runCompanyResearch).toHaveBeenCalledWith(CLIENT, ENV, { companyName: "Acme", jobTitle: "Data Engineer", postingUrl: "https://boards.example/acme/1" });
    expect(result.research).toMatchObject({ companyKey: "acme", companyName: "Acme", status: "ok", researchModel: "research-model", searchCount: 2 });
    expect(result.facts.map((f) => [f.sourceKind, f.displayOrder])).toEqual([["web", 0], ["internal", 1], ["internal", 2], ["internal", 3]]);
    expect(result.facts[0]).toMatchObject({ factText: "Acme builds rockets.", sourceUrl: "https://acme.example" });
  });

  it("passes a null posting URL when the stored URL is not http(s)", async () => {
    const job = await seedJob({ postingUrl: "javascript:alert(1)" });
    vi.mocked(runCompanyResearch).mockResolvedValue(okResult("x."));
    await call(job);
    expect(vi.mocked(runCompanyResearch).mock.calls[0][2].postingUrl).toBeNull();
  });

  it("reuses an ok research row without calling the API again", async () => {
    const job = await seedJob();
    vi.mocked(runCompanyResearch).mockResolvedValue(okResult("x."));
    const first = await call(job);
    const second = await call(job);
    expect(runCompanyResearch).toHaveBeenCalledTimes(1);
    expect(second.research.id).toBe(first.research.id);
    expect(second.facts.map((f) => f.id)).toEqual(first.facts.map((f) => f.id));
  });

  it("reuses a no_results row (a genuine answer) but retries a failed row", async () => {
    const job = await seedJob();
    vi.mocked(runCompanyResearch).mockResolvedValueOnce({ ...failedResult });
    const failed = await call(job);
    expect(failed.research.status).toBe("failed");
    expect(failed.facts.every((f) => f.sourceKind === "internal")).toBe(true);
    expect(failed.facts.length).toBeGreaterThan(0);

    vi.mocked(runCompanyResearch).mockResolvedValueOnce({ status: "no_results", errorCode: null, researchModel: "research-model", searchCount: 1, webFacts: [] });
    const retried = await call(job);
    expect(retried.research.status).toBe("no_results");
    expect(retried.research.id).toBe(failed.research.id);

    await call(job);
    expect(runCompanyResearch).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh replaces all facts on the same research row", async () => {
    const job = await seedJob();
    vi.mocked(runCompanyResearch).mockResolvedValueOnce(okResult("Old fact."));
    const before = await call(job);
    vi.mocked(runCompanyResearch).mockResolvedValueOnce(okResult("New fact."));
    const after = await call(job, { forceRefresh: true });

    expect(after.research.id).toBe(before.research.id);
    expect(after.facts[0].factText).toBe("New fact.");
    const oldIds = new Set(before.facts.map((f) => f.id));
    expect(after.facts.some((f) => oldIds.has(f.id))).toBe(false);
    const [{ n }] = await testDb.adminSql`SELECT count(*)::int AS n FROM company_research_facts WHERE user_id = ${USER}`;
    expect(n).toBe(after.facts.length);
  });

  it("a failed forceRefresh over good research throws and leaves the stored research untouched", async () => {
    const job = await seedJob();
    vi.mocked(runCompanyResearch).mockResolvedValueOnce(okResult("Keep me."));
    const before = await call(job);
    vi.mocked(runCompanyResearch).mockResolvedValueOnce({ ...failedResult });

    await expect(call(job, { forceRefresh: true })).rejects.toThrow(CompanyResearchRefreshFailedError);

    const [row] = await testDb.adminSql`SELECT status, researched_at FROM company_research WHERE user_id = ${USER}`;
    expect(row.status).toBe("ok");
    expect(new Date(row.researched_at).getTime()).toBe(before.research.researchedAt.getTime());
    const facts = await testDb.adminSql`SELECT fact_text FROM company_research_facts WHERE user_id = ${USER} ORDER BY display_order`;
    expect(facts[0].fact_text).toBe("Keep me.");
  });

  it("internal facts include closed triggering job but not other closed jobs", async () => {
    await seedJob({ title: "Closed Other", status: "closed" });
    await seedJob({ title: "Open Other" });
    const job = await seedJob({ title: "Closed Trigger", status: "closed" });
    vi.mocked(runCompanyResearch).mockResolvedValue({ ...failedResult });
    const result = await call(job);
    const roles = result.facts.find((f) => f.factText.startsWith("Acme has"))!;
    expect(roles.factText).toBe("Acme has 2 roles in your job data: Closed Trigger, Open Other.");
  });

  it("two concurrent first-time calls leave exactly one research row with one set of facts", async () => {
    const job = await seedJob();
    vi.mocked(runCompanyResearch).mockResolvedValue(okResult("Only once."));
    const [a, b] = await Promise.all([call(job), call(job)]);
    expect(a.research.id).toBe(b.research.id);
    const [{ n: rows }] = await testDb.adminSql`SELECT count(*)::int AS n FROM company_research WHERE user_id = ${USER}`;
    const [{ n: facts }] = await testDb.adminSql`SELECT count(*)::int AS n FROM company_research_facts WHERE user_id = ${USER}`;
    expect(rows).toBe(1);
    expect(facts).toBe(b.facts.length);
  });
});
