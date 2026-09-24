import { describe, it, expect } from "vitest";
import { deriveInternalFacts, type InternalJobSummary } from "./deriveInternalFacts";

const job = (title: string, locationRaw: string | null = "Berlin", workMode: InternalJobSummary["workMode"] = "unknown"): InternalJobSummary => ({
  title, locationRaw, workMode,
});

describe("deriveInternalFacts", () => {
  it("returns no facts for no jobs", () => {
    expect(deriveInternalFacts("Acme", [])).toEqual([]);
  });

  it("summarizes roles, locations and known work modes as internal facts without URLs", () => {
    const facts = deriveInternalFacts("Acme", [
      job("Data Engineer", "Berlin", "remote"),
      job("Analytics Engineer", "London", "hybrid"),
      job("Data Engineer", "Berlin", "unknown"),
    ]);
    expect(facts.map((f) => f.factText)).toEqual([
      "Acme has 3 roles in your job data: Analytics Engineer, Data Engineer.",
      "Listed locations: Berlin, London.",
      "Work arrangements in these postings: hybrid, remote.",
    ]);
    for (const f of facts) {
      expect(f).toMatchObject({ sourceKind: "internal", sourceUrl: null, sourceTitle: null, citedText: null });
    }
  });

  it("uses the singular for one role and omits empty location / unknown-only work-mode facts", () => {
    const facts = deriveInternalFacts("Acme", [job("Data Engineer", null, "unknown")]);
    expect(facts.map((f) => f.factText)).toEqual(["Acme has 1 role in your job data: Data Engineer."]);
  });

  it("lists at most five titles and says how many more", () => {
    const titles = ["A", "B", "C", "D", "E", "F", "G"];
    const [first] = deriveInternalFacts("Acme", titles.map((t) => job(t)));
    expect(first.factText).toBe("Acme has 7 roles in your job data: A, B, C, D, E and 2 more.");
  });

  it("is deterministic regardless of input order", () => {
    const a = deriveInternalFacts("Acme", [job("Z", "Paris"), job("A", "Berlin")]);
    const b = deriveInternalFacts("Acme", [job("A", "Berlin"), job("Z", "Paris")]);
    expect(a).toEqual(b);
  });

  it("drops a fact containing unsafe text instead of storing it", () => {
    const facts = deriveInternalFacts("Acme", [job("Bad \u0000 title", "Berlin")]);
    expect(facts.map((f) => f.factText)).toEqual(["Listed locations: Berlin."]);
  });
});
