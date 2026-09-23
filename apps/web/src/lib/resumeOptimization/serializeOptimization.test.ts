// apps/web/src/lib/resumeOptimization/serializeOptimization.test.ts
import { describe, it, expect } from "vitest";
import { toOptimizationView } from "./serializeOptimization";

const optimizationRow = {
  id: "opt1", jobId: "j1", careerGoalId: "g1", userId: "u1", version: 2,
  sourceProfileContentHash: "h1",
  selectedBullets: [{ sourceFactId: "b1", sourceType: "work_experience_bullet", originalText: "Built X", optimizedText: "Built X using SQL", changeType: "reworded", justification: "adds SQL" }],
  addedTerms: ["SQL"], unsupportedClaimsDetected: [], requiresReview: false,
  rejectedClaims: [{ sourceFactId: "fake1", reason: "not found" }],
  generationModel: "test-model", createdAt: new Date("2026-09-23T00:00:00Z"),
};
const evaluationRow = {
  id: "eval1", userId: "u1", resumeOptimizationId: "opt1",
  requiredKeywordCoverage: "1", preferredKeywordCoverage: "0.5", semanticSimilarity: "0.82",
  factualConsistency: "1", actionVerbScore: "1", machineReadabilityScore: "1",
  overallScore: "92.5", evaluatorVersion: "v1", createdAt: new Date("2026-09-23T00:00:00Z"),
};

describe("toOptimizationView", () => {
  it("converts 0-1 numeric fractions to 0-100 percentages, and passes overallScore through unscaled", () => {
    const view = toOptimizationView(optimizationRow as never, evaluationRow as never);
    expect(view.evaluation.requiredKeywordCoverage).toBe(100);
    expect(view.evaluation.preferredKeywordCoverage).toBe(50);
    expect(view.evaluation.semanticSimilarity).toBe(82);
    expect(view.evaluation.overallScore).toBe(92.5);
  });

  it("passes null semanticSimilarity through as null, not 0", () => {
    const view = toOptimizationView(optimizationRow as never, { ...evaluationRow, semanticSimilarity: null } as never);
    expect(view.evaluation.semanticSimilarity).toBeNull();
  });

  it("carries selectedBullets and rejectedClaims through unchanged", () => {
    const view = toOptimizationView(optimizationRow as never, evaluationRow as never);
    expect(view.selectedBullets).toEqual(optimizationRow.selectedBullets);
    expect(view.rejectedClaims).toEqual(optimizationRow.rejectedClaims);
  });
});
