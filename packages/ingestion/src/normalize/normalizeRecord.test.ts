import { describe, it, expect } from "vitest";
import { normalizeRecord } from "./normalizeRecord";
import { NormalizeError, type SourceRef } from "../types";
import { greenhouseJobFixture, leverPostingFixture } from "../fixtures";

const greenhouse: SourceRef = { id: "s1", kind: "greenhouse", label: "gitlab", config: { slug: "gitlab" } };
const lever: SourceRef = { id: "s2", kind: "lever", label: "acme", config: { slug: "acme", companyName: "Acme" } };
const upload: SourceRef = { id: "s3", kind: "upload", label: "jobs.csv", config: {} };

describe("normalizeRecord — greenhouse", () => {
  const job = normalizeRecord(greenhouse, { externalId: "8556658002", payload: greenhouseJobFixture });

  it("maps identity, location and dates (first_published, never updated_at)", () => {
    expect(job.externalId).toBe("8556658002");
    expect(job.title).toBe("AI Engineer");
    expect(job.companyName).toBe("GitLab");
    expect(job.companyKey).toBe("gitlab");
    expect(job.locationRaw).toBe("Remote, United States");
    expect(job.countryCode).toBeNull();
    expect(job.workMode).toBe("remote");
    expect(job.url).toBe("https://job-boards.greenhouse.io/gitlab/jobs/8556658002");
    expect(job.postedAt?.toISOString()).toBe("2026-05-22T13:16:29.000Z");
  });

  it("decodes the escaped HTML into plain text", () => {
    expect(job.descriptionText).toContain("What You'll Do");
    expect(job.descriptionText).not.toMatch(/&lt;|<div/);
  });

  it("runs the rule extractors over the description", () => {
    expect(job.salary).toMatchObject({ min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true });
    expect(job.minExperience.years).toBe(5); // the "(nice to have)" line is ignored
    expect(job.sponsorship.value).toBe("not_offered");
  });
});

describe("normalizeRecord — lever", () => {
  const job = normalizeRecord(lever, { externalId: leverPostingFixture.id, payload: leverPostingFixture });

  it("uses structured country and workplaceType, joins all locations, and reads createdAt as epoch ms", () => {
    expect(job.title).toBe("Senior Data Engineer");
    expect(job.seniority).toBe("senior");
    expect(job.titleKey).toBe("data engineer");
    expect(job.companyName).toBe("Acme"); // Lever postings carry no company name: source config supplies it
    expect(job.countryCode).toBe("GB");
    expect(job.workMode).toBe("hybrid");
    expect(job.locationRaw).toBe("London; Stockholm");
    expect(job.employmentType).toBe("Permanent");
    expect(job.postedAt?.getTime()).toBe(leverPostingFixture.createdAt);
    expect(job.url).toBe(leverPostingFixture.hostedUrl);
  });

  it("includes the requirement lists in the description (descriptionPlain alone misses them)", () => {
    expect(job.descriptionText).toContain("We build the data platform.");
    expect(job.descriptionText).toContain("- 3+ years of experience with SQL");
    expect(job.descriptionText).toContain("equal opportunity employer");
    expect(job.minExperience.years).toBe(3);
  });
});

