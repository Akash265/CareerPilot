import { describe, it, expect } from "vitest";
import { extractMinExperience } from "./experience";

describe("extractMinExperience", () => {
  it("reads 'N+ years of experience' and keeps the sentence as evidence", () => {
    const r = extractMinExperience("Requirements\n- 5+ years of experience in software engineering");
    expect(r.years).toBe(5);
    expect(r.evidence).toContain("5+ years of experience");
  });

  it("allows a few words between 'years' and 'experience' ('8+ years of sales experience')", () => {
    expect(extractMinExperience("8+ years of sales experience").years).toBe(8);
    expect(extractMinExperience("Minimum 2years post-qualification experience").years).toBe(2);
  });

  it("takes the lower bound of a range and reads 'experience: N years'", () => {
    expect(extractMinExperience("2-4 years of experience with SQL").years).toBe(2);
    expect(extractMinExperience("Experience: at least 3 years").years).toBe(3);
  });

  it("keeps the lowest stated requirement (conservative: avoids false exclusion)", () => {
    expect(extractMinExperience("- 6+ years of experience in sales\n- 3+ years of experience in SaaS").years).toBe(3);
  });

  it("ignores optional lines: '(nice to have)', 'is a plus', '(preferred)', and 'Preferably N years'", () => {
    expect(extractMinExperience("- 6+ years of experience in sales\n- 2+ years of hospitality experience (nice to have)").years).toBe(6);
    expect(extractMinExperience("- 2+ years of experience with LLMs is a plus").years).toBeNull();
    expect(extractMinExperience("- 3+ years of experience with Go (preferred)").years).toBeNull();
    expect(extractMinExperience("- Preferably 3+ years of experience with Go").years).toBeNull();
  });

  it("does not treat 'preferably' AFTER the years as making them optional (real Stripe wording)", () => {
    const r = extractMinExperience("- 8+ years of sales experience, preferably selling a technical product");
    expect(r.years).toBe(8);
    expect(extractMinExperience("- 4+ years of experience, ideally in fintech").years).toBe(4);
  });

  it("only counts years tied to experience, and ignores company boasts", () => {
    expect(extractMinExperience("We have been in business for 10 years.").years).toBeNull();
    expect(extractMinExperience("We have over 15 years of experience serving customers.").years).toBeNull();
  });

  it("returns nulls when nothing matches", () => {
    expect(extractMinExperience("Great team, great product.")).toEqual({ years: null, evidence: null });
  });
});

describe("extractMinExperience — adversarial input (posting text is untrusted)", () => {
  const cases: Array<[string, string]> = [
    ["200k digits", "1".repeat(200_000)],
    ["repeated '5+ years '", "5+ years ".repeat(22_000)],
    ["repeated 'years of '", "years of ".repeat(22_000)],
    ["repeated '1 - '", "1 - ".repeat(50_000)],
    ["200k newlines", "\n".repeat(200_000)],
    ["1M letters", "a".repeat(1_000_000)],
  ];

  it.each(cases)("%s finishes in under a second and finds nothing", (_name, input) => {
    const started = performance.now();
    const result = extractMinExperience(input);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(result).toEqual({ years: null, evidence: null });
  });
});
