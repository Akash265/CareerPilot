import { describe, it, expect } from "vitest";
import { computeOverallScore } from "./computeOverallScore";
import type { FactorScores } from "../types";

const allOnes: FactorScores = {
  skillsScore: 1, experienceScore: 1, locationScore: 1, sponsorshipScore: 1,
  roleScore: 1, salaryScore: 1, industryScore: 1, freshnessScore: 1, semanticScore: 1,
};

describe("computeOverallScore", () => {
  it("returns 100 when every factor is a perfect 1", () => {
    expect(computeOverallScore(allOnes)).toBe(100);
  });
  it("returns 0 when every factor is 0 (salaryScore included)", () => {
    const allZero: FactorScores = { ...allOnes, salaryScore: 0, skillsScore: 0, experienceScore: 0, locationScore: 0, sponsorshipScore: 0, roleScore: 0, industryScore: 0, freshnessScore: 0, semanticScore: 0 };
    expect(computeOverallScore(allZero)).toBe(0);
  });
  it("redistributes a null salaryScore's weight across the other factors instead of zeroing it", () => {
    const withNullSalary: FactorScores = { ...allOnes, salaryScore: null };
    // Every other factor is still 1, so the weighted average of the known factors is still 1 -> 100,
    // not 95 (which is what treating null as 0 would give).
    expect(computeOverallScore(withNullSalary)).toBe(100);
  });
  it("weights skills (30%) more than freshness (5%)", () => {
    const weakSkills: FactorScores = { ...allOnes, skillsScore: 0 };
    const weakFreshness: FactorScores = { ...allOnes, freshnessScore: 0 };
    expect(computeOverallScore(weakSkills)).toBeLessThan(computeOverallScore(weakFreshness));
  });
});
