import { describe, it, expect } from "vitest";
import { scoreIndustry } from "./scoreIndustry";

describe("scoreIndustry", () => {
  it("gives full credit when no preferred industries are stated", () => {
    expect(scoreIndustry("Acme Corp", [])).toBe(1);
  });
  it("gives full credit for a company-name match", () => {
    expect(scoreIndustry("Acme Fintech Inc", ["fintech"])).toBe(1);
  });
  it("gives partial credit for no match, never zero", () => {
    expect(scoreIndustry("Acme Logistics", ["fintech"])).toBe(0.5);
  });
});
