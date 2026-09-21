import { describe, it, expect } from "vitest";
import { formatDate, formatErrorClass, formatPosted, formatSalary, formatSponsorship, formatWorkMode, safeHttpUrl } from "./format";

const salary = (over: Partial<Parameters<typeof formatSalary>[0]> = {}) => ({
  raw: null, min: null, max: null, currency: null, period: null, isParsed: false, ...over,
});

describe("formatSalary", () => {
  it("shows a parsed range with its currency, and says when it was annualized", () => {
    expect(formatSalary(salary({ raw: "$150k", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true }))).toBe("USD 150,000–200,000 / year");
    expect(formatSalary(salary({ raw: "€3k", min: 36000, max: 36000, currency: "EUR", period: "month", isParsed: true }))).toBe("EUR 36,000 / year (annualized from monthly pay)");
  });

  it("shows an unparsed span verbatim and flags it as unclear", () => {
    expect(formatSalary(salary({ raw: "$150,000 - $200,000 or £100,000" }))).toBe("Unclear: “$150,000 - $200,000 or £100,000”");
  });

  it("says 'Not stated' — never zero — when there is no salary", () => {
    expect(formatSalary(salary())).toBe("Not stated");
  });
});

describe("formatPosted", () => {
  it("uses the posted date when there is one, otherwise labels first-seen as such", () => {
    expect(formatPosted({ postedAt: "2026-09-10T00:00:00Z", firstSeenAt: "2026-09-15T00:00:00Z" })).toBe("Posted Sep 10, 2026");
    expect(formatPosted({ postedAt: null, firstSeenAt: "2026-09-15T00:00:00Z" })).toBe("First seen Sep 15, 2026 (no posted date)");
    expect(formatDate("2026-01-01T00:00:00Z")).toBe("Jan 1, 2026");
  });
});

describe("labels", () => {
  it("never present unknown as a fact", () => {
    expect(formatWorkMode("unknown")).toBe("Work mode not stated");
    expect(formatSponsorship("unknown")).toBe("Sponsorship not stated");
    expect(formatSponsorship("not_offered")).toBe("No visa sponsorship");
  });
  it("maps every error class to a sentence and falls back for unrecognised ones", () => {
    expect(formatErrorClass("not_found")).toMatch(/Board not found/);
    expect(formatErrorClass("empty_result")).toMatch(/nothing was closed/);
    expect(formatErrorClass("something_new")).toMatch(/Something went wrong/);
  });
});

describe("safeHttpUrl", () => {
  it("passes http(s) URLs and drops everything else (third-party data must not become a script link)", () => {
    expect(safeHttpUrl("https://boards.example/jobs/1")).toBe("https://boards.example/jobs/1");
    expect(safeHttpUrl("http://boards.example/x")).toBe("http://boards.example/x");
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "not a url", "", null]) {
      expect(safeHttpUrl(bad as string | null), String(bad)).toBeNull();
    }
  });
});
