import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";

vi.mock("../research/runCompanyResearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../research/runCompanyResearch")>();
  return { ...actual, runCompanyResearch: vi.fn() };
});
vi.mock("../pitch/generatePitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pitch/generatePitch")>();
  return { ...actual, generatePitch: vi.fn() };
});
// Keep the real buildResumeSnapshot and error classes; only ensureJobRequirements (an LLM call) is faked.
vi.mock("@ai-career/resume-optimization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-career/resume-optimization")>();
  return { ...actual, ensureJobRequirements: vi.fn() };
});
import { runCompanyResearch } from "../research/runCompanyResearch";
import { generatePitch, PitchGenerationValidationError, type GeneratePitchInput } from "../pitch/generatePitch";
import { ensureJobRequirements, JobRequirementExtractionValidationError } from "@ai-career/resume-optimization";
import { runPitchGeneration, PitchGenerationError } from "./runPitchGeneration";
import type { PitchDraft } from "../pitch/pitchSchema";

const USER = "00000000-0000-0000-0000-0000000000c7";
const ENV = { ANTHROPIC_MODEL_FAST: "fast-model", ANTHROPIC_MODEL_RESEARCH: "research-model", COMPANY_RESEARCH_MAX_SEARCHES: 5 };
const CLIENT = {} as Pick<Anthropic, "messages">;
let testDb: TestDb;

/** Cites the first evidence item of each required kind -- the ids only exist at runtime. */
function groundedDraft(input: GeneratePitchInput): PitchDraft {
  const first = (kind: string) => input.evidence.filter((e) => e.kind === kind).slice(0, 1).map((e) => e.id);
  return {
    bullets: [
      { kind: "company", text: "Company bullet.", evidenceIds: first("research") },
      { kind: "role", text: "Role bullet.", evidenceIds: first("requirement") },
      { kind: "candidate", text: "Candidate bullet.", evidenceIds: first("profile") },
    ],
    requiresReview: false,
  };
}

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(async () => {
  vi.mocked(runCompanyResearch).mockReset();
  vi.mocked(generatePitch).mockReset();
  vi.mocked(ensureJobRequirements).mockReset();
  vi.mocked(runCompanyResearch).mockResolvedValue({
    status: "ok", errorCode: null, researchModel: "research-model", searchCount: 1,
    webFacts: [{ sourceKind: "web", factText: "Acme builds rockets.", sourceUrl: "https://acme.example", sourceTitle: "Acme", citedText: "x" }],
  });
  vi.mocked(ensureJobRequirements).mockResolvedValue([
    { id: "11111111-1111-1111-1111-111111111111", termText: "SQL", requirementLevel: "required" },
  ] as never);
  vi.mocked(generatePitch).mockImplementation(async (_client, _env, input) => groundedDraft(input));
  await wipeUser(testDb.adminSql, USER);
});

async function seed(opts: { match?: boolean; eligible?: boolean; profile?: boolean } = {}): Promise<string> {
  const [goal] = await testDb.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'Data roles', 1, 'parsed', 'confirmed', true) RETURNING id`;
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER}, 'Acme', 'acme', 'Data Engineer', 'data engineer', 'We use SQL.', 'hash-1', now(), now()) RETURNING id`;
  if (opts.match !== false) {
    await testDb.adminSql`
      INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, computed_at)
      VALUES (${USER}, ${job.id}, ${goal.id}, ${opts.eligible ?? true}, now())`;
  }
  if (opts.profile !== false) {
    const [exp] = await testDb.adminSql`
      INSERT INTO work_experiences (user_id, company, title, display_order) VALUES (${USER}, 'Globex', 'Engineer', 0) RETURNING id`;
    await testDb.adminSql`
      INSERT INTO work_experience_bullets (user_id, work_experience_id, text, display_order)
      VALUES (${USER}, ${exp.id}, 'Built a SQL pipeline', 0)`;
  }
  return job.id as string;
}

const run = (jobId: string) => runPitchGeneration(testDb.db, { userId: USER, jobId, anthropicClient: CLIENT, env: ENV });

