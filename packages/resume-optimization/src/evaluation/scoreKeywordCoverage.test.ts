import { describe, it, expect } from "vitest";
import { scoreKeywordCoverage } from "./scoreKeywordCoverage";

describe("scoreKeywordCoverage", () => {
  it("scores 1 for a level with zero terms (vacuously satisfied)", () => {
    const result = scoreKeywordCoverage([], "Built a pipeline");
    expect(result).toEqual({ requiredKeywordCoverage: 1, preferredKeywordCoverage: 1 });
  });

  it("computes the fraction of required terms found, case-insensitively", () => {
    const result = scoreKeywordCoverage(
      [{ termText: "SQL", requirementLevel: "required" }, { termText: "Python", requirementLevel: "required" }],
      "Built a sql pipeline"
    );
    expect(result.requiredKeywordCoverage).toBe(0.5);
  });

  it("scores required and preferred independently", () => {
    const result = scoreKeywordCoverage(
      [{ termText: "SQL", requirementLevel: "required" }, { termText: "dbt", requirementLevel: "preferred" }],
      "Built a SQL pipeline"
    );
    expect(result).toEqual({ requiredKeywordCoverage: 1, preferredKeywordCoverage: 0 });
  });

  it("never needs escaping for a term containing regex metacharacters", () => {
    const result = scoreKeywordCoverage([{ termText: "C++", requirementLevel: "required" }], "5 years of C++ experience");
    expect(result.requiredKeywordCoverage).toBe(1);
  });

  it("ignores a blank term (never a vacuous always-match)", () => {
    const result = scoreKeywordCoverage([{ termText: "  ", requirementLevel: "required" }], "anything");
    expect(result.requiredKeywordCoverage).toBe(1);
  });
});
