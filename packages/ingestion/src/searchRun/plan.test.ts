import { describe, it, expect } from "vitest";
import { allSourcesSettled, applyRunUpdates, markLate, planSourceRefresh, slugGuesses, webSearchDue } from "./plan";

const NOW = new Date("2026-10-19T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

describe("slugGuesses", () => {
  it("joins and hyphenates the company key's words, dropping legal suffixes", () => {
    expect(slugGuesses("Acme Robotics GmbH")).toEqual(["acmerobotics", "acme-robotics"]);
  });
  it("gives one guess for a one-word name and none for names with no ASCII slug", () => {
    expect(slugGuesses("Linear")).toEqual(["linear"]);
    expect(slugGuesses("北京科技")).toEqual([]);
    expect(slugGuesses("  ")).toEqual([]);
  });
  it("strips diacritics and caps the length at 63", () => {
    expect(slugGuesses("Zürich Insurance")).toEqual(["zurichinsurance", "zurich-insurance"]);
    expect(slugGuesses("a".repeat(70))).toEqual([]);
  });
});

describe("planSourceRefresh", () => {
  const src = (id: string, kind: string, lastSuccessAt: Date | null) => ({ sourceId: id, name: id, kind, lastSuccessAt });
  it("reuses sources that succeeded within the window, queues the rest", () => {
    const plan = planSourceRefresh({
      sources: [src("fresh", "greenhouse", ago(30)), src("stale", "lever", ago(400)), src("never", "ashby", null)],
      now: NOW, freshMinutes: 360, goalConfirmedAt: ago(1000),
    });
    expect(plan.map((s) => [s.sourceId, s.state])).toEqual([["fresh", "reused"], ["stale", "queued"], ["never", "queued"]]);
  });
  it("re-queues a fresh search source when the goal was confirmed after its last success", () => {
    const plan = planSourceRefresh({ sources: [src("remotive", "remotive", ago(30)), src("gh", "greenhouse", ago(30))], now: NOW, freshMinutes: 360, goalConfirmedAt: ago(10) });
    expect(plan.map((s) => s.state)).toEqual(["queued", "reused"]);
  });
  it("a zero window always refreshes", () => {
    expect(planSourceRefresh({ sources: [src("a", "greenhouse", NOW)], now: NOW, freshMinutes: 0, goalConfirmedAt: null })[0].state).toBe("queued");
  });
});

describe("webSearchDue", () => {
  const base = { enabled: true, lastAt: ago(60), lastGoalId: "g1", goalId: "g1", now: NOW, intervalDays: 7 };
  it("is due when never run, for a new goal, or after the interval", () => {
    expect(webSearchDue({ ...base, lastAt: null, lastGoalId: null })).toBe("due");
    expect(webSearchDue({ ...base, lastGoalId: "g0" })).toBe("due");
    expect(webSearchDue({ ...base, lastAt: ago(8 * 24 * 60) })).toBe("due");
  });
  it("skips when recent for the same goal, or disabled", () => {
    expect(webSearchDue(base)).toBe("skipped_recent");
    expect(webSearchDue({ ...base, enabled: false, lastAt: null })).toBe("skipped_disabled");
  });
});

describe("run progress", () => {
  const queued = [
    { sourceId: "a", name: "A", kind: "greenhouse", state: "queued" as const },
    { sourceId: "b", name: "B", kind: "lever", state: "queued" as const },
    { sourceId: "c", name: "C", kind: "ashby", state: "reused" as const },
  ];
  it("applies the newest ingestion run per source", () => {
    const next = applyRunUpdates(queued, [
      { sourceId: "a", status: "succeeded", newCount: 4, errorClass: null },
      { sourceId: "b", status: "running", newCount: 0, errorClass: null },
      { sourceId: "c", status: "failed", newCount: 0, errorClass: "rate_limited" },
    ]);
    expect(next).toEqual([
      { sourceId: "a", name: "A", kind: "greenhouse", state: "done", newCount: 4 },
      { sourceId: "b", name: "B", kind: "lever", state: "running" },
      { sourceId: "c", name: "C", kind: "ashby", state: "reused" },
    ]);
    expect(allSourcesSettled(next)).toBe(false);
  });
  it("records a failure's error class and settles when nothing is queued or running", () => {
    const next = applyRunUpdates(queued, [
      { sourceId: "a", status: "failed", newCount: 0, errorClass: "rate_limited" },
      { sourceId: "b", status: "succeeded", newCount: 0, errorClass: null },
    ]);
    expect(next[0]).toMatchObject({ state: "failed", reason: "rate_limited" });
    expect(allSourcesSettled(next)).toBe(true);
  });
  it("marks unfinished sources late at the deadline", () => {
    expect(markLate(queued).map((s) => s.state)).toEqual(["late", "late", "reused"]);
  });
  it("a failed attempt that is retried shows running again, then done", () => {
    const failed = applyRunUpdates(queued, [{ sourceId: "a", status: "failed", newCount: 0, errorClass: "rate_limited" }]);
    const retried = applyRunUpdates(failed, [{ sourceId: "a", status: "running", newCount: 0, errorClass: null }]);
    expect(retried[0].state).toBe("running");
    expect(applyRunUpdates(retried, [{ sourceId: "a", status: "succeeded", newCount: 2, errorClass: null }])[0]).toMatchObject({ state: "done", newCount: 2 });
  });
});
