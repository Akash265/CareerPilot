import { describe, it, expect } from "vitest";
import { scoreFreshness } from "./scoreFreshness";

describe("scoreFreshness", () => {
  const now = new Date("2026-09-22T00:00:00Z");

  it("gives full credit under 24 hours old", () => {
    const postedAt = new Date("2026-09-21T06:00:00Z");
    expect(scoreFreshness(postedAt, postedAt, 168, now)).toBe(1);
  });
  it("decays with age past 24 hours, halving every half-life", () => {
    const postedAt = new Date("2026-09-15T00:00:00Z"); // 168h = one half-life before `now`
    expect(scoreFreshness(postedAt, postedAt, 168, now)).toBeCloseTo(0.5, 2);
  });
  it("falls back to firstSeenAt when postedAt is null", () => {
    const firstSeenAt = new Date("2026-09-21T06:00:00Z");
    expect(scoreFreshness(null, firstSeenAt, 168, now)).toBe(1);
  });
});
