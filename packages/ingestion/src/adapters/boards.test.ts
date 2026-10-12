import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAshbyAdapter, createRecruiteeAdapter, createSmartRecruitersAdapter, createWorkableAdapter } from "./boards";
import { normalizeRecord } from "../normalize/normalizeRecord";
import type { RawRecord, SourceRef } from "../types";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): unknown => JSON.parse(readFileSync(path.join(FIX, `${name}.json`), "utf8"));

/** A fetch that answers from a URL → body map and records every URL it was asked for. */
function fakeFetch(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = input.toString();
    seen.push(url);
    if (!(url in routes)) return new Response("", { status: 404 });
    return new Response(JSON.stringify(routes[url]), { status: 200 });
  }) as typeof fetch;
  return { fn, seen };
}

async function collect(it: AsyncIterable<RawRecord>): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

const ref = (kind: SourceRef["kind"], slug: string, label = slug): SourceRef => ({ id: "s", kind, label, config: { slug } });

describe("Ashby adapter (Phase 12, D184)", () => {
  it("fetches the posting API with compensation and maps one listed job", async () => {
    const { fn, seen } = fakeFetch({ "https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true": fixture("ashby") });
    const records = await collect(createAshbyAdapter({ baseUrl: "https://api.ashbyhq.com", fetchFn: fn }).fetch(ref("ashby", "ashby", "Ashby")));
    expect(seen).toHaveLength(1);
    expect(records.map((r) => r.externalId)).toEqual(["7458d4e9-da2e-47bd-98cb-adfda43d42b2"]);
    const job = normalizeRecord(ref("ashby", "ashby", "Ashby"), records[0]);
    expect(job).toMatchObject({
      title: "Engineering Manager - EU", companyName: "Ashby", locationRaw: "Remote - European Union", workMode: "remote",
      url: "https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2", employmentType: "FullTime",
    });
    expect(job.postedAt?.toISOString()).toBe("2024-03-04T14:29:08.532Z");
    expect(job.salary).toMatchObject({ min: 110000, max: 185000, currency: "EUR", isParsed: true });
    expect(job.descriptionText.length).toBeGreaterThan(50);
  });

  it("skips unlisted jobs and rejects a slug that is not a safe identifier", async () => {
    const body = fixture("ashby") as { jobs: Record<string, unknown>[] };
    const { fn } = fakeFetch({ "https://api.ashbyhq.com/posting-api/job-board/x?includeCompensation=true": { jobs: [{ ...body.jobs[0], isListed: false }] } });
    expect(await collect(createAshbyAdapter({ baseUrl: "https://api.ashbyhq.com", fetchFn: fn }).fetch(ref("ashby", "x")))).toEqual([]);
    await expect(collect(createAshbyAdapter({ baseUrl: "https://api.ashbyhq.com", fetchFn: fn }).fetch(ref("ashby", "../x")))).rejects.toMatchObject({ errorClass: "invalid_slug" });
  });
});

describe("Workable adapter", () => {
  it("fetches the widget API with details and takes the company name from the account", async () => {
    const { fn } = fakeFetch({ "https://apply.workable.com/api/v1/widget/accounts/huggingface?details=true": fixture("workable") });
    const records = await collect(createWorkableAdapter({ baseUrl: "https://apply.workable.com", fetchFn: fn }).fetch(ref("workable", "huggingface")));
    expect(records.map((r) => r.externalId)).toEqual(["81B46579FE"]);
    const job = normalizeRecord(ref("workable", "huggingface"), records[0]);
    expect(job).toMatchObject({
      title: "Open-Source Machine Learning Engineer - EMEA Remote", companyName: "Hugging Face", locationRaw: "Paris, Île-de-France, France",
      countryCode: "FR", workMode: "remote", employmentType: "Full-time", url: "https://apply.workable.com/j/81B46579FE",
    });
    expect(job.postedAt?.toISOString().slice(0, 10)).toBe("2026-05-29");
  });
});

