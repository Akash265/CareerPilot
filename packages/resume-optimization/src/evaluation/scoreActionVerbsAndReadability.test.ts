import { describe, it, expect } from "vitest";
import { scoreActionVerbsAndReadability } from "./scoreActionVerbsAndReadability";

describe("scoreActionVerbsAndReadability", () => {
  it("scores 1/1 for empty input (nothing to fault)", () => {
    expect(scoreActionVerbsAndReadability([])).toEqual({ actionVerbScore: 1, machineReadabilityScore: 1 });
  });

  it("scores actionVerbScore against work_experience_bullet entries only", () => {
    const result = scoreActionVerbsAndReadability([
      { sourceType: "work_experience_bullet", optimizedText: "Built a data pipeline serving 10 teams daily" },
      { sourceType: "skill", optimizedText: "Python" },
    ]);
    // skill entries are excluded from actionVerbScore's denominator; "Python" alone would otherwise
    // wrongly fail an action-verb check that was never meant to apply to it.
    expect(result.actionVerbScore).toBe(1);
  });

  it("penalizes a bullet that does not open with a recognized action verb", () => {
    const result = scoreActionVerbsAndReadability([
      { sourceType: "work_experience_bullet", optimizedText: "Responsible for the data pipeline architecture" },
    ]);
    expect(result.actionVerbScore).toBe(0);
  });

  it("penalizes a bullet outside the sane word-count range for machineReadabilityScore", () => {
    const result = scoreActionVerbsAndReadability([
      { sourceType: "work_experience_bullet", optimizedText: "Built X" },
    ]);
    expect(result.machineReadabilityScore).toBe(0);
  });

  it("scores machineReadabilityScore across all applied entries, not just experience bullets", () => {
    const result = scoreActionVerbsAndReadability([
      { sourceType: "work_experience_bullet", optimizedText: "Built a data pipeline serving 10 teams daily" },
      { sourceType: "certification", optimizedText: "X" },
    ]);
    expect(result.machineReadabilityScore).toBe(0.5);
  });
});
