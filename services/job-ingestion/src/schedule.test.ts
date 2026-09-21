import { describe, it, expect } from "vitest";
import { planSchedules } from "./schedule";

describe("planSchedules", () => {
  it("adds a scheduler for each eligible source that has none", () => {
    expect(planSchedules({ eligibleSourceIds: ["a", "b"], existingSchedulerIds: ["schedule-a"], refresh: false })).toEqual({
      upsert: [{ schedulerId: "schedule-b", sourceId: "b" }],
      remove: [],
    });
  });

  it("re-upserts every eligible scheduler on refresh (boot), so an interval change applies", () => {
    expect(planSchedules({ eligibleSourceIds: ["a", "b"], existingSchedulerIds: ["schedule-a"], refresh: true }).upsert).toEqual([
      { schedulerId: "schedule-a", sourceId: "a" },
      { schedulerId: "schedule-b", sourceId: "b" },
    ]);
  });

  it("removes schedulers whose source is no longer eligible, but never ones it did not create", () => {
    expect(
      planSchedules({ eligibleSourceIds: ["a"], existingSchedulerIds: ["schedule-a", "schedule-gone", "someone-elses"], refresh: false })
    ).toEqual({ upsert: [], remove: ["schedule-gone"] });
  });

  it("does nothing when everything already matches", () => {
    expect(planSchedules({ eligibleSourceIds: ["a"], existingSchedulerIds: ["schedule-a"], refresh: false })).toEqual({ upsert: [], remove: [] });
    expect(planSchedules({ eligibleSourceIds: [], existingSchedulerIds: [], refresh: true })).toEqual({ upsert: [], remove: [] });
  });
});
