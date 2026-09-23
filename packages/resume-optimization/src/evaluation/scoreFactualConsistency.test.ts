import { describe, it, expect } from "vitest";
import { scoreFactualConsistency } from "./scoreFactualConsistency";

describe("scoreFactualConsistency", () => {
  it("returns 1 when nothing was proposed (vacuously consistent)", () => {
    expect(scoreFactualConsistency(0, 0)).toBe(1);
  });

  it("returns 1 when every proposed claim was accepted", () => {
    expect(scoreFactualConsistency(3, 0)).toBe(1);
  });

  it("returns 0 when every proposed claim was rejected", () => {
    expect(scoreFactualConsistency(0, 3)).toBe(0);
  });

  it("returns the accepted fraction for a mix", () => {
    expect(scoreFactualConsistency(3, 1)).toBe(0.75);
  });
});
