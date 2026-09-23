import { describe, it, expect } from "vitest";
import { scoreSemantic } from "./scoreSemantic";

describe("scoreSemantic", () => {
  it("passes a known similarity through unchanged", () => {
    expect(scoreSemantic(0.73)).toBe(0.73);
  });
  it("is neutral, never zero, when similarity is unknown", () => {
    expect(scoreSemantic(null)).toBe(0.5);
  });
  it("clamps a negative cosine similarity to 0", () => {
    expect(scoreSemantic(-0.2)).toBe(0);
  });
  it("clamps a similarity above 1 to 1", () => {
    expect(scoreSemantic(1.2)).toBe(1);
  });
});
