import { describe, it, expect } from "vitest";
import { runFailureText, seedingLine, sourceLine } from "./format";

describe("search run text (Phase 13a)", () => {
  it("describes each source state in plain words", () => {
    const s = { sourceId: "1", name: "Remotive", kind: "remotive" };
    expect(sourceLine({ ...s, state: "reused" })).toBe("Remotive — up to date, reused");
    expect(sourceLine({ ...s, state: "queued" })).toBe("Remotive — waiting");
    expect(sourceLine({ ...s, state: "running" })).toBe("Remotive — fetching…");
    expect(sourceLine({ ...s, state: "done", newCount: 3 })).toBe("Remotive — 3 new jobs");
    expect(sourceLine({ ...s, state: "done", newCount: 1 })).toBe("Remotive — 1 new job");
    expect(sourceLine({ ...s, state: "failed", reason: "rate_limited" })).toBe("Remotive — failed: the site asked us to slow down; it will be retried later");
    expect(sourceLine({ ...s, state: "failed", reason: "something_new" })).toBe("Remotive — failed (something_new)");
    expect(sourceLine({ ...s, state: "late" })).toBe("Remotive — still running; results will update automatically");
  });
  it("summarises seeding", () => {
    expect(seedingLine({ probe: { state: "ran", names: 4, boardsQueued: 40 }, webSearch: { state: "ran", boardsQueued: 2, unsupported: 5 } }))
      .toBe("Checked 4 employer names (40 possible job boards). Web search found 2 job boards (5 other career sites are not supported yet).");
    expect(seedingLine({ webSearch: { state: "skipped_recent", boardsQueued: 0, unsupported: 0 } })).toBe("Web search: skipped (searched recently for this goal).");
    expect(seedingLine({ webSearch: { state: "skipped_budget", boardsQueued: 0, unsupported: 0 } })).toBe("Web search: skipped (monthly AI budget reached).");
    expect(seedingLine({})).toBe("");
  });
  it("explains run failures", () => {
    expect(runFailureText("stalled")).toMatch(/job-ingestion worker/);
    expect(runFailureText("matching_failed")).toMatch(/ranking/);
    // Nothing refreshes the list after the run has ended, so the text must not promise results "will appear".
    expect(runFailureText("matching_timeout")).toMatch(/then use Find matching jobs again/);
    expect(runFailureText("matching_timeout")).not.toMatch(/will appear/);
    expect(runFailureText(null)).toMatch(/went wrong/);
  });
});
