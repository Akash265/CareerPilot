import { describe, it, expect } from "vitest";
import { buildEvidenceIndex } from "./buildEvidenceIndex";

describe("buildEvidenceIndex", () => {
  it("prefixes ids by kind and renders requirement level and profile context into the text", () => {
    const evidence = buildEvidenceIndex(
      [{ id: "f1", factText: "Acme builds rockets.", sourceUrl: "https://acme.example" }],
      [{ id: "q1", termText: "SQL", requirementLevel: "required" }],
      [
        { sourceFactId: "b1", sourceType: "work_experience_bullet", text: "Built a pipeline", context: "Globex — Engineer" },
        { sourceFactId: "s1", sourceType: "skill", text: "Python", context: null },
      ]
    );
    expect(evidence).toEqual([
      { id: "r:f1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" },
      { id: "q:q1", kind: "requirement", text: "[required] SQL", sourceUrl: null },
      { id: "p:b1", kind: "profile", text: "Globex — Engineer: Built a pipeline", sourceUrl: null },
      { id: "p:s1", kind: "profile", text: "Python", sourceUrl: null },
    ]);
  });
});