describe("normalizeRecord — upload", () => {
  it("normalizes a canonical row, parsing a structured salary cell with an explicit salary label", () => {
    const job = normalizeRecord(upload, {
      externalId: "u1",
      payload: {
        title: "Data Engineer", company: "Acme GmbH", location: "Berlin",
        description: "<p>5+ years of experience with SQL</p>", url: "https://acme.example/jobs/1",
        postedAt: "2026-08-01", employmentType: "Full-time", salary: "€60,000 - €80,000",
      },
    });
    expect(job.companyKey).toBe("acme");
    expect(job.salary).toMatchObject({ min: 60000, max: 80000, currency: "EUR", isParsed: true });
    expect(job.minExperience.years).toBe(5);
    expect(job.postedAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(job.descriptionText).toBe("5+ years of experience with SQL");
  });

  it("leaves optional fields null/unknown when absent, and an unparseable date null", () => {
    const job = normalizeRecord(upload, { externalId: "u2", payload: { title: "Analyst", company: "Beta", postedAt: "not a date" } });
    expect(job.postedAt).toBeNull();
    expect(job.locationRaw).toBeNull();
    expect(job.locationKey).toBe("");
    expect(job.workMode).toBe("unknown");
    expect(job.salary.isParsed).toBe(false);
    expect(job.salary.min).toBeNull();
    expect(job.descriptionText).toBe("");
  });
});

// Posting and upload content is hostile third-party data: every source kind must normalize ~200k-char
// pathological input quickly, and find nothing in it.
describe("normalizeRecord — adversarial input (end to end)", () => {
  const N = 200_000;
  // Expected descriptionText lengths. Greenhouse and upload run the text through the HTML stripper once.
  // Lever keeps descriptionPlain and additionalPlain verbatim and strips only the list content:
  // descriptionPlain + "\n\n" + ("L\n" + stripped list, or just "L" when nothing survives) + "\n\n" + additionalPlain.
  const shapes: { name: string; text: string; textLength: number; leverLength: number }[] = [
    { name: "'<' run", text: "<".repeat(N), textLength: N, leverLength: 3 * N + 6 },
    { name: "<script> openers", text: "<script>".repeat(25_000), textLength: 0, leverLength: 400_005 },
    { name: "&amp; run", text: "&amp;".repeat(40_000), textLength: 40_000, leverLength: 440_006 },
    { name: "digit run", text: "1".repeat(N), textLength: N, leverLength: 3 * N + 6 },
    { name: "$1, run", text: "$1,".repeat(70_000), textLength: 210_000, leverLength: 630_006 },
  ];

  const nothingFound = {
    salary: { raw: null, min: null, max: null, currency: null, period: null, isParsed: false },
    minExperience: { years: null, evidence: null },
    sponsorship: { value: "unknown", evidence: null, conflict: false },
    workMode: "unknown",
  };

  function timed(run: () => ReturnType<typeof normalizeRecord>) {
    const start = performance.now();
    const job = run();
    return { job, ms: performance.now() - start };
  }

  function expectNothingFound(job: ReturnType<typeof normalizeRecord>) {
    expect(job.salary).toEqual(nothingFound.salary);
    expect(job.minExperience).toEqual(nothingFound.minExperience);
    expect(job.sponsorship).toEqual(nothingFound.sponsorship);
    expect(job.workMode).toBe(nothingFound.workMode);
  }

  for (const { name, text, textLength, leverLength } of shapes) {
    it(`greenhouse content: ${name}`, () => {
      const { job, ms } = timed(() =>
        normalizeRecord(greenhouse, { externalId: "1", payload: { id: 1, title: "Engineer", content: text } }),
      );
      expect(ms).toBeLessThan(1000);
      expect(job.title).toBe("Engineer");
      expect(job.companyName).toBe("gitlab");
      expect(job.descriptionText).toHaveLength(textLength);
      expectNothingFound(job);
    });

    it(`lever descriptionPlain, list content and additionalPlain: ${name}`, () => {
      const { job, ms } = timed(() =>
        normalizeRecord(lever, {
          externalId: "1",
          payload: {
            id: "1",
            text: "Engineer",
            descriptionPlain: text,
            lists: [{ text: "L", content: text }],
            additionalPlain: text,
          },
        }),
      );
      expect(ms).toBeLessThan(1000);
      expect(job.title).toBe("Engineer");
      expect(job.companyName).toBe("Acme");
      expect(job.descriptionText).toHaveLength(leverLength);
      expectNothingFound(job);
    });

    it(`upload description and salary: ${name}`, () => {
      const { job, ms } = timed(() =>
        normalizeRecord(upload, {
          externalId: "1",
          payload: { title: "Engineer", company: "Acme", description: text, salary: text },
        }),
      );
      expect(ms).toBeLessThan(1000);
      expect(job.title).toBe("Engineer");
      expect(job.companyName).toBe("Acme");
      expect(job.descriptionText).toHaveLength(textLength);
      expectNothingFound(job);
    });
  }
});

describe("normalizeRecord — invalid payloads", () => {
  it("throws NormalizeError (no detail) for a greenhouse job without a title", () => {
    expect(() => normalizeRecord(greenhouse, { externalId: "1", payload: { id: 1, title: "" } })).toThrow(NormalizeError);
  });
  it("throws NormalizeError for an upload row without a company and for a non-object payload", () => {
    expect(() => normalizeRecord(upload, { externalId: "1", payload: { title: "X" } })).toThrow(NormalizeError);
    expect(() => normalizeRecord(lever, { externalId: "1", payload: "nope" })).toThrow(NormalizeError);
  });
});
