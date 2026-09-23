import { describe, it, expect } from "vitest";
import { toMatchView } from "./serializeMatch";

// toMatchView is pure (row -> view), so these are plain unit tests -- no DB needed. The row shape
// mirrors schema.jobMatches.$inferSelect; only the fields toMatchView reads are filled in.
function baseRow(overrides: Partial<Parameters<typeof toMatchView>[0]> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    userId: "00000000-0000-0000-0000-000000000001",
    jobId: "22222222-2222-2222-2222-222222222222",
    careerGoalId: "33333333-3333-3333-3333-333333333333",
    eligible: true,
    ineligibleReason: null,
    skillsScore: "0.8",
    experienceScore: "0.5",
    locationScore: "1",
    sponsorshipScore: "1",
    roleScore: "0.6",
    salaryScore: null,
    industryScore: null,
    freshnessScore: "0.9",
    semanticScore: "0.7",
    overallScore: "72.5",
    explanation: { strongMatches: ["SQL"], partialMatches: [], gaps: ["Kubernetes"], summary: "Solid fit." },
    explanationModel: "claude-haiku-4-5-20251001",
    explanationDescriptionHash: "hash-1",
    explanationGeneratedAt: new Date("2026-01-01T00:00:00Z"),
    userAction: "none" as const,
    userActionAt: null,
    computedAt: new Date("2026-01-02T00:00:00Z"),
    createdAt: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

describe("toMatchView", () => {
  it("carries factors, overallScore, and explanation through for an eligible row", () => {
    const view = toMatchView(baseRow());
    expect(view.eligible).toBe(true);
    expect(view.overallScore).toBe(72.5);
    expect(view.factors).toEqual({
      skills: 80,
      experience: 50,
      location: 100,
      sponsorship: 100,
      role: 60,
      salary: null,
      industry: null,
      freshness: 90,
      semantic: 70,
    });
    expect(view.explanation).toEqual({
      strongMatches: ["SQL"],
      partialMatches: [],
      gaps: ["Kubernetes"],
      summary: "Solid fit.",
    });
  });

  it("nulls out explanation, factors, and overallScore for an ineligible row that still carries a stale explanation forward", () => {
    // Realistic shape written by upsertMatch.ts: a job eligible on a prior run accumulates a real
    // explanation; when a later run reclassifies it ineligible, factors/overallScore are freshly
    // nulled, but `explanation` is carried forward unchanged (that's the bug this fix closes --
    // toMatchView must gate `explanation` on `eligible` itself, not rely on it already being null).
    const row = baseRow({
      eligible: false,
      ineligibleReason: "missing_sponsorship",
      overallScore: null,
      skillsScore: null,
      experienceScore: null,
      locationScore: null,
      sponsorshipScore: null,
      roleScore: null,
      salaryScore: null,
      industryScore: null,
      freshnessScore: null,
      semanticScore: null,
      // explanation deliberately left non-null (baseRow's default) to simulate the carried-forward row.
    });
    const view = toMatchView(row);
    expect(view.eligible).toBe(false);
    expect(view.explanation).toBeNull();
    expect(view.factors).toBeNull();
    expect(view.overallScore).toBeNull();
  });
});
