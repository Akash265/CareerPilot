import { describe, it, expect } from "vitest";
import { CASES } from "./cases";
import { scoreExtraction } from "./score";

describe("extraction eval set", () => {
  it("is large enough that a regression cannot hide (guards against the set shrinking)", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    const byField = Object.fromEntries(scoreExtraction(CASES).map((s) => [s.field, s.cases]));
    expect(byField.salary).toBeGreaterThanOrEqual(15);
    expect(byField.minExperience).toBeGreaterThanOrEqual(7);
    expect(byField.sponsorship).toBeGreaterThanOrEqual(10);
  });

  it("scores 100% precision and 100% recall on every field (the rules are deterministic, so any drop is a regression)", () => {
    for (const s of scoreExtraction(CASES)) {
      expect(s.precision, `${s.field} precision`).toBe(1);
      expect(s.recall, `${s.field} recall`).toBe(1);
    }
  });

  it("is consistent: scoring twice gives identical results (no hidden state in the extractors' global regexes)", () => {
    expect(scoreExtraction(CASES)).toEqual(scoreExtraction(CASES));
  });

  it("would notice a wrong answer (the scorer itself is not vacuous)", () => {
    const wrong = scoreExtraction([
      { name: "wrong", text: "The salary is $100,000 per year.", salary: { min: 1, max: 2, currency: "USD", period: "year" } },
      { name: "spurious", text: "The salary is $100,000 per year.", salary: null },
      { name: "missed", text: "nothing here", salary: { min: 1, max: 2, currency: "USD", period: "year" } },
    ]).find((s) => s.field === "salary")!;
    expect(wrong).toMatchObject({ tp: 0, fp: 2, fn: 2, tn: 0, precision: 0, recall: 0 });
  });
});
