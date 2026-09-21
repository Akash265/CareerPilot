import { describe, it, expect } from "vitest";
import { companyKey, titleKey, locationKey, descriptionHash, computeFingerprint } from "./keys";

describe("companyKey", () => {
  it("lowercases, strips punctuation, diacritics, a leading 'the' and legal suffixes", () => {
    expect(companyKey("Acme, Inc.")).toBe("acme");
    expect(companyKey("The Boston Consulting Group")).toBe("boston consulting group");
    expect(companyKey("Müller GmbH")).toBe("muller");
    expect(companyKey("AT&T")).toBe("at and t");
    expect(companyKey("Volvo AB")).toBe("volvo");
  });

  it("never strips the name down to nothing", () => {
    expect(companyKey("Inc")).toBe("inc");
  });
});

describe("titleKey", () => {
  it("strips seniority words from the key and reports them separately", () => {
    expect(titleKey("Senior Software Engineer (Backend)")).toEqual({ titleKey: "software engineer backend", seniority: "senior" });
    expect(titleKey("Sr. Data Engineer")).toEqual({ titleKey: "data engineer", seniority: "senior" });
    expect(titleKey("Staff Platform Manager, Loyalty")).toEqual({ titleKey: "platform manager loyalty", seniority: "staff" });
    expect(titleKey("Lead - Advanced Analytics")).toEqual({ titleKey: "advanced analytics", seniority: "lead" });
  });

  it("keeps level numerals, and returns null seniority when there is none", () => {
    expect(titleKey("Software Engineer II")).toEqual({ titleKey: "software engineer ii", seniority: null });
  });

  it("falls back to the plain key when stripping would leave nothing", () => {
    expect(titleKey("Lead")).toEqual({ titleKey: "lead", seniority: "lead" });
  });
});

describe("locationKey", () => {
  it("normalizes and sorts multi-location strings so order does not matter", () => {
    expect(locationKey("Remote, Canada; Remote, United Kingdom; Remote, United States")).toBe(
      "remote canada|remote united kingdom|remote united states"
    );
    expect(locationKey("Remote, United States; Remote, Canada")).toBe("remote canada|remote united states");
  });

  it("returns an empty key for missing locations", () => {
    expect(locationKey(null)).toBe("");
    expect(locationKey("   ")).toBe("");
  });
});

describe("descriptionHash / computeFingerprint", () => {
  it("ignores case and whitespace differences but not word differences", () => {
    expect(descriptionHash("Build  the\nPlatform")).toBe(descriptionHash("build the platform"));
    expect(descriptionHash("build the platform")).not.toBe(descriptionHash("build the product"));
  });

  it("fingerprints are stable and sensitive to every component", () => {
    const base = { companyKey: "acme", titleKey: "data engineer", locationKey: "london", descriptionHash: "h1" };
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }));
    expect(computeFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
    for (const k of Object.keys(base) as (keyof typeof base)[]) {
      expect(computeFingerprint({ ...base, [k]: "x" })).not.toBe(computeFingerprint(base));
    }
  });
});
