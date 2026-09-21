import { describe, it, expect } from "vitest";
import { mergePostings, comparePostings, type PostingForMerge } from "./merge";
import { makeNormalized } from "../testing/factories";
import type { NormalizedJob, SourceKind } from "../types";

const at = (iso: string) => new Date(iso);
function posting(
  id: string,
  sourceKind: SourceKind,
  overrides: Partial<NormalizedJob> = {},
  extra: Partial<PostingForMerge> = {}
): PostingForMerge {
  return {
    id, sourceKind, status: "open",
    firstSeenAt: at("2026-09-01T00:00:00Z"), lastSeenAt: at("2026-09-10T00:00:00Z"),
    normalized: makeNormalized(overrides), ...extra,
  };
}

describe("mergePostings", () => {
  it("maps a single posting straight through", () => {
    const merged = mergePostings([
      posting("p1", "greenhouse", {
        title: "Senior Data Engineer", workMode: "remote", employmentType: "Full-time", countryCode: "GB",
        salary: { raw: "€60k", min: 60000, max: 80000, currency: "EUR", period: "year", isParsed: true },
        minExperience: { years: 3, evidence: "3+ years" },
        sponsorship: { value: "offered", evidence: "we sponsor", conflict: false },
        postedAt: at("2026-08-01T00:00:00Z"),
      }),
    ]);
    expect(merged).toMatchObject({
      title: "Senior Data Engineer", titleKey: "data engineer", seniority: "senior", workMode: "remote",
      employmentType: "Full-time", countryCode: "GB",
      salaryMin: 60000, salaryMax: 80000, salaryCurrency: "EUR", salaryPeriod: "year", salaryIsParsed: true,
      minExperienceYears: 3, sponsorship: "offered", status: "open",
    });
    expect(merged.postedAt).toEqual(at("2026-08-01T00:00:00Z"));
    expect(merged.fieldProvenance.identity).toBe("p1");
  });

  it("orders postings: open before closed, then source rank, then recency, then id", () => {
    const gh = posting("a", "greenhouse");
    const up = posting("b", "upload", {}, { lastSeenAt: at("2026-09-20T00:00:00Z") });
    expect([up, gh].sort(comparePostings).map((p) => p.id)).toEqual(["a", "b"]); // rank beats recency
    const closedGh = posting("c", "greenhouse", {}, { status: "closed" });
    expect([closedGh, up].sort(comparePostings).map((p) => p.id)).toEqual(["b", "c"]); // open beats rank
    const older = posting("d", "lever", {}, { lastSeenAt: at("2026-09-01T00:00:00Z") });
    const newer = posting("e", "lever", {}, { lastSeenAt: at("2026-09-09T00:00:00Z") });
    expect([older, newer].sort(comparePostings).map((p) => p.id)).toEqual(["e", "d"]);
  });

  it("takes identity and description from the winner even when a lower-ranked source is newer", () => {
    const merged = mergePostings([
      posting("up", "upload", { title: "data engineer", descriptionText: "upload text" }, { lastSeenAt: at("2026-09-20T00:00:00Z") }),
      posting("gh", "greenhouse", { title: "Data Engineer", descriptionText: "greenhouse text" }),
    ]);
    expect(merged.title).toBe("Data Engineer");
    expect(merged.descriptionText).toBe("greenhouse text");
    expect(merged.fieldProvenance.identity).toBe("gh");
    expect(merged.fieldProvenance.description).toBe("gh");
  });

  it("fills fields the winner does not know from the next posting, and records where each came from", () => {
    const merged = mergePostings([
      posting("gh", "greenhouse", { workMode: "unknown", locationRaw: null }),
      posting("up", "upload", {
        workMode: "remote", employmentType: "Contract", locationRaw: "Lisbon",
        salary: { raw: "€50k", min: 50000, max: 50000, currency: "EUR", period: "year", isParsed: true },
        minExperience: { years: 2, evidence: "2+ years" },
        sponsorship: { value: "not_offered", evidence: "no visa", conflict: false },
      }),
    ]);
    expect(merged).toMatchObject({
      workMode: "remote", employmentType: "Contract", locationRaw: "Lisbon", locationKey: "lisbon",
      salaryMin: 50000, minExperienceYears: 2, sponsorship: "not_offered",
    });
    expect(merged.fieldProvenance).toMatchObject({
      identity: "gh", location: "up", workMode: "up", employmentType: "up", salary: "up", minExperience: "up", sponsorship: "up",
    });
  });

  it("prefers a parsed salary over a raw-only one, and a raw-only one over none", () => {
    const rawOnly = { raw: "$150k or £100k", min: null, max: null, currency: null, period: null, isParsed: false } as const;
    const parsed = { raw: "$90k", min: 90000, max: 90000, currency: "USD", period: "year", isParsed: true } as const;
    const a = mergePostings([posting("gh", "greenhouse", { salary: rawOnly }), posting("up", "upload", { salary: parsed })]);
    expect(a).toMatchObject({ salaryMin: 90000, salaryIsParsed: true });
    const b = mergePostings([posting("gh", "greenhouse"), posting("up", "upload", { salary: rawOnly })]);
    expect(b).toMatchObject({ salaryRaw: "$150k or £100k", salaryMin: null, salaryIsParsed: false });
    const c = mergePostings([posting("gh", "greenhouse")]);
    expect(c).toMatchObject({ salaryRaw: null, salaryMin: null, salaryIsParsed: false });
  });

  it("keeps a sponsorship conflict visible when no posting has a definite value", () => {
    const merged = mergePostings([
      posting("gh", "greenhouse", { sponsorship: { value: "unknown", evidence: "a || b", conflict: true } }),
    ]);
    expect(merged).toMatchObject({ sponsorship: "unknown", sponsorshipConflict: true, sponsorshipEvidence: "a || b" });
  });

  it("uses the earliest source-reported posted date across postings", () => {
    const merged = mergePostings([
      posting("gh", "greenhouse", { postedAt: at("2026-08-10T00:00:00Z") }),
      posting("up", "upload", { postedAt: at("2026-08-01T00:00:00Z") }),
    ]);
    expect(merged.postedAt).toEqual(at("2026-08-01T00:00:00Z"));
    expect(merged.fieldProvenance.postedAt).toBe("up");
    expect(mergePostings([posting("gh", "greenhouse")]).postedAt).toBeNull();
  });

  it("derives lifecycle: open while any posting is open; lastVerified is the newest open sighting", () => {
    const open = mergePostings([
      posting("gh", "greenhouse", {}, { status: "closed", lastSeenAt: at("2026-09-15T00:00:00Z") }),
      posting("up", "upload", {}, { lastSeenAt: at("2026-09-12T00:00:00Z"), firstSeenAt: at("2026-08-20T00:00:00Z") }),
    ]);
    expect(open.status).toBe("open");
    expect(open.lastVerifiedAt).toEqual(at("2026-09-12T00:00:00Z"));
    expect(open.firstSeenAt).toEqual(at("2026-08-20T00:00:00Z"));

    const closed = mergePostings([
      posting("gh", "greenhouse", {}, { status: "closed", lastSeenAt: at("2026-09-15T00:00:00Z") }),
      posting("up", "upload", {}, { status: "closed", lastSeenAt: at("2026-09-12T00:00:00Z") }),
    ]);
    expect(closed.status).toBe("closed");
    expect(closed.lastVerifiedAt).toEqual(at("2026-09-15T00:00:00Z"));
  });

  it("refuses an empty list", () => {
    expect(() => mergePostings([])).toThrow(/at least one posting/);
  });

  it("skips an Invalid Date postedAt whichever posting comes first", () => {
    const bad = posting("bad", "greenhouse", { postedAt: new Date("garbage") });
    const good = posting("good", "upload", { postedAt: at("2026-08-01T00:00:00Z") });
    for (const input of [[bad, good], [good, bad]]) {
      const merged = mergePostings(input);
      expect(merged.postedAt).toEqual(at("2026-08-01T00:00:00Z"));
      expect(merged.fieldProvenance.postedAt).toBe("good");
    }
    const onlyBad = mergePostings([bad]);
    expect(onlyBad.postedAt).toBeNull();
    expect(onlyBad.fieldProvenance).not.toHaveProperty("postedAt");
  });

  it("resolves a posted-date tie to the highest-precedence posting regardless of input order", () => {
    const gh = posting("gh", "greenhouse", { postedAt: at("2026-08-01T00:00:00Z") });
    const up = posting("up", "upload", { postedAt: at("2026-08-01T00:00:00Z") });
    expect(mergePostings([gh, up]).fieldProvenance.postedAt).toBe("gh");
    expect(mergePostings([up, gh]).fieldProvenance.postedAt).toBe("gh");
  });

  it("surfaces a sponsorship conflict from a non-winning posting and uses its evidence", () => {
    const merged = mergePostings([
      posting("gh", "greenhouse", { sponsorship: { value: "unknown", evidence: null, conflict: false } }),
      posting("up", "upload", { sponsorship: { value: "unknown", evidence: "a || b", conflict: true } }),
    ]);
    expect(merged).toMatchObject({ sponsorship: "unknown", sponsorshipConflict: true, sponsorshipEvidence: "a || b" });
    expect(merged.fieldProvenance.sponsorship).toBe("up");
  });

  it("breaks a full tie (status, rank, lastSeenAt) by lower id", () => {
    const b = posting("b", "greenhouse", { title: "Data Engineer B" });
    const a = posting("a", "greenhouse", { title: "Data Engineer A" });
    expect([b, a].sort(comparePostings).map((p) => p.id)).toEqual(["a", "b"]);
    expect(mergePostings([b, a]).fieldProvenance.identity).toBe("a");
    expect(mergePostings([a, b]).fieldProvenance.identity).toBe("a");
  });

  it("treats greenhouse and lever as equal rank, so recency decides", () => {
    const gh = posting("gh", "greenhouse", {}, { lastSeenAt: at("2026-09-01T00:00:00Z") });
    const lv = posting("lv", "lever", {}, { lastSeenAt: at("2026-09-05T00:00:00Z") });
    expect([gh, lv].sort(comparePostings).map((p) => p.id)).toEqual(["lv", "gh"]);
    expect([lv, gh].sort(comparePostings).map((p) => p.id)).toEqual(["lv", "gh"]);
  });

  it("leaves employmentType and minExperience provenance absent when no posting supplies them", () => {
    const merged = mergePostings([posting("gh", "greenhouse"), posting("up", "upload")]);
    expect(merged.employmentType).toBeNull();
    expect(merged.minExperienceYears).toBeNull();
    expect(merged.minExperienceEvidence).toBeNull();
    expect(merged.fieldProvenance).not.toHaveProperty("employmentType");
    expect(merged.fieldProvenance).not.toHaveProperty("minExperience");
    expect(merged.fieldProvenance).not.toHaveProperty("postedAt");
  });

  it("does not mutate its input array or the postings", () => {
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === "object" && !(value instanceof Date) && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const v of Object.values(value)) deepFreeze(v);
      }
      return value;
    };
    const input = deepFreeze([
      posting("up", "upload", { workMode: "remote", postedAt: at("2026-08-01T00:00:00Z") }),
      posting("gh", "greenhouse", { employmentType: "Full-time" }, { status: "closed" }),
    ]);
    expect(() => mergePostings(input)).not.toThrow();
    expect(input.map((p) => p.id)).toEqual(["up", "gh"]);
  });

  it("merges 200,000 postings (which overflowed the argument limit of Math.max spreads) quickly and exactly", () => {
    const kinds: SourceKind[] = ["greenhouse", "lever", "upload"];
    const base = Date.UTC(2026, 5, 1);
    const first = Date.UTC(2026, 0, 1);
    const shared = makeNormalized(); // one snapshot shared by every posting keeps generation cheap
    const N = 200_000;
    const postings: PostingForMerge[] = new Array<PostingForMerge>(N);
    for (let i = 0; i < N; i++) {
      postings[i] = {
        id: `p${String(i).padStart(6, "0")}`,
        sourceKind: kinds[i % 3],
        status: i % 2 === 0 ? "open" : "closed",
        firstSeenAt: new Date(first + i * 60_000),
        lastSeenAt: new Date(base + i * 60_000),
        normalized: shared,
      };
    }
    const started = performance.now();
    const merged = mergePostings(postings);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1500);
    expect(merged.status).toBe("open");
    expect(merged.firstSeenAt).toEqual(new Date(first));
    // Largest even index below 200,000 is 199,998 (199,998 % 3 === 0 -> greenhouse, top rank).
    expect(merged.lastVerifiedAt).toEqual(new Date(base + 199_998 * 60_000));
    expect(merged.fieldProvenance.identity).toBe("p199998");
  });

  it("merges 5,000 postings for one job without throwing, in under a second, with exact results", () => {
    const kinds: SourceKind[] = ["greenhouse", "lever", "upload"];
    const base = Date.UTC(2026, 5, 1);
    const postings: PostingForMerge[] = [];
    for (let i = 0; i < 5000; i++) {
      postings.push(
        posting(`p${String(i).padStart(5, "0")}`, kinds[i % 3], {}, {
          status: i % 2 === 0 ? "open" : "closed",
          firstSeenAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
          lastSeenAt: new Date(base + i * 60_000),
        })
      );
    }
    const started = performance.now();
    const merged = mergePostings(postings);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(merged.status).toBe("open");
    expect(merged.firstSeenAt).toEqual(new Date(Date.UTC(2026, 0, 1)));
    // Newest open sighting: the largest even index below 5000 is 4998.
    expect(merged.lastVerifiedAt).toEqual(new Date(base + 4998 * 60_000));
    // Winner: open (even i), rank 2 (greenhouse i%3==0 or lever i%3==1), newest lastSeen -> 4998 (i%3==0).
    expect(merged.fieldProvenance.identity).toBe("p04998");
  });
});
