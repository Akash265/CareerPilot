import { describe, it, expect } from "vitest";
import { isExplanationStale, type StalenessInput } from "./explanationStaleness";

const now = new Date("2026-09-22T00:00:00Z");
const fresh: StalenessInput = {
  existing: { careerGoalId: "goal-1", explanationGeneratedAt: new Date("2026-09-20T00:00:00Z"), explanationDescriptionHash: "dh-1" },
  activeCareerGoalId: "goal-1",
  currentDescriptionHash: "dh-1",
  now,
  ttlDays: 7,
};

describe("isExplanationStale", () => {
  it("is stale when there is no existing explanation", () => {
    expect(isExplanationStale({ ...fresh, existing: undefined })).toBe(true);
  });
  it("is not stale when nothing has changed and the TTL has not elapsed", () => {
    expect(isExplanationStale(fresh)).toBe(false);
  });
  it("is stale when the job's description hash changed", () => {
    expect(isExplanationStale({ ...fresh, currentDescriptionHash: "dh-2" })).toBe(true);
  });
  it("is stale when the active career goal changed", () => {
    expect(isExplanationStale({ ...fresh, activeCareerGoalId: "goal-2" })).toBe(true);
  });
  it("is stale once the TTL has elapsed", () => {
    expect(isExplanationStale({ ...fresh, ttlDays: 1 })).toBe(true);
  });
});
