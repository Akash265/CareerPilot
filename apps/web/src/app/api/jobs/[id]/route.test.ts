import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { insertJob, insertPosting, insertSource, openAdminDb, wipeJobData } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b6",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000b6";
const OTHER_USER = "00000000-0000-0000-0000-00000000b6b6";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeJobData(admin, USER);
  await wipeJobData(admin, OTHER_USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await wipeJobData(admin, OTHER_USER);
  await admin.end();
});

const { GET } = await import("./route");
const get = (id: string) => GET(new Request(`http://localhost/api/jobs/${id}`), { params: Promise.resolve({ id }) });

describe("GET /api/jobs/[id]", () => {
  it("returns the job with its evidence, every posting and its source", async () => {
    const gh = await insertSource(admin, USER, { kind: "greenhouse", label: "GitLab", slug: "gitlab" });
    const up = await insertSource(admin, USER, { kind: "upload", label: "jobs.csv" });
    const id = await insertJob(admin, USER, {
      title: "AI Engineer", sponsorship: "not_offered", sponsorshipEvidence: "Visa sponsorship is not available.",
      minExperienceYears: 5, descriptionText: "Build agents.",
    });
    // Distinct first-seen dates, so the expected order does not depend on how ties happen to come back.
    await insertPosting(admin, USER, id, gh, { externalId: "g1", url: "https://boards.example/g1", firstSeenAt: "2026-09-01T00:00:00Z" });
    await insertPosting(admin, USER, id, up, { externalId: "u1", status: "closed", firstSeenAt: "2026-09-03T00:00:00Z" });

    const res = await get(id);
    expect(res.status).toBe(200);
    const { job } = await res.json();
    expect(job).toMatchObject({
      id, title: "AI Engineer", descriptionText: "Build agents.", sponsorship: "not_offered",
      sponsorshipEvidence: "Visa sponsorship is not available.", minExperienceYears: 5,
    });
    expect(job.postings.map((p: { sourceLabel: string; sourceKind: string; status: string }) => [p.sourceLabel, p.sourceKind, p.status])).toEqual([
      ["GitLab", "greenhouse", "open"],
      ["jobs.csv", "upload", "closed"],
    ]);
    expect(job.postings[0].url).toBe("https://boards.example/g1");
    expect(job.duplicateCandidates).toEqual([]);
  });

  it("orders postings that were first seen at the same moment by id, so the order is deterministic", async () => {
    const src = await insertSource(admin, USER, { kind: "greenhouse", label: "GitLab", slug: "gitlab" });
    const id = await insertJob(admin, USER, { title: "AI Engineer" });
    const inserted: string[] = [];
    for (let i = 0; i < 6; i++) inserted.push(await insertPosting(admin, USER, id, src, { externalId: `tie-${i}` }));

    const { job } = await (await get(id)).json();
    expect(job.postings.map((p: { id: string }) => p.id)).toEqual([...inserted].sort());
  });

  it("lists possible duplicates from either side of the pair, most similar first, without merging them", async () => {
    const a = await insertJob(admin, USER, { title: "Data Engineer" });
    const b = await insertJob(admin, USER, { title: "Data Engineers", locationRaw: "Berlin" });
    const c = await insertJob(admin, USER, { title: "Data Eng", locationRaw: "Berlin" });
    const [lo1, hi1] = [a, b].sort();
    const [lo2, hi2] = [a, c].sort();
    await admin`INSERT INTO job_duplicate_candidates (user_id, job_id_a, job_id_b, similarity) VALUES (${USER}, ${lo1}, ${hi1}, 0.9)`;
    await admin`INSERT INTO job_duplicate_candidates (user_id, job_id_a, job_id_b, similarity) VALUES (${USER}, ${lo2}, ${hi2}, 0.82)`;

    const { job } = await (await get(a)).json();
    expect(job.duplicateCandidates.map((d: { title: string; similarity: number; review: string }) => [d.title, Math.round(d.similarity * 100), d.review])).toEqual([
      ["Data Engineers", 90, "pending"],
      ["Data Eng", 82, "pending"],
    ]);
    const fromB = await (await get(b)).json();
    expect(fromB.job.duplicateCandidates.map((d: { title: string }) => d.title)).toEqual(["Data Engineer"]);
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect((await get("00000000-0000-0000-0000-00000000ffff")).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });

  it("answers 404 with the fixed error body for a well-formed id that does not exist", async () => {
    await insertJob(admin, USER, { title: "Exists" });
    const res = await get("11111111-2222-4333-8444-555555555555");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Job not found" });
  });

  it("answers 404 for another user's job, and never lists another user's job as a duplicate", async () => {
    const theirs = await insertJob(admin, OTHER_USER, { title: "Theirs" });
    const res = await get(theirs);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Job not found" });

    // A candidate pair that (wrongly) links my job to theirs must not leak their title through my job's detail.
    const mine = await insertJob(admin, USER, { title: "Mine" });
    const [lo, hi] = [mine, theirs].sort();
    await admin`INSERT INTO job_duplicate_candidates (user_id, job_id_a, job_id_b, similarity) VALUES (${USER}, ${lo}, ${hi}, 0.95)`;
    const { job } = await (await get(mine)).json();
    expect(job.title).toBe("Mine");
    expect(job.duplicateCandidates).toEqual([]);
  });
});
