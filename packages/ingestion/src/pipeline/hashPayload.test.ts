import { describe, it, expect } from "vitest";
import { hashPayload, stableStringify } from "./hashPayload";

describe("hashPayload", () => {
  it("is independent of object key order, at any depth", () => {
    expect(hashPayload({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(
      hashPayload({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 })
    );
  });

  it("changes when any value changes, and array order matters", () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
    expect(hashPayload([1, 2])).not.toBe(hashPayload([2, 1]));
  });

  it("ignores undefined properties and yields a 64-char hex digest", () => {
    expect(hashPayload({ a: 1, b: undefined })).toBe(hashPayload({ a: 1 }));
    expect(hashPayload({})).toMatch(/^[0-9a-f]{64}$/);
    expect(stableStringify(null)).toBe("null");
  });
});
