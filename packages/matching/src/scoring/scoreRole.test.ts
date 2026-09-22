import { describe, it, expect } from "vitest";
import { scoreRole } from "./scoreRole";

describe("scoreRole", () => {
  it("gives full credit when no target roles are stated", () => {
    expect(scoreRole([], "Data Engineer")).toBe(1);
  });
  it("gives full credit for a title containing every word of the target role", () => {
    expect(scoreRole(["Data Engineer"], "Senior Data Engineer")).toBe(1);
  });
  it("gives partial credit for a partial word overlap", () => {
    const score = scoreRole(["Data Engineer"], "Data Analyst");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
  it("gives a low score for no word overlap", () => {
    expect(scoreRole(["Data Engineer"], "Marketing Manager")).toBe(0);
  });
});
