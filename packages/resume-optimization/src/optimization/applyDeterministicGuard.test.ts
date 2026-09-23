import { describe, it, expect } from "vitest";
import { applyDeterministicGuard } from "./applyDeterministicGuard";
import type { EvidenceCatalogEntry } from "./buildResumeSnapshot";
import type { OptimizeResumeDraft } from "./optimizeResumeSchema";

const catalog: EvidenceCatalogEntry[] = [
  { sourceFactId: "b1", sourceType: "work_experience_bullet", text: "Built a data pipeline", context: "Acme — Engineer" },
  { sourceFactId: "s1", sourceType: "skill", text: "Python", context: null },
];

function draft(selectedBullets: OptimizeResumeDraft["selectedBullets"]): OptimizeResumeDraft {
  return { selectedBullets, addedTerms: [], unsupportedClaimsDetected: [], requiresReview: false };
}

describe("applyDeterministicGuard", () => {
  it("accepts a citation whose sourceFactId is genuinely in the catalog", () => {
    const result = applyDeterministicGuard(
      catalog,
      draft([{ sourceFactId: "b1", optimizedText: "Built a SQL pipeline", changeType: "reworded", justification: "adds SQL" }])
    );
    expect(result.appliedBullets).toEqual([
      { sourceFactId: "b1", sourceType: "work_experience_bullet", originalText: "Built a data pipeline", optimizedText: "Built a SQL pipeline", changeType: "reworded", justification: "adds SQL" },
    ]);
    expect(result.rejectedClaims).toEqual([]);
  });

  it("rejects a citation whose sourceFactId is not in the catalog", () => {
    const result = applyDeterministicGuard(
      catalog,
      draft([{ sourceFactId: "fabricated-id", optimizedText: "Led a team of 10", changeType: "reworded", justification: "leadership" }])
    );
    expect(result.appliedBullets).toEqual([]);
    expect(result.rejectedClaims).toEqual([
      { sourceFactId: "fabricated-id", reason: "sourceFactId does not match any evidence item in this user's profile" },
    ]);
  });

  it("always reads originalText from the catalog, never from the model's own echo", () => {
    const result = applyDeterministicGuard(
      catalog,
      draft([{ sourceFactId: "b1", optimizedText: "Built a SQL pipeline", changeType: "unchanged", justification: "no change" }])
    );
    // even though the model marked this "unchanged", originalText must be the CATALOG's text, so a
    // mismatch between originalText and optimizedText is still visible to the guard's caller.
    expect(result.appliedBullets[0].originalText).toBe("Built a data pipeline");
  });

  it("handles a mix of valid and fabricated citations independently", () => {
    const result = applyDeterministicGuard(
      catalog,
      draft([
        { sourceFactId: "s1", optimizedText: "Python", changeType: "unchanged", justification: "kept as-is" },
        { sourceFactId: "made-up", optimizedText: "AWS Certified", changeType: "reworded", justification: "cert" },
      ])
    );
    expect(result.appliedBullets).toHaveLength(1);
    expect(result.appliedBullets[0].sourceFactId).toBe("s1");
    expect(result.rejectedClaims).toHaveLength(1);
    expect(result.rejectedClaims[0].sourceFactId).toBe("made-up");
  });

  it("returns empty results for an empty catalog and an empty draft", () => {
    const result = applyDeterministicGuard([], draft([]));
    expect(result).toEqual({ appliedBullets: [], rejectedClaims: [] });
  });

  it("rejects a repeated citation of a sourceFactId that was already applied, instead of applying it twice", () => {
    const result = applyDeterministicGuard(
      catalog,
      draft([
        { sourceFactId: "b1", optimizedText: "Built a SQL pipeline", changeType: "reworded", justification: "first citation" },
        { sourceFactId: "b1", optimizedText: "Built an ETL pipeline", changeType: "reworded", justification: "second citation" },
      ])
    );
    expect(result.appliedBullets).toHaveLength(1);
    expect(result.appliedBullets[0]).toEqual({
      sourceFactId: "b1", sourceType: "work_experience_bullet", originalText: "Built a data pipeline",
      optimizedText: "Built a SQL pipeline", changeType: "reworded", justification: "first citation",
    });
    expect(result.rejectedClaims).toEqual([
      { sourceFactId: "b1", reason: "sourceFactId was already cited by an earlier entry in this response" },
    ]);
  });
});
