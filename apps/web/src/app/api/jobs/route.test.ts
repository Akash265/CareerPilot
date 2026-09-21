import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { insertJob, insertPosting, insertSource, openAdminDb, wipeJobData } from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b5",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000b5";
const OTHER_USER = "00000000-0000-0000-0000-00000000b5b5";
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
const get = (query = "") => GET(new Request(`http://localhost/api/jobs${query}`));
const titles = async (query = "") => ((await (await get(query)).json()).jobs as { title: string }[]).map((j) => j.title);
const search = (q: string) => titles(`?q=${encodeURIComponent(q)}`);

describe("GET /api/jobs", () => {
  it("returns open jobs by default, newest posted first with unknown posted dates last, then by first seen", async () => {
    await insertJob(admin, USER, { title: "Posted Old", postedAt: "2026-08-01T00:00:00Z" });
    await insertJob(admin, USER, { title: "Posted New", postedAt: "2026-09-10T00:00:00Z" });
    await insertJob(admin, USER, { title: "Undated Seen Later", postedAt: null, firstSeenAt: "2026-09-15T00:00:00Z" });
    await insertJob(admin, USER, { title: "Undated Seen Earlier", postedAt: null, firstSeenAt: "2026-09-05T00:00:00Z" });
    await insertJob(admin, USER, { title: "Closed One", status: "closed", postedAt: "2026-09-11T00:00:00Z" });

    expect(await titles()).toEqual(["Posted New", "Posted Old", "Undated Seen Later", "Undated Seen Earlier"]);
    expect(await titles("?status=closed")).toEqual(["Closed One"]);
    expect((await titles("?status=all")).length).toBe(5);
  });

  it("returns salary as numbers with its raw span and parse flag, and never invents one", async () => {
    await insertJob(admin, USER, {
      title: "Paid", salaryRaw: "$150,000 - $200,000", salaryMin: 150000, salaryMax: 200000,
      salaryCurrency: "USD", salaryPeriod: "year", salaryIsParsed: true, sponsorship: "not_offered", minExperienceYears: 5,
    });
    await insertJob(admin, USER, { title: "Unpaid" });
    const { jobs } = await (await get()).json();
    const paid = jobs.find((j: { title: string }) => j.title === "Paid");
    const unpaid = jobs.find((j: { title: string }) => j.title === "Unpaid");
    expect(paid.salary).toEqual({ raw: "$150,000 - $200,000", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true });
    expect(paid).toMatchObject({ sponsorship: "not_offered", minExperienceYears: 5 });
    expect(unpaid.salary).toEqual({ raw: null, min: null, max: null, currency: null, period: null, isParsed: false });
  });

  it("filters by title or company, case-insensitively, treating % and _ literally", async () => {
    await insertJob(admin, USER, { title: "Data Engineer", companyName: "Acme" });
    await insertJob(admin, USER, { title: "Designer", companyName: "Data Corp" });
    await insertJob(admin, USER, { title: "100% Remote Analyst", companyName: "Beta" });
    await insertJob(admin, USER, { title: "Chef", companyName: "Gamma" });

    expect((await titles("?q=DATA")).sort()).toEqual(["Data Engineer", "Designer"]);
    expect(await titles("?q=100%25")).toEqual(["100% Remote Analyst"]); // "%" is not a wildcard
    expect(await titles("?q=_")).toEqual([]); // "_" is not a wildcard
  });

  it("filters by source and pages 25 at a time with an accurate total", async () => {
    const source = await insertSource(admin, USER, { slug: "s1" });
    for (let i = 0; i < 27; i++) await insertJob(admin, USER, { title: `Job ${String(i).padStart(2, "0")}`, firstSeenAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z` });
    const linked = await insertJob(admin, USER, { title: "Linked Job" });
    await insertPosting(admin, USER, linked, source);

    const page1 = await (await get()).json();
    expect(page1).toMatchObject({ page: 1, pageSize: 25, total: 28 });
    expect(page1.jobs).toHaveLength(25);
    expect((await (await get("?page=2")).json()).jobs).toHaveLength(3);
    expect(await titles(`?sourceId=${source}`)).toEqual(["Linked Job"]);
  });

  it("answers 400 for invalid query parameters", async () => {
    for (const query of ["?status=weird", "?page=0", "?sourceId=nope"]) {
      expect((await get(query)).status, query).toBe(400);
    }
  });
});

describe("GET /api/jobs -- hostile query parameters", () => {
  it("matches backslashes, quotes, semicolons and SQL fragments as literal text, leaving the table intact", async () => {
    await insertJob(admin, USER, { title: "'; DROP TABLE jobs; --", companyName: "Injector" });
    await insertJob(admin, USER, { title: "Back\\slash Engineer" });
    await insertJob(admin, USER, { title: "Double\\\\slash Engineer" });
    await insertJob(admin, USER, { title: "O'Brien Analyst" });
    await insertJob(admin, USER, { title: 'Say "hi" Manager' });
    await insertJob(admin, USER, { title: "Plain Chef" });

    await insertJob(admin, USER, { title: "50%_off Sales" });
    await insertJob(admin, USER, { title: "50%Xoff Sales" });
    await insertJob(admin, USER, { title: "50Xoff Sales" });

    const sqlTitle = "'; DROP TABLE jobs; --";
    const oneSlash = "Back\\slash Engineer";
    const twoSlashes = "Double\\\\slash Engineer";
    const sorted = async (q: string) => (await search(q)).sort();

    expect(await sorted(sqlTitle)).toEqual([sqlTitle]);
    expect(await sorted(";")).toEqual([sqlTitle]);
    expect(await sorted("--")).toEqual([sqlTitle]);
    expect(await sorted("\\")).toEqual([oneSlash, twoSlashes].sort()); // a lone backslash is the character, not an escape
    expect(await sorted("\\\\")).toEqual([twoSlashes]);
    expect(await sorted("\\%")).toEqual([]); // a backslash followed by a percent sign appears in no title
    expect(await sorted("Plain\\")).toEqual([]); // a trailing backslash must not break the pattern
    expect(await sorted("%_")).toEqual(["50%_off Sales"]); // neither character acts as a wildcard
    expect(await sorted("%")).toEqual(["50%Xoff Sales", "50%_off Sales"].sort());
    expect(await sorted("_")).toEqual(["50%_off Sales"]);
    expect(await sorted("'")).toEqual([sqlTitle, "O'Brien Analyst"].sort());
    expect(await sorted("O'Brien")).toEqual(["O'Brien Analyst"]);
    expect(await sorted('"hi"')).toEqual(['Say "hi" Manager']);
    expect(await sorted("' OR '1'='1")).toEqual([]);
    expect(await sorted("%' OR 1=1 --")).toEqual([]);

    const [{ n }] = await admin`SELECT count(*)::int AS n FROM jobs WHERE user_id = ${USER}`;
    expect(n).toBe(9);
    const [{ exists }] = await admin`SELECT to_regclass('public.jobs') IS NOT NULL AS exists`;
    expect(exists).toBe(true);
  });

  it("accepts a 100-character search and answers 400 for 101 characters", async () => {
    const hundred = "x".repeat(100);
    await insertJob(admin, USER, { title: hundred });
    expect(await search(hundred)).toEqual([hundred]);

    const res = await get(`?q=${"x".repeat(101)}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^q: /);
  });

  it("measures the 100-character limit after trimming", async () => {
    const hundred = "y".repeat(100);
    await insertJob(admin, USER, { title: hundred });
    expect(await search(`  ${hundred}  `)).toEqual([hundred]);
  });

  it("accepts pages 1..1000 (an empty page past the end) and answers 400 beyond that or for a non-integer page", async () => {
    await insertJob(admin, USER, { title: "Only Job" });

    const last = await get("?page=1000");
    expect(last.status).toBe(200);
    expect(await last.json()).toEqual({ jobs: [], page: 1000, pageSize: 25, total: 1 });

    for (const query of ["?page=1001", "?page=1.5", "?page=abc", "?page=-1", "?page="]) {
      const res = await get(query);
      expect(res.status, query).toBe(400);
      expect((await res.json()).error, query).toMatch(/^page: /);
    }
  });

  it("answers 400 for an empty status instead of falling back to the default", async () => {
    // z.enum(...).default("open") only applies to an absent key, and "?status=" makes the key present but empty.
    await insertJob(admin, USER, { title: "Open Job" });
    const res = await get("?status=");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^status: /);
    expect(await titles("")).toEqual(["Open Job"]); // absent status still defaults to open
  });

  it("ignores an empty search and never returns another user's jobs from the list, its total or a source filter", async () => {
    await insertJob(admin, USER, { title: "Mine" });
    await insertJob(admin, OTHER_USER, { title: "Theirs Open" });
    await insertJob(admin, OTHER_USER, { title: "Theirs Closed", status: "closed" });
    const theirSource = await insertSource(admin, OTHER_USER, { slug: "theirs" });
    const theirJob = await insertJob(admin, OTHER_USER, { title: "Theirs Linked" });
    await insertPosting(admin, OTHER_USER, theirJob, theirSource);

    const all = await (await get("?status=all&q=")).json();
    expect(all).toMatchObject({ page: 1, pageSize: 25, total: 1 });
    expect(all.jobs.map((j: { title: string }) => j.title)).toEqual(["Mine"]);
    expect(await search("Theirs")).toEqual([]);
    expect(await titles(`?status=all&sourceId=${theirSource}`)).toEqual([]);
    expect((await (await get(`?sourceId=${theirSource}`)).json()).total).toBe(0);
  });
});
