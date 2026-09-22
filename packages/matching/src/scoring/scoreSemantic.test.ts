import { describe, it, expect } from "vitest";
import { scoreSemantic } from "./scoreSemantic";

describe("scoreSemantic", () => {
  it("passes a known similarity through unchanged", () => {
    expect(scoreSemantic(0.73)).toBe(0.73);
  });
  it("is neutral, never zero, when similarity is unknown", () => {
    expect(scoreSemantic(null)).toBe(0.5);
  });
});
