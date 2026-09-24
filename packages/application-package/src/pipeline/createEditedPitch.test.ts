import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { createEditedPitch, EditPitchBodySchema, PitchEditError } from "./createEditedPitch";

const USER = "00000000-0000-0000-0000-0000000000c9";
let testDb: TestDb;

const BASE_BULLETS = [
  { kind: "company", text: "C0", supported: true, unsupportedReason: null, evidence: [{ id: "r:1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" }] },
  { kind: "role", text: "R0", supported: false, unsupportedReason: "cites no job requirement", evidence: [] },
  { kind: "candidate", text: "P0", supported: true, unsupportedReason: null, evidence: [{ id: "p:1", kind: "profile", text: "Built X", sourceUrl: null }] },
];

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(() => wipeUser(testDb.adminSql, USER));

async function seedPitch(title = "Data Engineer"): Promise<{ jobId: string; pitchId: string; researchId: string }> {
  const [job] = await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER}, 'Acme', 'acme', ${title}, ${title.toLowerCase()}, ${"h-" + title}, now(), now()) RETURNING id`;
  const [research] = await testDb.adminSql`
    INSERT INTO company_research (user_id, company_key, company_name, status, research_model, search_count, researched_at)
    VALUES (${USER}, ${"acme-" + title.toLowerCase().replace(/\W/g, "")}, 'Acme', 'ok', 'm', 1, '2026-09-20T00:00:00Z') RETURNING id`;
  const [pitch] = await testDb.adminSql`
    INSERT INTO application_pitches (user_id, job_id, version, origin, company_research_id, research_status_snapshot,
                                     researched_at_snapshot, bullets, requires_review, source_profile_content_hash, generation_model)
    VALUES (${USER}, ${job.id}, 1, 'generated', ${research.id}, 'ok', '2026-09-20T00:00:00Z',
            ${JSON.stringify(BASE_BULLETS)}::jsonb, true, 'hash', 'fast-model') RETURNING id`;
  return { jobId: job.id, pitchId: pitch.id, researchId: research.id };
}

describe("createEditedPitch", () => {
  it("creates the next version as user_edited, keeping the base's evidence and research snapshot", async () => {
    const { jobId, pitchId, researchId } = await seedPitch();
    const edited = await createEditedPitch(testDb.db, USER, jobId, { baseVersionId: pitchId, bullets: ["New C", "New R", "New P"] });

    expect(edited).toMatchObject({
      jobId, version: 2, origin: "user_edited", parentPitchId: pitchId, companyResearchId: researchId,
      researchStatusSnapshot: "ok", requiresReview: false, generationModel: null, sourceProfileContentHash: null,
    });
    expect(edited.researchedAtSnapshot?.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(edited.bullets).toEqual([
      { kind: "company", text: "New C", supported: null, unsupportedReason: null, evidence: BASE_BULLETS[0].evidence },
      { kind: "role", text: "New R", supported: null, unsupportedReason: null, evidence: [] },
      { kind: "candidate", text: "New P", supported: null, unsupportedReason: null, evidence: BASE_BULLETS[2].evidence },
    ]);
  });

  it("throws base_not_found when the base version belongs to a different job", async () => {
    const a = await seedPitch("Data Engineer");
    const b = await seedPitch("Analytics Engineer");
    await expect(
      createEditedPitch(testDb.db, USER, a.jobId, { baseVersionId: b.pitchId, bullets: ["x", "y", "z"] })
    ).rejects.toBeInstanceOf(PitchEditError);
  });

  it("throws base_not_found for an id that does not exist", async () => {
    const { jobId } = await seedPitch();
    await expect(
      createEditedPitch(testDb.db, USER, jobId, { baseVersionId: "22222222-2222-2222-2222-222222222222", bullets: ["x", "y", "z"] })
    ).rejects.toMatchObject({ errorClass: "base_not_found" });
  });
});

describe("EditPitchBodySchema", () => {
  const ok = { baseVersionId: "22222222-2222-2222-2222-222222222222", bullets: ["a", "b", "c"] };

  it("accepts a valid body and trims bullet text", () => {
    const parsed = EditPitchBodySchema.parse({ ...ok, bullets: ["  a  ", "b", "c"] });
    expect(parsed.bullets[0]).toBe("a");
  });

  it.each([
    ["two bullets", { ...ok, bullets: ["a", "b"] }],
    ["four bullets", { ...ok, bullets: ["a", "b", "c", "d"] }],
    ["an empty bullet", { ...ok, bullets: ["   ", "b", "c"] }],
    ["a 601-char bullet", { ...ok, bullets: ["x".repeat(601), "b", "c"] }],
    ["a NUL byte", { ...ok, bullets: ["a\u0000", "b", "c"] }],
    ["a lone surrogate", { ...ok, bullets: ["a\uD800", "b", "c"] }],
    ["a non-uuid base id", { ...ok, baseVersionId: "nope" }],
    ["an extra key", { ...ok, extra: true }],
    ["a non-string bullet", { ...ok, bullets: [1, "b", "c"] }],
  ])("rejects %s", (_label, body) => {
    expect(EditPitchBodySchema.safeParse(body).success).toBe(false);
  });
});
