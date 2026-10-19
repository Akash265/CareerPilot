import { describe, it, expect } from "vitest";
import { ALIAS_GROUPS, aliasGroupOf } from "./aliases";
import { normalizeTermKey } from "./normalizeTermKey";

describe("alias table", () => {
  it("stores only normalized keys", () => {
    for (const group of ALIAS_GROUPS) for (const key of group) expect(key).toBe(normalizeTermKey(key));
  });
  it("never lists a key in two groups, and every group has at least two names", () => {
    const seen = new Set<string>();
    for (const group of ALIAS_GROUPS) {
      expect(group.length).toBeGreaterThanOrEqual(2);
      for (const key of group) {
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });
  it("finds a term's group, or nothing", () => {
    expect(aliasGroupOf("postgresql")).toContain("postgres");
    expect(aliasGroupOf("k8s")).toContain("kubernetes");
    expect(aliasGroupOf("cobol")).toBeUndefined();
  });
});
