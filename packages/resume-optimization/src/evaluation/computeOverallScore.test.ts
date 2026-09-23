import { describe, it, expect } from "vitest";
import { computeOverallScore } from "./computeOverallScore";
import type { EvaluationScores } from "../types";

const perfect: EvaluationScores = {
  requiredKeywordCoverage: 1, preferredKeywordCoverage: 1, semanticSimilarity: 1,
  factualConsistency: 1, actionVerbScore: 1, machineReadabilityScore: 1,
};

describe("computeOverallScore", () => {
  it("returns 100 when every factor is perfect", () => {
    expect(computeOverallScore(perfect)).toBe(100);
  });

  it("returns 0 when every factor is 0", () => {
    expect(computeOverallScore({ ...perfect, requiredKeywordCoverage: 0, preferredKeywordCoverage: 0, semanticSimilarity: 0, factualConsistency: 0, actionVerbScore: 0, machineReadabilityScore: 0 })).toBe(0);
  });

  it("redistributes semanticSimilarity's weight across the other factors when it is null", () => {
    const withNullSemantic = computeOverallScore({ ...perfect, semanticSimilarity: null, requiredKeywordCoverage: 0 });
    const withZeroSemantic = computeOverallScore({ ...perfect, semanticSimilarity: 0, requiredKeywordCoverage: 0 });
    // null semantic redistributes its 0.2 weight to the rest (raising the score vs. treating it as 0)
    expect(withNullSemantic).toBeGreaterThan(withZeroSemantic);
  });

  it("rounds to one decimal place", () => {
    const result = computeOverallScore({ ...perfect, requiredKeywordCoverage: 1 / 3 });
    expect(Number.isInteger(result * 10)).toBe(true);
  });
});
