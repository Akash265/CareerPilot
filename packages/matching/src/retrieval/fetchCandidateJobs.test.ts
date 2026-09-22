import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { withUserContext } from "@ai-career/db";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { fetchCandidateJobs } from "./fetchCandidateJobs";

const USER = "00000000-0000-0000-0000-0000000000e3";
let testDb: TestDb;

// vector(1024) is a fixed dimension; pad short test vectors with zeros so inserts succeed.
const vec = (entries: number[]): number[] => [...entries, ...new Array(1024 - entries.length).fill(0)];

beforeAll(async () => {
  testDb = await openTestDb();
});
afterAll(() => testDb.close());
beforeEach(() => wipeUser(testDb.adminSql, USER));

async function seedJob(opts: { title?: string; status?: "open" | "closed"; embedding?: number[] | null }) {
  await testDb.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash,
                       status, first_seen_at, last_verified_at, embedding)
    VALUES (${USER}, 'Acme', 'acme', ${opts.title ?? "Engineer"}, 'engineer', 'We use SQL.', ${"hash-" + Math.random()},
            ${opts.status ?? "open"}, now(), now(),
            ${opts.embedding === undefined ? null : opts.embedding === null ? null : testDb.adminSql`${JSON.stringify(opts.embedding)}::vector`})`;
}

describe("fetchCandidateJobs", () => {
  it("returns only open jobs", async () => {
    await seedJob({ title: "Open Role", status: "open" });
    await seedJob({ title: "Closed Role", status: "closed" });
    const rows = await withUserContext(testDb.db, USER, (tx) => fetchCandidateJobs(tx, null));
    expect(rows.map((r) => r.title)).toEqual(["Open Role"]);
  });

  it("returns null semanticSimilarity when no goal embedding is given", async () => {
    await seedJob({ embedding: vec([1, 0, 0]) });
    const rows = await withUserContext(testDb.db, USER, (tx) => fetchCandidateJobs(tx, null));
    expect(rows[0].semanticSimilarity).toBeNull();
  });

  it("returns null semanticSimilarity for a job with no embedding, even with a goal embedding given", async () => {
    await seedJob({ embedding: null });
    const rows = await withUserContext(testDb.db, USER, (tx) => fetchCandidateJobs(tx, vec([1, 0, 0])));
    expect(rows[0].semanticSimilarity).toBeNull();
  });

  it("computes cosine similarity of 1 for identical vectors and lower for dissimilar ones", async () => {
    await seedJob({ title: "Aligned", embedding: vec([1, 0, 0]) });
    await seedJob({ title: "Orthogonal", embedding: vec([0, 1, 0]) });
    const rows = await withUserContext(testDb.db, USER, (tx) => fetchCandidateJobs(tx, vec([1, 0, 0])));
    const aligned = rows.find((r) => r.title === "Aligned")!;
    const orthogonal = rows.find((r) => r.title === "Orthogonal")!;
    expect(aligned.semanticSimilarity).toBeCloseTo(1, 5);
    expect(orthogonal.semanticSimilarity).toBeCloseTo(0, 5);
  });
});
