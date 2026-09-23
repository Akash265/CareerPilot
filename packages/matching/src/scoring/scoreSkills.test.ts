import { describe, it, expect } from "vitest";
import { scoreSkills } from "./scoreSkills";

describe("scoreSkills", () => {
  it("gives full credit when no skills are stated", () => {
    const result = scoreSkills([], "Senior Engineer", "We use Python and SQL.", 0.9);
    expect(result.score).toBe(1);
    expect(result.matches).toEqual([]);
  });

  it("finds a skill mentioned in the title or description, case-insensitively", () => {
    const result = scoreSkills(["Python", "Tableau"], "Data Engineer", "5 years of python required.", null);
    expect(result.matches).toEqual([
      { skill: "Python", found: true },
      { skill: "Tableau", found: false },
    ]);
    expect(result.lexicalHitRate).toBeCloseTo(0.5);
  });

  it("blends lexical hit rate 70/30 with semantic similarity when both are known", () => {
    const result = scoreSkills(["Python"], "Engineer", "python required", 0.4);
    // lexicalHitRate = 1 (found), semantic = 0.4 -> 0.7*1 + 0.3*0.4 = 0.82
    expect(result.score).toBeCloseTo(0.82);
  });

  it("falls back to pure lexical hit rate when semantic similarity is unavailable", () => {
    const result = scoreSkills(["Python", "SQL"], "Engineer", "python only", null);
    expect(result.score).toBeCloseTo(0.5);
  });

  it("clamps the score to [0, 1]", () => {
    const result = scoreSkills(["Python"], "Engineer", "python required", 1);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("ignores blank/whitespace-only skill entries instead of letting them inflate the hit rate", () => {
    // haystack.includes("") is always true in JS -- a blank entry must not count as a free "found".
    const result = scoreSkills(["Python", "", "   "], "Engineer", "no matching skills here", null);
    expect(result.matches).toEqual([{ skill: "Python", found: false }]);
    expect(result.lexicalHitRate).toBe(0);
  });

  it("gives full credit when every skill entry is blank", () => {
    const result = scoreSkills(["", "  "], "Engineer", "irrelevant text", null);
    expect(result.score).toBe(1);
    expect(result.matches).toEqual([]);
  });
});
