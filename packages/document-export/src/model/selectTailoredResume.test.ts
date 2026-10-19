// packages/document-export/src/model/selectTailoredResume.test.ts
import { describe, it, expect } from "vitest";
import type { AppliedBullet, RequirementTerm } from "@ai-career/resume-optimization";
import { selectTailoredResume } from "./selectTailoredResume";
import type { ResumeProfile } from "./resumeProfile";
import type { DocumentModel } from "./types";

const contact = { fullName: "Jane Doe", email: "jane@example.com", phoneNumber: null, linkedinUrl: null };

function profileWith(over: Partial<ResumeProfile> = {}): ResumeProfile {
  return {
    contact,
    experiences: [
      { id: "e1", company: "Globex", title: "Engineer", location: null, startDate: "2021", endDate: null,
        bullets: [{ id: "b1", text: "Built Kafka pipelines" }, { id: "b2", text: "Ran standups" }, { id: "b3", text: "Wrote Python ETL" }] },
      { id: "e2", company: "Initech", title: "Analyst", location: null, startDate: "2018", endDate: "2021",
        bullets: [{ id: "b4", text: "Made reports" }, { id: "b5", text: "Used SQL daily" }] },
      { id: "e3", company: "Umbrella", title: "Intern", location: null, startDate: "2017", endDate: "2018",
        bullets: [{ id: "b6", text: "Filed tickets" }, { id: "b7", text: "Learned Python" }] },
    ],
    achievements: [{ id: "a1", description: "Won a hackathon" }],
    projects: [{ id: "p1", name: "Tool", description: "A Kafka CLI", url: null }, { id: "p2", name: "Blog", description: "Cooking blog", url: null }],
    certifications: [{ id: "c1", name: "AWS SA", issuer: "AWS", issueDate: null, expiryDate: null }],
    education: [{ id: "ed1", institution: "TU", degree: "BSc", fieldOfStudy: null, startDate: null, endDate: null, gpa: null }],
    skills: [{ id: "s1", name: "Excel" }, { id: "s2", name: "Python" }, { id: "s3", name: "kafka" }],
    verifiedSkills: [{ id: "v1", term: "SQL" }, { id: "v2", term: "Python" }],
    ...over,
  };
}

const reqs: RequirementTerm[] = [
  { termText: "Kafka", requirementLevel: "required" },
  { termText: "Python", requirementLevel: "preferred" },
  { termText: "SQL", requirementLevel: "required" },
  { termText: "  ", requirementLevel: "required" },
];

const applied = (id: string, text: string, sourceType: AppliedBullet["sourceType"] = "work_experience_bullet"): AppliedBullet =>
  ({ sourceFactId: id, sourceType, originalText: "x", optimizedText: text, changeType: "reworded", justification: "j" });

const bulletsOf = (model: DocumentModel, entryTitle: string): string[] => {
  const i = model.blocks.findIndex((b) => b.type === "entry" && b.title === entryTitle);
  const next = model.blocks[i + 1];
  return next?.type === "bullets" ? next.items : [];
};
const paragraphAfter = (model: DocumentModel, heading: string): string | undefined => {
  const i = model.blocks.findIndex((b) => b.type === "heading" && b.text === heading);
  const next = model.blocks[i + 1];
  return next?.type === "paragraph" ? next.text : undefined;
};
const headings = (model: DocumentModel) => model.blocks.filter((b) => b.type === "heading").map((b) => (b as { text: string }).text);

