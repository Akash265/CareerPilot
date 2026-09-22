import { describe, it, expect } from "vitest";
import { toVectorLiteral } from "./vectorLiteral";

describe("toVectorLiteral", () => {
  it("formats a numeric array as a pgvector literal", () => {
    expect(toVectorLiteral([0.1, -0.25, 1])).toBe("[0.1,-0.25,1]");
  });
  it("formats an empty array", () => {
    expect(toVectorLiteral([])).toBe("[]");
  });
});
