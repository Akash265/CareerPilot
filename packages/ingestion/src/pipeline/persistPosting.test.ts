import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { withUserContext } from "@ai-career/db";
import { persistPosting } from "./persistPosting";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";
import { makeNormalized } from "../testing/factories";
import type { NormalizedJob, SourceKind } from "../types";

const USER = "00000000-0000-0000-0000-0000000000a1";
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
const jobsOf = () => t.adminSql`SELECT * FROM jobs WHERE user_id = ${USER} ORDER BY title`;
const postingsOf = () => t.adminSql`SELECT * FROM job_postings WHERE user_id = ${USER} ORDER BY external_id`;
const candidates = () => t.adminSql`SELECT * FROM job_duplicate_candidates WHERE user_id = ${USER}`;

describe("persistPosting", () => {
  it("creates a canonical job and its posting for a new record", async () => {
    const source = await insertSource(t.adminSql, USER);
    const res = await persist(source, "greenhouse", makeNormalized({
      externalId: "e1", title: "Senior Data Engineer", workMode: "remote",
      salary: { raw: "$150k", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true },
    }));
    expect(res.outcome).toBe("created");

    const [job] = await jobsOf();
    expect(job).toMatchObject({
      title: "Senior Data Engineer", title_key: "data engineer", seniority: "senior", company_key: "acme",
      work_mode: "remote", status: "open", salary_currency: "USD", salary_is_parsed: true,
    });
    expect(Number(job.salary_min)).toBe(150000);
    expect(new Date(job.first_seen_at)).toEqual(T0);
    const [posting] = await postingsOf();
    expect(posting.job_id).toBe(job.id);
    expect(job.field_provenance.identity).toBe(posting.id);
  });

  it("recognises an unchanged record: bumps last-seen/verified and creates nothing", async () => {
    const source = await insertSource(t.adminSql, USER);
    const n = makeNormalized({ externalId: "e1" });
    await persist(source, "greenhouse", n, "h1", T0);
    const res = await persist(source, "greenhouse", n, "h1", T1);
    expect(res.outcome).toBe("unchanged");
    expect(await jobsOf()).toHaveLength(1);
    const [posting] = await postingsOf();
    expect(new Date(posting.last_seen_at)).toEqual(T1);
    expect(new Date((await jobsOf())[0].last_verified_at)).toEqual(T1);
  });

  it("updates the canonical job when the same posting's content changes", async () => {
    const source = await insertSource(t.adminSql, USER);
    await persist(source, "greenhouse", makeNormalized({ externalId: "e1", title: "Data Engineer" }), "h1", T0);
    const res = await persist(source, "greenhouse", makeNormalized({ externalId: "e1", title: "Data Platform Engineer" }), "h2", T1);
    expect(res.outcome).toBe("updated");
    expect(await postingsOf()).toHaveLength(1);
    const jobs = await jobsOf();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe("Data Platform Engineer");
  });

  it("tier 2: the same fingerprint from another source links to the same job, and the higher-ranked source wins", async () => {
    const gh = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    const up = await insertSource(t.adminSql, USER, { kind: "upload" });
    await persist(gh, "greenhouse", makeNormalized({ externalId: "g1", title: "Data Engineer", workMode: "remote" }), "hg", T0);
    // Same company/title-key/location/description, different casing and id, seen LATER, lower rank.
    const res = await persist(up, "upload", makeNormalized({ externalId: "u1", title: "data engineer", employmentType: "Full-time" }), "hu", T1);
    expect(res.outcome).toBe("linked");

    const jobs = await jobsOf();
    expect(jobs).toHaveLength(1);
    expect(await postingsOf()).toHaveLength(2);
    expect(jobs[0].title).toBe("Data Engineer"); // greenhouse wins identity despite upload being newer
    expect(jobs[0].employment_type).toBe("Full-time"); // filled from the upload posting
    const [ghPosting] = await t.adminSql`SELECT id FROM job_postings WHERE external_id = 'g1'`;
    expect(jobs[0].field_provenance.identity).toBe(ghPosting.id);
  });

  it("tier 3: a same-place, same-title job with different content is flagged as a duplicate candidate, never merged", async () => {
    const source = await insertSource(t.adminSql, USER);
    await persist(source, "greenhouse", makeNormalized({ externalId: "e1", descriptionText: "Version one of the text." }));
    await persist(source, "greenhouse", makeNormalized({ externalId: "e2", descriptionText: "A quite different description." }));
    expect(await jobsOf()).toHaveLength(2);
    const pairs = await candidates();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].status).toBe("pending");
    expect(pairs[0].job_id_a < pairs[0].job_id_b).toBe(true);
    expect(Number(pairs[0].similarity)).toBeGreaterThanOrEqual(0.8);
  });

  it("tier 3 is bounded: a new job is flagged against at most 20 look-alikes, and the pair invariants still hold", async () => {
    const source = await insertSource(t.adminSql, USER);
    let lastJobId = "";
    for (let i = 1; i <= 25; i++) {
      const res = await persist(source, "greenhouse", makeNormalized({ externalId: `e${i}`, descriptionText: `Distinct description number ${i}.` }));
      expect(res.outcome).toBe("created");
      lastJobId = res.jobId;
    }
    expect(await jobsOf()).toHaveLength(25);

    const pairs = await candidates();
    // 24 look-alikes exist for the last job, but only 20 are flagged. Jobs 1..21 flag 0..20 earlier ones; jobs 22..25 flag 20 each.
    expect(pairs.filter((p) => p.job_id_a === lastJobId || p.job_id_b === lastJobId)).toHaveLength(20);
    expect(pairs).toHaveLength(290);
    // Invariants: stored ordered (a < b), never the same pair twice, always pending, always above the threshold.
    expect(pairs.every((p) => p.job_id_a < p.job_id_b && p.status === "pending" && Number(p.similarity) >= 0.8)).toBe(true);
    expect(new Set(pairs.map((p) => `${p.job_id_a}|${p.job_id_b}`)).size).toBe(pairs.length);
  });

  it("does not flag jobs at a different location or with a dissimilar title", async () => {
    const source = await insertSource(t.adminSql, USER);
    await persist(source, "greenhouse", makeNormalized({ externalId: "e1", descriptionText: "one" }));
    await persist(source, "greenhouse", makeNormalized({ externalId: "e2", locationRaw: "Paris", descriptionText: "two" }));
    await persist(source, "greenhouse", makeNormalized({ externalId: "e3", title: "Office Chef", descriptionText: "three" }));
    expect(await jobsOf()).toHaveLength(3);
    expect(await candidates()).toHaveLength(0);
  });
});
