import { describe, it, expect } from "vitest";
import { scoreLocation } from "./scoreLocation";

describe("scoreLocation", () => {
  it("gives full credit whenever the goal has no work-mode preference", () => {
    expect(scoreLocation("onsite", "any", "Paris", null, [])).toBe(1);
  });
  it("gives full credit for an exact work-mode match", () => {
    expect(scoreLocation("hybrid", "hybrid", "Berlin", null, [])).toBe(1);
  });
  it("gives partial credit for an unknown job work mode", () => {
    expect(scoreLocation("unknown", "remote", null, null, [])).toBe(0.5);
  });
  it("gives more credit for a location overlap than none, on a work-mode mismatch", () => {
    const overlap = scoreLocation("hybrid", "onsite", "Berlin, Germany", "DE", ["Germany"]);
    const noOverlap = scoreLocation("hybrid", "onsite", "Austin, TX", "US", ["Germany"]);
    expect(overlap).toBeGreaterThan(noOverlap);
  });
  it("gives mild credit on a work-mode mismatch when the goal states no target locations", () => {
    expect(scoreLocation("hybrid", "onsite", "Austin, TX", "US", [])).toBe(0.6);
  });
});
