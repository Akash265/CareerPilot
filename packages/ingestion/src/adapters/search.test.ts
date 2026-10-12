import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSearchAdapter, museCategoriesFor, parseHnFirstLine, type SearchAdapterOptions } from "./search";
import { normalizeRecord } from "../normalize/normalizeRecord";
import type { RawRecord, SearchKind, SearchQuery, SourceRef } from "../types";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(FIX, `${name}.json`), "utf8"));

const QUERY: SearchQuery = { roles: ["Data Engineer"], locations: ["London"], remoteOnly: false, maxDaysOld: 30, maxPages: 2 };
const OPTS: Omit<SearchAdapterOptions, "fetchFn"> = {
  bases: {
    adzuna: "https://api.adzuna.com", jooble: "https://jooble.org", usajobs: "https://data.usajobs.gov", themuse: "https://www.themuse.com",
    remotive: "https://remotive.com", remoteok: "https://remoteok.com", arbeitnow: "https://www.arbeitnow.com", hn_hiring: "https://hn.algolia.com",
  },
  keys: { adzunaAppId: "id", adzunaAppKey: "key", adzunaCountries: ["gb"], joobleKey: "jk", usajobsKey: "uk", usajobsUserAgent: "me@example.com" },
};

interface Call { url: string; init?: RequestInit }
/** Answers by URL (exact, else by prefix); unknown URLs get 404. Records every call. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, init });
    const key = url in routes ? url : Object.keys(routes).find((k) => k.endsWith("*") && url.startsWith(k.slice(0, -1)));
    if (key === undefined) return new Response("", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const NO_GOAL = Symbol("no goal");
const ref = (kind: SearchKind, query: SearchQuery | typeof NO_GOAL = QUERY): SourceRef =>
  ({ id: "s", kind, label: kind, config: {}, ...(query === NO_GOAL ? {} : { query }) });
async function run(kind: SearchKind, routes: Record<string, unknown>, query: SearchQuery | typeof NO_GOAL = QUERY) {
  const { fn, calls } = fakeFetch(routes);
  const out: RawRecord[] = [];
  for await (const r of createSearchAdapter(kind, { ...OPTS, fetchFn: fn }).fetch(ref(kind, query))) out.push(r);
  return { records: out, calls };
}
const norm = (kind: SearchKind, r: RawRecord) => normalizeRecord(ref(kind), r);

describe("search adapters need a goal (Phase 12, D187)", () => {
  it("fail with no_active_goal when the source has no query, and no_search_terms when the goal has no roles", async () => {
    await expect(run("remotive", {}, NO_GOAL)).rejects.toMatchObject({ errorClass: "no_active_goal" });
    await expect(run("remotive", {}, { ...QUERY, roles: [] })).rejects.toMatchObject({ errorClass: "no_search_terms" });
  });

  it("fail with missing_api_key for a keyed provider without its key", async () => {
    const { fn } = fakeFetch({});
    const it = createSearchAdapter("adzuna", { ...OPTS, keys: { ...OPTS.keys, adzunaAppKey: undefined }, fetchFn: fn }).fetch(ref("adzuna"));
    await expect((async () => { for await (const r of it) void r; })()).rejects.toMatchObject({ errorClass: "missing_api_key" });
  });
});

describe("Remotive", () => {
  it("searches each role and maps the job as remote, with the publication date read as UTC", async () => {
    const { records, calls } = await run("remotive", { "https://remotive.com/api/remote-jobs?search=Data%20Engineer&limit=100": fixture("remotive") });
    expect(calls.map((c) => c.url)).toEqual(["https://remotive.com/api/remote-jobs?search=Data%20Engineer&limit=100"]);
    expect(records.map((r) => r.externalId)).toEqual(["2086540"]);
    expect(norm("remotive", records[0])).toMatchObject({
      title: "Inside Sales Contractor", companyName: "Credit Wellness, LLC", locationRaw: "Worldwide", workMode: "remote",
      employmentType: "full_time", url: "https://remotive.com/remote-jobs/sales/inside-sales-contractor-2086540",
    });
    expect(norm("remotive", records[0]).postedAt?.toISOString()).toBe("2026-10-08T21:47:32.000Z");
  });
});

describe("RemoteOK", () => {
  it("reads the feed, skips the legal notice, and maps a remote job without a zero salary", async () => {
    const { records } = await run("remoteok", { "https://remoteok.com/api": fixture("remoteok") });
    expect(records.map((r) => r.externalId)).toEqual(["1137497"]);
    const job = norm("remoteok", records[0]);
    expect(job).toMatchObject({ title: "Product Design Director", companyName: "Midnite", locationRaw: "United Kingdom", workMode: "remote" });
    expect(job.salary.isParsed).toBe(false);
    expect(job.postedAt?.toISOString()).toBe("2026-10-11T16:00:03.000Z");
  });
});

describe("Arbeitnow", () => {
  it("reads up to maxPages pages, stopping at an empty one, and converts epoch seconds", async () => {
    const { records, calls } = await run("arbeitnow", {
      "https://www.arbeitnow.com/api/job-board-api?page=1": fixture("arbeitnow"),
      "https://www.arbeitnow.com/api/job-board-api?page=2": { data: [] },
    });
    expect(calls).toHaveLength(2);
    expect(records.map((r) => r.externalId)).toEqual(["sr-technical-program-manager-tpm-ai-programs-vinted-engineering-berlin-320982"]);
    const job = norm("arbeitnow", records[0]);
    expect(job).toMatchObject({ companyName: "Vinteden", locationRaw: "Berlin" });
    expect(job.postedAt?.toISOString()).toBe(new Date(1791816905 * 1000).toISOString());
  });
});

describe("The Muse", () => {
  it("maps roles to its categories", () => {
    expect(museCategoriesFor(["Data Engineer"])).toEqual(["Data and Analytics", "Software Engineering"]);
    expect(museCategoriesFor(["Product Manager", "UX Designer"])).toEqual(["Product Management", "Design and UX"]);
    expect(museCategoriesFor(["Chef"])).toEqual([]);
  });

  it("queries its categories (plus the remote location for a remote-only goal) and keeps titles matching a role", async () => {
    const page = fixture("themuse") as { results: Record<string, unknown>[] };
    const matching = { ...page.results[0], id: 1, name: "Senior Data Engineer" };
    const { records, calls } = await run("themuse", { "https://www.themuse.com/api/public/jobs*": { ...page, results: [page.results[0], matching] } },
      { ...QUERY, remoteOnly: true, maxPages: 1 });
    expect(calls[0].url).toBe("https://www.themuse.com/api/public/jobs?page=0&category=Data%20and%20Analytics&category=Software%20Engineering&location=Flexible%20%2F%20Remote");
    expect(calls).toHaveLength(5); // maxPages x 5: the feed is not sorted by date and has no keyword search
    expect(records.map((r) => r.externalId)).toEqual(["1"]);
  });

  it("skips the provider when no role maps to a category", async () => {
    const { records, calls } = await run("themuse", {}, { ...QUERY, roles: ["Chef"] });
    expect(records).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("maps a job with its company, locations and landing page", () => {
    const job = norm("themuse", { externalId: "21947336", payload: (fixture("themuse") as { results: unknown[] }).results[0] });
    expect(job).toMatchObject({
      title: "EDA Engineer (RFIC Engineering)", companyName: "SpaceX", locationRaw: "Irvine, CA; Redmond, WA",
      url: "https://www.themuse.com/jobs/spacex/eda-engineer-rfic-engineering-c28c6e", seniority: null,
    });
  });
});

describe("HN Who is hiring", () => {
  it("finds the newest 'Who is hiring?' thread and yields each top-level comment", async () => {
    const { records, calls } = await run("hn_hiring", {
      "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10": fixture("hn-search"),
      "https://hn.algolia.com/api/v1/items/49922569": fixture("hn-item"),
    });
    expect(calls).toHaveLength(2);
    expect(records.map((r) => r.externalId)).toEqual(["49922584", "49922593", "49922609"]);
  });

  it("parses company, role, location and work mode from the first line, '|' or '—' separated", () => {
    expect(parseHnFirstLine("PrairieLearn (Remote US) — Full-Stack Software Engineer — TypeScript / Postgres / React / AI"))
      .toEqual({ company: "PrairieLearn", title: "Full-Stack Software Engineer", location: "Remote US", workMode: "remote" });
    expect(parseHnFirstLine("Shepherd (Series B) | ONSITE | San Francisco, CA & New York City, NY"))
      .toEqual({ company: "Shepherd", title: "Multiple roles", location: "San Francisco, CA & New York City, NY", workMode: "onsite" });
    expect(parseHnFirstLine("Sidekick Labs | Senior SWE, R&D Engineer, Intelligence Engineer | REMOTE (US Timezones) | Full-time | $170k to $230k Base"))
      .toEqual({ company: "Sidekick Labs", title: "Senior SWE, R&D Engineer, Intelligence Engineer", location: "REMOTE (US Timezones)", workMode: "remote" });
  });

  it("normalizes a comment into a job that links back to the comment", async () => {
    const { records } = await run("hn_hiring", {
      "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10": fixture("hn-search"),
      "https://hn.algolia.com/api/v1/items/49922569": fixture("hn-item"),
    });
    const job = norm("hn_hiring", records[2]);
    expect(job).toMatchObject({
      companyName: "Sidekick Labs", title: "Senior SWE, R&D Engineer, Intelligence Engineer", workMode: "remote",
      url: "https://news.ycombinator.com/item?id=49922609",
    });
    expect(job.salary).toMatchObject({ min: 170000, max: 230000, isParsed: true });
  });
});

describe("Adzuna", () => {
  it("searches country x role x location with its keys and date window, and maps a non-predicted salary", async () => {
    const { records, calls } = await run("adzuna", {
      "https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=id&app_key=key&what=Data%20Engineer&where=London&max_days_old=30&results_per_page=50&content-type=application%2Fjson": fixture("adzuna"),
    }, { ...QUERY, maxPages: 1 });
    expect(calls).toHaveLength(1);
    expect(records.map((r) => r.externalId)).toEqual(["4732811234"]);
    expect(norm("adzuna", records[0])).toMatchObject({
      title: "Senior Data Engineer", companyName: "Acme Analytics", locationRaw: "London, UK", countryCode: "GB",
      url: "https://www.adzuna.co.uk/jobs/land/ad/4732811234",
    });
    expect(norm("adzuna", records[0]).salary).toMatchObject({ min: 60000, max: 75000, isParsed: true });
  });
});

describe("Jooble", () => {
  it("POSTs keywords/location/page to /api/{key} and takes the id from the link (the numeric id overflows a double)", async () => {
    const { records, calls } = await run("jooble", { "https://jooble.org/api/jk": fixture("jooble") }, { ...QUERY, maxPages: 1 });
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ keywords: "Data Engineer", location: "London", page: "1" });
    expect(records.map((r) => r.externalId)).toEqual(["-7120334219118826752"]);
    expect(norm("jooble", records[0])).toMatchObject({ title: "Data Engineer", companyName: "Beispiel GmbH", locationRaw: "Berlin" });
  });
});

describe("USAJobs", () => {
  it("sends its key and registered email as headers and maps a federal job in the US", async () => {
    const { records, calls } = await run("usajobs", {
      "https://data.usajobs.gov/api/Search?Keyword=Data%20Engineer&LocationName=London&DatePosted=30&ResultsPerPage=100&Page=1": fixture("usajobs"),
    }, { ...QUERY, maxPages: 1 });
    expect(calls[0].init?.headers).toMatchObject({ "authorization-key": "uk", "user-agent": "me@example.com" });
    expect(records.map((r) => r.externalId)).toEqual(["812345600"]);
    const job = norm("usajobs", records[0]);
    expect(job).toMatchObject({ title: "Data Scientist", companyName: "Department of Energy", countryCode: "US", locationRaw: "Washington, District of Columbia" });
    expect(job.salary).toMatchObject({ min: 120579, max: 156755, period: "year", isParsed: true });
    expect(job.postedAt?.toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });
});

describe("request budget", () => {
  it("yields a job once per run even when several queries return it", async () => {
    const { records, calls } = await run("remotive", { "https://remotive.com/*": fixture("remotive") }, { ...QUERY, roles: ["Data Engineer", "Analytics Engineer"] });
    expect(calls).toHaveLength(2);
    expect(records.map((r) => r.externalId)).toEqual(["2086540"]);
  });

  it("stops after 50 requests per run, however many roles x locations x pages the goal asks for", async () => {
    const roles = ["a", "b", "c", "d", "e"];
    const locations = ["1", "2", "3", "4", "5"];
    const one = (fixture("adzuna") as { results: Record<string, unknown>[] }).results[0];
    const fullPage = { results: Array.from({ length: 50 }, (_, i) => ({ ...one, id: String(i) })) };
    const { calls } = await run("adzuna", { "https://api.adzuna.com/*": fullPage }, { ...QUERY, roles, locations, maxPages: 3 });
    expect(calls).toHaveLength(50);
  });
});
