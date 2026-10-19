import { describe, it, expect } from "vitest";
import { normalizeTermKey } from "./normalizeTermKey";

describe("normalizeTermKey", () => {
  it("trims, lowercases and collapses whitespace", () => {
    expect(normalizeTermKey("  Apache\t  Kafka ")).toBe("apache kafka");
  });
  it("keeps punctuation that distinguishes skills", () => {
    expect(normalizeTermKey("C++")).toBe("c++");
    expect(normalizeTermKey("C#")).toBe("c#");
    expect(normalizeTermKey("CI/CD")).toBe("ci/cd");
    expect(normalizeTermKey("Node.js")).toBe("node.js");
  });
});
