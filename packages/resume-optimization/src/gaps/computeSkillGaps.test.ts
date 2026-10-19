import { describe, it, expect } from "vitest";
import { computeSkillGaps, type SkillVerificationForGaps } from "./computeSkillGaps";
import type { RequirementForGapDetection } from "./computeGapTerms";
import type { EvidenceCatalogEntry } from "../optimization/buildResumeSnapshot";

const req = (id: string, termText: string, over: Partial<RequirementForGapDetection> = {}): RequirementForGapDetection =>
  ({ id, termText, requirementLevel: "required", termType: "skill", ...over });
const entry = (text: string): EvidenceCatalogEntry => ({ sourceFactId: `f-${text}`, sourceType: "skill", text, context: null });
const v = (termKey: string, status: SkillVerificationForGaps["status"], aliasSkillName: string | null = null): SkillVerificationForGaps =>
  ({ termKey, status, aliasSkillName });

describe("computeSkillGaps", () => {
  it("ignores preferred, 'other'-typed and phrase-shaped requirements (D104)", () => {
    const gaps = computeSkillGaps([
      req("1", "Rust", { requirementLevel: "preferred" }),
      req("2", "Teamwork", { termType: "other" }),
      req("3", "Production data pipeline building experience"),
    ], [], [], []);
    expect(gaps).toEqual([]);
  });

  it("marks a term found in profile text as covered", () => {
    expect(computeSkillGaps([req("1", "Python")], [entry("Python")], [], [])).toEqual([
      { termKey: "python", termDisplay: "Python", requirementIds: ["1"], state: "covered", suggestion: null },
    ]);
  });

  it("merges the same term written differently into one gap with every requirement id", () => {
    const gaps = computeSkillGaps([req("b", "Apache  Kafka"), req("a", " apache kafka")], [], [], []);
    expect(gaps).toEqual([{ termKey: "apache kafka", termDisplay: "Apache Kafka", requirementIds: ["a", "b"], state: "unanswered", suggestion: null }]);
  });

  it("covers a 'have' answer, including punctuated terms", () => {
    const gaps = computeSkillGaps([req("1", "C++"), req("2", "Kubernetes")], [], [v("c++", "have"), v("kubernetes", "have")], []);
    expect(gaps.map((g) => [g.termKey, g.state])).toEqual([["c++", "covered"], ["kubernetes", "covered"]]);
  });

  it("marks 'dont_have' declined, but profile text still wins", () => {
    const gaps = computeSkillGaps([req("1", "dbt"), req("2", "SQL")], [entry("SQL")], [v("dbt", "dont_have"), v("sql", "dont_have")], []);
    expect(gaps.map((g) => [g.termKey, g.state])).toEqual([["dbt", "declined"], ["sql", "covered"]]);
  });

  it("covers a live alias and reopens a stale one with the old skill as the suggestion", () => {
    const live = computeSkillGaps([req("1", "PostgreSQL")], [], [v("postgresql", "alias", "Postgres")], ["Postgres"]);
    expect(live[0]).toMatchObject({ state: "covered", suggestion: null });
    const stale = computeSkillGaps([req("1", "PostgreSQL")], [], [v("postgresql", "alias", "Postgres")], ["Python"]);
    expect(stale[0]).toMatchObject({ state: "unanswered", suggestion: "Postgres" });
  });

  it("suggests a profile skill from the alias table without covering the term", () => {
    const gaps = computeSkillGaps([req("1", "PostgreSQL"), req("2", "K8s")], [], [], ["Postgres", "Kubernetes"]);
    expect(gaps).toEqual([
      { termKey: "k8s", termDisplay: "K8s", requirementIds: ["2"], state: "unanswered", suggestion: "Kubernetes" },
      { termKey: "postgresql", termDisplay: "PostgreSQL", requirementIds: ["1"], state: "unanswered", suggestion: "Postgres" },
    ]);
  });

  it("does not treat 'Go' inside 'Google' as covered (boundary-aware)", () => {
    expect(computeSkillGaps([req("1", "Go")], [entry("Google Analytics")], [], [])[0].state).toBe("unanswered");
  });
});
