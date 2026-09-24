import { describe, it, expect } from "vitest";
import { applyPitchGuard } from "./applyPitchGuard";
import type { PitchEvidenceItem } from "./buildEvidenceIndex";
import type { PitchDraft } from "./pitchSchema";

const EVIDENCE: PitchEvidenceItem[] = [
  { id: "r:f1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" },
  { id: "q:q1", kind: "requirement", text: "[required] SQL", sourceUrl: null },
  { id: "p:b1", kind: "profile", text: "Built a SQL pipeline", sourceUrl: null },
  { id: "p:b2", kind: "profile", text: "Led a team of 4", sourceUrl: null },
];
const draft = (company: string[], role: string[], candidate: string[], requiresReview = false): PitchDraft => ({
  bullets: [
    { kind: "company", text: "C", evidenceIds: company },
    { kind: "role", text: "R", evidenceIds: role },
    { kind: "candidate", text: "P", evidenceIds: candidate },
  ],
  requiresReview,
});

describe("applyPitchGuard", () => {
  it("marks every bullet supported when each cites existing evidence of its required kind", () => {
    const result = applyPitchGuard(EVIDENCE, draft(["r:f1"], ["q:q1"], ["p:b1", "p:b2"]));
    expect(result.requiresReview).toBe(false);
    expect(result.bullets.map((b) => [b.kind, b.supported, b.unsupportedReason])).toEqual([
      ["company", true, null], ["role", true, null], ["candidate", true, null],
    ]);
  });

  it("snapshots evidence text and URL from the index, in citation order", () => {
    const result = applyPitchGuard(EVIDENCE, draft(["r:f1"], ["q:q1"], ["p:b2", "p:b1"]));
    expect(result.bullets[0].evidence).toEqual([{ id: "r:f1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" }]);
    expect(result.bullets[2].evidence.map((e) => e.id)).toEqual(["p:b2", "p:b1"]);
  });

  it("flags a bullet citing an id that does not exist, and keeps the valid citations", () => {
    const result = applyPitchGuard(EVIDENCE, draft(["r:f1", "r:ghost"], ["q:q1"], ["p:b1"]));
    expect(result.bullets[0].supported).toBe(false);
    expect(result.bullets[0].unsupportedReason).toContain('"r:ghost" does not exist');
    expect(result.bullets[0].evidence.map((e) => e.id)).toEqual(["r:f1"]);
    expect(result.requiresReview).toBe(true);
  });

  it("flags a bullet that cites the same id twice", () => {
    const result = applyPitchGuard(EVIDENCE, draft(["r:f1"], ["q:q1", "q:q1"], ["p:b1"]));
    expect(result.bullets[1].supported).toBe(false);
    expect(result.bullets[1].unsupportedReason).toContain('"q:q1" is cited more than once');
    expect(result.bullets[1].evidence).toHaveLength(1);
  });

  it("flags a bullet that cites no evidence of its required kind", () => {
    const result = applyPitchGuard(EVIDENCE, draft(["p:b1"], ["q:q1"], []));
    expect(result.bullets[0]).toMatchObject({ supported: false });
    expect(result.bullets[0].unsupportedReason).toContain("cites no company research");
    expect(result.bullets[2]).toMatchObject({ supported: false });
    expect(result.bullets[2].unsupportedReason).toContain("cites no profile evidence");
  });

  it("keeps all three bullets even when every one is unsupported", () => {
    const result = applyPitchGuard(EVIDENCE, draft([], [], []));
    expect(result.bullets).toHaveLength(3);
    expect(result.bullets.every((b) => b.supported === false)).toBe(true);
  });

  it("ORs in the model's own requiresReview (it can add caution, never remove it)", () => {
    expect(applyPitchGuard(EVIDENCE, draft(["r:f1"], ["q:q1"], ["p:b1"], true)).requiresReview).toBe(true);
  });

  it("truncates a very long model-supplied id in the reason", () => {
    const longId = "r:" + "x".repeat(500);
    const result = applyPitchGuard(EVIDENCE, draft(["r:f1", longId], ["q:q1"], ["p:b1"]));
    expect(result.bullets[0].unsupportedReason!.length).toBeLessThan(200);
  });
});
