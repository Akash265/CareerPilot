import { describe, it, expect } from "vitest";
import { scoreExperience } from "./scoreExperience";

describe("scoreExperience", () => {
  it("gives full credit when the job states no minimum", () => {
    expect(scoreExperience(null, 3, 1)).toBe(1);
  });
  it("gives full credit when the candidate's years are unknown", () => {
    expect(scoreExperience(5, null, 1)).toBe(1);
  });
  it("gives full credit when the candidate meets or exceeds the minimum", () => {
    expect(scoreExperience(5, 5, 1)).toBe(1);
    expect(scoreExperience(5, 8, 1)).toBe(1);
  });
  it("degrades linearly within the grace window", () => {
    // gap 1 of grace 2 -> 1 - 1/2 = 0.5
    expect(scoreExperience(6, 5, 2)).toBeCloseTo(0.5);
  });
  it("never goes below zero beyond the grace window", () => {
    expect(scoreExperience(20, 5, 1)).toBe(0);
  });
});
