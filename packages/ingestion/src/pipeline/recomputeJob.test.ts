import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { withUserContext } from "@ai-career/db";
import { persistPosting } from "./persistPosting";
import { recomputeJob } from "./recomputeJob";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";
import { makeNormalized } from "../testing/factories";
import type { NormalizedJob, SourceKind } from "../types";

const USER = "00000000-0000-0000-0000-0000000000a3";
const T0 = new Date("2026-09-21T10:00:00Z");
const T1 = new Date("2026-09-21T16:00:00Z");
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const persist = (sourceId: string, sourceKind: SourceKind, normalized: NormalizedJob, contentHash = "h1", now = T0) =>
  withUserContext(t.db, USER, (tx) => persistPosting(tx, { sourceId, sourceKind, normalized, contentHash, now }));
const jobRow = async (jobId: string) => (await t.adminSql`SELECT * FROM jobs WHERE id = ${jobId}`)[0];
const corrupt = (postingId: string) =>
  t.adminSql`UPDATE job_postings SET normalized = normalized - 'companyKey' WHERE id = ${postingId}`;

describe("recomputeJob", () => {
  it("excludes a posting whose stored snapshot fails shape validation, using only the still-valid posting", async () => {
    const gh = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    const up = await insertSource(t.adminSql, USER, { kind: "upload" });
    const created = await persist(gh, "greenhouse", makeNormalized({ externalId: "g1", title: "Data Engineer", workMode: "remote" }), "hg", T0);
    // Same fingerprint (company/title-key/location/description) links the second posting to the same job.
    await persist(up, "upload", makeNormalized({ externalId: "u1", title: "data engineer", employmentType: "Full-time" }), "hu", T1);
    expect(await t.adminSql`SELECT count(*)::int AS n FROM job_postings WHERE job_id = ${created.jobId}`.then((r) => r[0].n)).toBe(2);

    const [uploadPosting] = await t.adminSql`SELECT id FROM job_postings WHERE external_id = 'u1'`;
    await corrupt(uploadPosting.id);

    await withUserContext(t.db, USER, (tx) => recomputeJob(tx, created.jobId, T1));

    const job = await jobRow(created.jobId);
    // Only the still-valid greenhouse posting contributed: employmentType (which only the corrupted
    // upload posting supplied) must not appear, and identity fields still come from greenhouse.
    expect(job.title).toBe("Data Engineer");
    expect(job.employment_type).toBeNull();
  });

  it("does not throw and leaves the job's row unchanged when every posting's snapshot is unreadable", async () => {
    const gh = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    const up = await insertSource(t.adminSql, USER, { kind: "upload" });
    const created = await persist(gh, "greenhouse", makeNormalized({ externalId: "g1", title: "Data Engineer", workMode: "remote" }), "hg", T0);
    await persist(up, "upload", makeNormalized({ externalId: "u1", title: "data engineer", employmentType: "Full-time" }), "hu", T1);

    const postings = await t.adminSql`SELECT id FROM job_postings WHERE job_id = ${created.jobId}`;
    for (const p of postings) await corrupt(p.id);

    const before = await jobRow(created.jobId);
    await expect(withUserContext(t.db, USER, (tx) => recomputeJob(tx, created.jobId, T1))).resolves.toBeUndefined();
    const after = await jobRow(created.jobId);
    expect(after).toEqual(before);
  });
});