describe("Recruitee adapter", () => {
  it("fills the {slug} template, joins description and requirements, and reads the hybrid flag", async () => {
    const { fn, seen } = fakeFetch({ "https://bunq.recruitee.com/api/offers/": fixture("recruitee") });
    const records = await collect(createRecruiteeAdapter({ baseUrlTemplate: "https://{slug}.recruitee.com", fetchFn: fn }).fetch(ref("recruitee", "bunq")));
    expect(seen).toEqual(["https://bunq.recruitee.com/api/offers/"]);
    expect(records.map((r) => r.externalId)).toEqual(["2780064"]);
    const job = normalizeRecord(ref("recruitee", "bunq"), records[0]);
    expect(job).toMatchObject({
      title: "Transaction Review Lead", companyName: "bunq", locationRaw: "Amsterdam, Noord-Holland, Netherlands", countryCode: "NL",
      workMode: "hybrid", employmentType: "fulltime_permanent", url: "https://careers.bunq.com/o/transaction-review-lead-5",
    });
    expect(job.postedAt?.toISOString()).toBe("2026-10-12T13:59:52.000Z");
  });

  it("refuses a slug that could change the host", async () => {
    const { fn } = fakeFetch({});
    // Also not a DNS label: an underscore, a leading or trailing hyphen, or over 63 characters (review fix).
    for (const slug of ["evil.com/x", "a..b", "x@y", "a_b", "-ab", "ab-", "a".repeat(64)]) {
      await expect(collect(createRecruiteeAdapter({ baseUrlTemplate: "https://{slug}.recruitee.com", fetchFn: fn }).fetch(ref("recruitee", slug))), slug)
        .rejects.toMatchObject({ errorClass: "invalid_slug" });
    }
  });
});

describe("SmartRecruiters adapter", () => {
  const base = "https://api.smartrecruiters.com";
  const list = fixture("smartrecruiters-list");
  const detail = fixture("smartrecruiters-detail");

  it("lists postings, then fetches each one's detail for the description", async () => {
    const { fn, seen } = fakeFetch({
      [`${base}/v1/companies/BoschGroup/postings?limit=100&offset=0`]: list,
      [`${base}/v1/companies/BoschGroup/postings/744000155061284`]: detail,
    });
    const records = await collect(createSmartRecruitersAdapter({ baseUrl: base, fetchFn: fn }).fetch(ref("smartrecruiters", "BoschGroup")));
    expect(seen).toHaveLength(2);
    expect(records.map((r) => r.externalId)).toEqual(["744000155061284"]);
    const job = normalizeRecord(ref("smartrecruiters", "BoschGroup"), records[0]);
    expect(job).toMatchObject({
      title: "Sales Manager - Mobile Applications", companyName: "Bosch Group", countryCode: "GB", workMode: "hybrid",
      locationRaw: "St Neots, Cirencester, Wakefield, West Midlands, England, United Kingdom", employmentType: "Full-time",
      url: "https://jobs.smartrecruiters.com/BoschGroup/744000155061284-sales-manager-mobile-applications",
    });
    expect(job.descriptionText.length).toBeGreaterThan(50);
  });

  it("caps a board at maxPostings (newest first) and skips a posting whose detail fails", async () => {
    const items = [1, 2, 3].map((n) => ({ ...(list as { content: Record<string, unknown>[] }).content[0], id: String(n), releasedDate: `2026-10-0${n}T00:00:00Z` }));
    const { fn, seen } = fakeFetch({
      [`${base}/v1/companies/X/postings?limit=100&offset=0`]: { offset: 0, limit: 100, totalFound: 3, content: items },
      [`${base}/v1/companies/X/postings/3`]: { ...(detail as object), id: "3" },
    });
    const records = await collect(createSmartRecruitersAdapter({ baseUrl: base, fetchFn: fn, maxPostings: 2 }).fetch(ref("smartrecruiters", "X")));
    expect(records.map((r) => r.externalId)).toEqual(["3"]);
    expect(seen.filter((u) => /postings\/\d$/.test(u))).toEqual([`${base}/v1/companies/X/postings/3`, `${base}/v1/companies/X/postings/2`]);
  });
});