describe("selectTailoredResume", () => {
  it("keeps everything that fits, orders selected first (optimizer text), then by requirement score", () => {
    const sel = selectTailoredResume(profileWith(), [applied("b2", "Led daily standups for 6 engineers")], reqs, { paperSize: "a4" });
    expect(bulletsOf(sel.model, "Engineer")).toEqual(["Led daily standups for 6 engineers", "Built Kafka pipelines", "Wrote Python ETL"]);
    expect(bulletsOf(sel.model, "Analyst")).toEqual(["Used SQL daily", "Made reports"]);
    expect(sel.includedCount).toBe(10);
    expect(sel.totalCount).toBe(10);
    expect(sel.omitted).toEqual([]);
    expect(headings(sel.model)).toEqual(["Experience", "Projects", "Achievements", "Education", "Certifications", "Skills"]);
    expect(sel.model.title).toBe("Jane Doe");
  });

  it("falls back to the original text when optimizedText is blank", () => {
    const sel = selectTailoredResume(profileWith(), [applied("b2", "   ")], reqs, { paperSize: "a4" });
    expect(bulletsOf(sel.model, "Engineer")[0]).toBe("Ran standups");
  });

  it("lists matched skills first in requirement order (required first), dedupes verified terms, keeps names verbatim", () => {
    const sel = selectTailoredResume(profileWith(), [], reqs, { paperSize: "a4" });
    expect(paragraphAfter(sel.model, "Skills")).toBe("kafka, SQL, Python, Excel");
  });

  it("throws on an applied bullet citing an unknown fact", () => {
    expect(() => selectTailoredResume(profileWith(), [applied("nope", "x")], reqs, { paperSize: "a4" })).toThrow(/unknown source fact nope/);
  });

  it("removes zero-score projects/achievements first, then lowest-ranked bullets, respecting floors", () => {
    // extraRemovals simulates the compile loop asking for more room.
    const sel = selectTailoredResume(profileWith(), [], reqs, { paperSize: "a4", extraRemovals: 3 });
    // Zero-score extras go first: "Cooking blog" (p2) and the hackathon (a1); then the worst bullet that is not floor-protected.
    expect(sel.omitted).toEqual([
      { sourceType: "work_experience_bullet", sourceFactId: "b6", reason: "no_requirement_match" },
      { sourceType: "project", sourceFactId: "p2", reason: "no_requirement_match" },
      { sourceType: "achievement", sourceFactId: "a1", reason: "no_requirement_match" },
    ]);
    expect(headings(sel.model)).not.toContain("Achievements");
    expect(bulletsOf(sel.model, "Intern")).toEqual(["Learned Python"]); // floor: 1 bullet for the third role
    expect(sel.includedCount).toBe(7);
  });

  it("never goes below the floors and reports exhausted", () => {
    const sel = selectTailoredResume(profileWith(), [], reqs, { paperSize: "a4", extraRemovals: 100 });
    expect(bulletsOf(sel.model, "Engineer")).toHaveLength(2);
    expect(bulletsOf(sel.model, "Analyst")).toHaveLength(2);
    expect(bulletsOf(sel.model, "Intern")).toHaveLength(1);
    expect(sel.exhausted).toBe(true);
    expect(headings(sel.model)).toEqual(expect.arrayContaining(["Education", "Certifications", "Skills"]));
    const reasons = Object.fromEntries(sel.omitted.map((o) => [o.sourceFactId, o.reason]));
    expect(reasons.p1).toBe("page_limit"); // scored (Kafka) but cut for space
    expect(reasons.b2).toBe("no_requirement_match");
    expect(reasons.b3).toBeUndefined(); // floor-protected (second-best bullet of the first role)
  });

  it("fits a long profile to the estimate budget, marking cut scored items page_limit", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, text: `Did Kafka thing number ${i} `.repeat(4) }));
    const sel = selectTailoredResume(profileWith({ experiences: [{ ...profileWith().experiences[0], bullets: many }] }), [], reqs, { paperSize: "a4" });
    expect(sel.omitted.length).toBeGreaterThan(0);
    expect(sel.omitted.every((o) => o.reason === "page_limit" || o.sourceType !== "work_experience_bullet")).toBe(true);
    expect(sel.exhausted).toBe(false);
  });

  it("handles a one-role, one-bullet profile with no projects or achievements", () => {
    const p = profileWith({ experiences: [{ ...profileWith().experiences[0], bullets: [{ id: "b1", text: "Built Kafka pipelines" }] }], projects: [], achievements: [] });
    const sel = selectTailoredResume(p, [], [], { paperSize: "letter", extraRemovals: 3 });
    expect(bulletsOf(sel.model, "Engineer")).toEqual(["Built Kafka pipelines"]);
    expect(sel.exhausted).toBe(true);
    expect(sel.totalCount).toBe(1);
  });
});
