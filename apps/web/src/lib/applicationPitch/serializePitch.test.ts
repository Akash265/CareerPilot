import { describe, it, expect } from "vitest";
import { toPitchView, toResearchView } from "./serializePitch";

const pitchRow = {
  id: "p1", userId: "u1", jobId: "j1", version: 2, origin: "generated", parentPitchId: null,
  companyResearchId: "r1", researchStatusSnapshot: "ok", researchedAtSnapshot: new Date("2026-09-20T00:00:00Z"),
  bullets: [
    { kind: "company", text: "C", supported: true, unsupportedReason: null,
      evidence: [{ id: "r:1", kind: "research", text: "Acme builds rockets.", sourceUrl: "javascript:alert(1)" }] },
    { kind: "role", text: "R", supported: false, unsupportedReason: "cites no job requirement", evidence: [] },
    { kind: "candidate", text: "P", supported: true, unsupportedReason: null,
      evidence: [{ id: "p:1", kind: "profile", text: "Built X", sourceUrl: null }] },
  ],
  requiresReview: true, sourceProfileContentHash: "h", generationModel: "fast-model", createdAt: new Date("2026-09-21T00:00:00Z"),
};

describe("toPitchView", () => {
  it("serializes dates, carries bullets through, and nulls any non-http evidence URL", () => {
    const view = toPitchView(pitchRow as never);
    expect(view).toMatchObject({
      id: "p1", version: 2, origin: "generated", requiresReview: true, researchStatus: "ok",
      researchedAt: "2026-09-20T00:00:00.000Z", createdAt: "2026-09-21T00:00:00.000Z", generationModel: "fast-model",
    });
    expect(view.bullets[0].evidence[0].sourceUrl).toBeNull();
    expect(view.bullets[1]).toEqual({ kind: "role", text: "R", supported: false, unsupportedReason: "cites no job requirement", evidence: [] });
  });

  it("serializes a null researchedAtSnapshot as null", () => {
    expect(toPitchView({ ...pitchRow, researchedAtSnapshot: null } as never).researchedAt).toBeNull();
  });
});

describe("toResearchView", () => {
  it("keeps http(s) source URLs and nulls anything else", () => {
    const view = toResearchView({
      research: { id: "r1", companyName: "Acme", status: "ok", researchedAt: new Date("2026-09-20T00:00:00Z"), searchCount: 3 },
      facts: [
        { id: "f1", sourceKind: "web", factText: "A.", sourceUrl: "https://acme.example", sourceTitle: "Acme" },
        { id: "f2", sourceKind: "web", factText: "B.", sourceUrl: "data:text/html,x", sourceTitle: null },
        { id: "f3", sourceKind: "internal", factText: "C.", sourceUrl: null, sourceTitle: null },
      ],
    } as never);
    expect(view).toEqual({
      id: "r1", companyName: "Acme", status: "ok", researchedAt: "2026-09-20T00:00:00.000Z", searchCount: 3,
      facts: [
        { id: "f1", sourceKind: "web", factText: "A.", sourceUrl: "https://acme.example", sourceTitle: "Acme" },
        { id: "f2", sourceKind: "web", factText: "B.", sourceUrl: null, sourceTitle: null },
        { id: "f3", sourceKind: "internal", factText: "C.", sourceUrl: null, sourceTitle: null },
      ],
    });
  });
});