describe("runPitchGeneration", () => {
  it("throws no_match when there is no job_matches row", async () => {
    const jobId = await seed({ match: false });
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "no_match" });
  });

  it("throws not_eligible for an ineligible match", async () => {
    const jobId = await seed({ eligible: false });
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "not_eligible" });
  });

  it("throws no_profile BEFORE any paid research call when the evidence catalog is empty", async () => {
    const jobId = await seed({ profile: false });
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "no_profile" });
    expect(runCompanyResearch).not.toHaveBeenCalled();
  });

  it("persists a guarded, generated version 1 with research snapshot fields", async () => {
    const jobId = await seed();
    const { pitch, research } = await run(jobId);

    expect(pitch).toMatchObject({
      jobId, version: 1, origin: "generated", parentPitchId: null, requiresReview: false,
      companyResearchId: research.research.id, researchStatusSnapshot: "ok", generationModel: "fast-model",
    });
    expect(pitch.researchedAtSnapshot?.getTime()).toBe(research.research.researchedAt.getTime());
    expect(pitch.sourceProfileContentHash).toMatch(/^[0-9a-f]+$/);
    const bullets = pitch.bullets as { kind: string; supported: boolean; evidence: { kind: string; text: string }[] }[];
    expect(bullets.map((b) => [b.kind, b.supported])).toEqual([["company", true], ["role", true], ["candidate", true]]);
    expect(bullets[0].evidence[0]).toMatchObject({ kind: "research", text: "Acme builds rockets." });
    expect(bullets[1].evidence[0]).toMatchObject({ kind: "requirement", text: "[required] SQL" });
    expect(bullets[2].evidence[0].text).toContain("Built a SQL pipeline");
  });

  it("passes the job and the full evidence index to generatePitch", async () => {
    const jobId = await seed();
    await run(jobId);
    const input = vi.mocked(generatePitch).mock.calls[0][2];
    expect(input).toMatchObject({ jobTitle: "Data Engineer", companyName: "Acme" });
    expect(new Set(input.evidence.map((e) => e.kind))).toEqual(new Set(["research", "requirement", "profile"]));
  });

  it("still generates when research failed, citing internal facts, and snapshots status failed", async () => {
    vi.mocked(runCompanyResearch).mockResolvedValue({ status: "failed", errorCode: "api_error", researchModel: null, searchCount: 0, webFacts: [] });
    const jobId = await seed();
    const { pitch } = await run(jobId);
    expect(pitch.researchStatusSnapshot).toBe("failed");
    const bullets = pitch.bullets as { supported: boolean; evidence: { text: string }[] }[];
    expect(bullets[0].supported).toBe(true);
    expect(bullets[0].evidence[0].text).toContain("Acme has 1 role in your job data");
  });

  it("stores a guard failure as supported=false with requiresReview=true", async () => {
    vi.mocked(generatePitch).mockImplementation(async (_c, _e, input) => {
      const d = groundedDraft(input);
      d.bullets[2] = { ...d.bullets[2], evidenceIds: ["p:does-not-exist"] };
      return d;
    });
    const jobId = await seed();
    const { pitch } = await run(jobId);
    const bullets = pitch.bullets as { supported: boolean; unsupportedReason: string | null }[];
    expect(bullets[2].supported).toBe(false);
    expect(bullets[2].unsupportedReason).toContain("does not exist");
    expect(pitch.requiresReview).toBe(true);
  });

  it("maps Anthropic.APIError, PitchGenerationValidationError and JobRequirementExtractionValidationError to unknown", async () => {
    const jobId = await seed();
    vi.mocked(generatePitch).mockRejectedValueOnce(new Anthropic.APIError(429, {}, "rate limited", undefined));
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "unknown" });
    vi.mocked(generatePitch).mockRejectedValueOnce(new PitchGenerationValidationError("bad"));
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "unknown" });
    vi.mocked(ensureJobRequirements).mockRejectedValueOnce(new JobRequirementExtractionValidationError("bad"));
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "unknown" });
  });

  it("rethrows an unexpected error unchanged", async () => {
    const jobId = await seed();
    vi.mocked(generatePitch).mockRejectedValueOnce(new TypeError("bug"));
    await expect(run(jobId)).rejects.toThrow(TypeError);
  });

  it("refuses to store bullet text containing a lone surrogate (unknown)", async () => {
    vi.mocked(generatePitch).mockImplementation(async (_c, _e, input) => {
      const d = groundedDraft(input);
      d.bullets[0] = { ...d.bullets[0], text: "Bad \uD800 text" };
      return d;
    });
    const jobId = await seed();
    await expect(run(jobId)).rejects.toMatchObject({ errorClass: "unknown" });
    const [{ n }] = await testDb.adminSql`SELECT count(*)::int AS n FROM application_pitches WHERE user_id = ${USER}`;
    expect(n).toBe(0);
  });

  it("allocates versions 1 and 2 to two concurrent runs", async () => {
    const jobId = await seed();
    const [a, b] = await Promise.all([run(jobId), run(jobId)]);
    expect([a.pitch.version, b.pitch.version].sort()).toEqual([1, 2]);
  });

  it("is a PitchGenerationError subclass of Error", () => {
    expect(new PitchGenerationError("no_match")).toBeInstanceOf(Error);
  });
});
