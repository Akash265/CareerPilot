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
          // The upload schema caps salary at 200 characters, so the hostile salary text is cut to the cap.
          payload: { title: "Engineer", company: "Acme", description: text, salary: text.slice(0, 200) },
        }),
      );
      expect(ms).toBeLessThan(1000);
      expect(job.title).toBe("Engineer");
      expect(job.companyName).toBe("Acme");
      expect(job.descriptionText).toHaveLength(textLength);
      expectNothingFound(job);
    });

    it(`upload rejects an oversized salary cell before it reaches the salary parser: ${name}`, () => {
      const start = performance.now();
      expect(() =>
        normalizeRecord(upload, { externalId: "1", payload: { title: "Engineer", company: "Acme", salary: text } }),
      ).toThrow(NormalizeError);
      expect(performance.now() - start).toBeLessThan(1000);
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

describe("normalizeRecord — dates never come out invalid", () => {
  const leverWith = (createdAt: unknown) =>
    normalizeRecord(lever, { externalId: "1", payload: { id: "1", text: "Engineer", createdAt } });

  it("returns null for a Lever createdAt outside the Date range", () => {
    expect(leverWith(1e20).postedAt).toBeNull();
    expect(leverWith(-1e20).postedAt).toBeNull();
    expect(leverWith(8.64e15 + 1e3).postedAt).toBeNull();
  });

  it("returns null for an infinite Lever createdAt (the schema accepts it, so the date guard must catch it)", () => {
    expect(leverWith(Infinity).postedAt).toBeNull();
    expect(leverWith(-Infinity).postedAt).toBeNull();
  });

  it("rejects a NaN Lever createdAt at the schema", () => {
    expect(() => leverWith(NaN)).toThrow(NormalizeError);
  });

  it("still returns the exact Date for a valid Lever createdAt, including the range edges", () => {
    expect(leverWith(1_700_000_000_000).postedAt?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(leverWith(8.64e15).postedAt?.getTime()).toBe(8.64e15);
    expect(leverWith(0).postedAt?.getTime()).toBe(0);
  });

  it("returns null for garbage Greenhouse first_published and upload postedAt", () => {
    const gh = normalizeRecord(greenhouse, {
      externalId: "1",
      payload: { id: 1, title: "Engineer", first_published: "not a date" },
    });
    expect(gh.postedAt).toBeNull();
    const up = normalizeRecord(upload, {
      externalId: "1",
      payload: { title: "Engineer", company: "Acme", postedAt: "definitely-not-a-date" },
    });
    expect(up.postedAt).toBeNull();
  });
});

describe("normalizeRecord — NormalizeError never carries posting content", () => {
  const MARKER = "SECRET-MARKER-123";
  const cases: [string, SourceRef, unknown][] = [
    ["greenhouse", greenhouse, { id: "not-a-number", title: MARKER, content: MARKER }],
    ["lever", lever, { id: 42, text: MARKER, descriptionPlain: MARKER }],
    ["upload", upload, { title: MARKER, description: MARKER }],
    // Valid schema, but the title normalizes to an empty key: the guard in assemble() rejects it.
    ["upload (empty title key)", upload, { title: "!!!", company: MARKER, description: MARKER }],
  ];

  for (const [kind, source, payload] of cases) {
    it(`${kind}: message, string form, JSON and stack header omit the payload`, () => {
      let caught: unknown;
      try {
        normalizeRecord(source, { externalId: "1", payload });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NormalizeError);
      const err = caught as NormalizeError;
      expect(err.message).toBe("record could not be normalized");
      expect(err.message).not.toContain(MARKER);
      expect(String(err)).not.toContain(MARKER);
      expect(JSON.stringify(err)).not.toContain(MARKER);
      expect((err.stack ?? "").split("\n")[0]).not.toContain(MARKER);
    });
  }
});

describe("normalizeRecord — unknown kind and empty names", () => {
  it("throws NormalizeError for an unknown source kind instead of returning undefined", () => {
    const bogus = { id: "s9", kind: "workday", label: "x", config: {} } as unknown as SourceRef;
    expect(() => normalizeRecord(bogus, { externalId: "1", payload: {} })).toThrow(NormalizeError);
  });

  it("falls back to the source label when the configured company name is empty or whitespace", () => {
    const blankGreenhouse: SourceRef = { ...greenhouse, config: { slug: "gitlab", companyName: "   " } };
    const blankLever: SourceRef = { ...lever, label: "acme-label", config: { slug: "acme", companyName: "" } };
    const gh = normalizeRecord(blankGreenhouse, { externalId: "1", payload: { id: 1, title: "Engineer" } });
    expect(gh.companyName).toBe("gitlab");
    const lv = normalizeRecord(blankLever, { externalId: "1", payload: { id: "1", text: "Engineer" } });
    expect(lv.companyName).toBe("acme-label");
  });

  it("rejects a record whose company or title normalizes to an empty key", () => {
    expect(() => normalizeRecord(upload, { externalId: "1", payload: { title: "Engineer", company: "***" } })).toThrow(NormalizeError);
    expect(() => normalizeRecord(upload, { externalId: "1", payload: { title: "!!!", company: "Acme" } })).toThrow(NormalizeError);
    expect(() => normalizeRecord(lever, { externalId: "1", payload: { id: "1", text: "???" } })).toThrow(NormalizeError);
    expect(() => normalizeRecord(greenhouse, { externalId: "1", payload: { id: 1, title: "---" } })).toThrow(NormalizeError);
  });
});

describe("normalizeRecord — unparseable upload salary", () => {
  it.each(["competitive", "DOE", "negotiable"])("invents no figure for salary cell %j", (salary) => {
    const job = normalizeRecord(upload, { externalId: "1", payload: { title: "Engineer", company: "Acme", salary } });
    expect(job.salary).toEqual({ raw: null, min: null, max: null, currency: null, period: null, isParsed: false });
  });
});

// Identity fields feed btree-indexed key columns; Postgres rejects an index row over ~2.7KB, so one hostile
// record must not be able to fail a whole persist run. Long values are cut to 500 characters before keys are
// built. (The upload schema already rejects anything over 500, so for uploads the cap is a no-op backstop.)
describe("normalizeRecord — identity field length caps", () => {
  const HUGE = 100_000;
  const CAP = 500;
  const ghJob = (over: Record<string, unknown>) =>
    normalizeRecord(greenhouse, { externalId: "1", payload: { id: 1, title: "Engineer", ...over } });
  const leverJob = (over: Record<string, unknown>, config: Record<string, unknown> = { slug: "acme", companyName: "Acme" }) =>
    normalizeRecord({ ...lever, config }, { externalId: "1", payload: { id: "1", text: "Engineer", ...over } });
  const uploadJob = (over: Record<string, unknown>) =>
    normalizeRecord(upload, { externalId: "1", payload: { title: "Engineer", company: "Acme", ...over } });

  function timed<T>(run: () => T): { value: T; ms: number } {
    const start = performance.now();
    const value = run();
    return { value, ms: performance.now() - start };
  }

  it("cuts a 100k-character location to exactly 500 characters with a bounded key", () => {
    const loc = "L".repeat(HUGE);
    for (const run of [() => ghJob({ location: { name: loc } }), () => leverJob({ categories: { location: loc } })]) {
      const { value: job, ms } = timed(run);
      expect(ms).toBeLessThan(1000);
      expect(job.locationRaw).toBe("L".repeat(CAP));
      expect(job.locationKey).toBe("l".repeat(CAP));
    }
  });

  it("cuts a 100k-character title to exactly 500 characters with a bounded key", () => {
    const title = "T".repeat(HUGE);
    for (const run of [() => ghJob({ title }), () => leverJob({ text: title })]) {
      const { value: job, ms } = timed(run);
      expect(ms).toBeLessThan(1000);
      expect(job.title).toBe("T".repeat(CAP));
      expect(job.titleKey).toBe("t".repeat(CAP));
    }
  });

  it("cuts a 100k-character company name to exactly 500 characters with a bounded key", () => {
    const company = "C".repeat(HUGE);
    for (const run of [() => ghJob({ company_name: company }), () => leverJob({}, { slug: "acme", companyName: company })]) {
      const { value: job, ms } = timed(run);
      expect(ms).toBeLessThan(1000);
      expect(job.companyName).toBe("C".repeat(CAP));
      expect(job.companyKey).toBe("c".repeat(CAP));
    }
  });

  it("trims after truncating, so a cut that lands on whitespace leaves no trailing space", () => {
    const job = ghJob({ title: `${"a".repeat(CAP - 2)}  tail` });
    expect(job.title).toBe("a".repeat(CAP - 2));
  });

  it("leaves values at exactly the cap untouched, and upload rows over it are still rejected by the schema", () => {
    const job = uploadJob({ title: "a".repeat(CAP), location: "b".repeat(CAP) });
    expect(job.title).toBe("a".repeat(CAP));
    expect(job.locationRaw).toBe("b".repeat(CAP));
    expect(() => uploadJob({ title: "a".repeat(CAP + 1) })).toThrow(NormalizeError);
  });

  it("rejects an external id over 200 characters with a content-free NormalizeError, and accepts exactly 200", () => {
    const marker = "SECRET-ID-MARKER";
    const tooLong = marker + "x".repeat(200 - marker.length + 1);
    expect(tooLong).toHaveLength(201);
    const attempts = [
      () => normalizeRecord(greenhouse, { externalId: tooLong, payload: { id: 1, title: "Engineer" } }),
      () => normalizeRecord(lever, { externalId: tooLong, payload: { id: "1", text: "Engineer" } }),
      () => normalizeRecord(upload, { externalId: tooLong, payload: { title: "Engineer", company: "Acme" } }),
    ];
    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NormalizeError);
      expect((caught as NormalizeError).message).toBe("record could not be normalized");
      expect(String(caught)).not.toContain(marker);
    }

    const ok = "y".repeat(200);
    expect(normalizeRecord(greenhouse, { externalId: ok, payload: { id: 1, title: "Engineer" } }).externalId).toBe(ok);
    expect(normalizeRecord(lever, { externalId: ok, payload: { id: "1", text: "Engineer" } }).externalId).toBe(ok);
    expect(normalizeRecord(upload, { externalId: ok, payload: { title: "Engineer", company: "Acme" } }).externalId).toBe(ok);
  });
});
