import { describe, it, expect } from "vitest";
import type { AppliedBullet } from "@ai-career/resume-optimization";
import { buildResumeModel } from "./buildResumeModel";
import { contactLine, dateRange, type ResumeProfile } from "./resumeProfile";

const profile: ResumeProfile = {
  contact: { fullName: "Jane Doe", email: "jane@example.com", phoneNumber: "+49 1", linkedinUrl: "https://linkedin.com/in/jane" },
  experiences: [
    { id: "e1", company: "Globex", title: "Engineer", location: "Berlin", startDate: "2021", endDate: null,
      bullets: [{ id: "b1", text: "Built A" }, { id: "b2", text: "Built B" }, { id: "b3", text: "Built C" }] },
    { id: "e2", company: "Initech", title: "Intern", location: null, startDate: null, endDate: null,
      bullets: [{ id: "b4", text: "Helped D" }] },
  ],
  achievements: [{ id: "a1", description: "Award X" }, { id: "a2", description: "Award Y" }],
  projects: [
    { id: "p1", name: "Proj One", description: "First project", url: null },
    { id: "p2", name: "Proj Two", description: "Second project", url: "https://two.example" },
  ],
  certifications: [{ id: "c1", name: "AWS SA", issuer: "Amazon", issueDate: "2022", expiryDate: "2025" }],
  education: [{ id: "d1", institution: "TU Berlin", degree: "BSc", fieldOfStudy: "CS", startDate: "2016", endDate: "2020", gpa: null }],
  skills: [{ id: "s1", name: "Python" }, { id: "s2", name: "SQL" }, { id: "s3", name: "Go" }],
  verifiedSkills: [],
};

const applied = (sourceFactId: string, sourceType: AppliedBullet["sourceType"], optimizedText: string): AppliedBullet => ({
  sourceFactId, sourceType, optimizedText, originalText: "orig", changeType: "reworded", justification: "j",
});

const blocksAfter = (model: ReturnType<typeof buildResumeModel>, heading: string) => {
  const i = model.blocks.findIndex((b) => b.type === "heading" && b.text === heading);
  return i === -1 ? null : model.blocks.slice(i + 1);
};

describe("contactLine / dateRange", () => {
  it("joins only non-empty contact parts, never an address", () => {
    expect(contactLine(profile.contact)).toBe("jane@example.com · +49 1 · https://linkedin.com/in/jane");
    expect(contactLine({ fullName: "J", email: "j@x.y", phoneNumber: null, linkedinUrl: "" })).toBe("j@x.y");
  });

  it("formats date ranges", () => {
    expect(dateRange("2021", null)).toBe("2021 – present");
    expect(dateRange("2016", "2020")).toBe("2016 – 2020");
    expect(dateRange(null, "2020")).toBe("2020");
    expect(dateRange(null, null)).toBeNull();
  });
});

describe("buildResumeModel", () => {
  it("uses the full name as title and the contact line", () => {
    const model = buildResumeModel(profile, []);
    expect(model.title).toBe("Jane Doe");
    expect(model.contactLine).toBe("jane@example.com · +49 1 · https://linkedin.com/in/jane");
  });

  it("puts a role's optimized bullets first in optimizer order, then its untouched bullets in profile order", () => {
    const model = buildResumeModel(profile, [
      applied("b3", "work_experience_bullet", "Built C faster"),
      applied("b1", "work_experience_bullet", "Built A with SQL"),
    ]);
    const exp = blocksAfter(model, "Experience")!;
    expect(exp[0]).toEqual({ type: "entry", title: "Engineer", subtitle: "Globex · Berlin", meta: "2021 – present" });
    expect(exp[1]).toEqual({ type: "bullets", items: ["Built C faster", "Built A with SQL", "Built B"] });
    expect(exp[2]).toEqual({ type: "entry", title: "Intern", subtitle: "Initech", meta: null });
    expect(exp[3]).toEqual({ type: "bullets", items: ["Helped D"] });
  });

  it("with no optimization keeps every bullet in original wording and order", () => {
    const exp = blocksAfter(buildResumeModel(profile, []), "Experience")!;
    expect(exp[1]).toEqual({ type: "bullets", items: ["Built A", "Built B", "Built C"] });
  });

  it("orders projects selected-first with optimized descriptions, then the rest verbatim", () => {
    const proj = blocksAfter(buildResumeModel(profile, [applied("p2", "project", "Second project, in Go")]), "Projects")!;
    expect(proj.slice(0, 4)).toEqual([
      { type: "entry", title: "Proj Two", subtitle: "https://two.example", meta: null },
      { type: "paragraph", text: "Second project, in Go" },
      { type: "entry", title: "Proj One", subtitle: null, meta: null },
      { type: "paragraph", text: "First project" },
    ]);
  });

  it("orders achievements selected-first with optimized text", () => {
    const ach = blocksAfter(buildResumeModel(profile, [applied("a2", "achievement", "Award Y (top 1%)")]), "Achievements")!;
    expect(ach[0]).toEqual({ type: "bullets", items: ["Award Y (top 1%)", "Award X"] });
  });

  it("keeps education and certifications verbatim even when the optimizer selected them", () => {
    const model = buildResumeModel(profile, [applied("d1", "education", "REWORDED"), applied("c1", "certification", "REWORDED")]);
    expect(blocksAfter(model, "Education")![0]).toEqual({ type: "entry", title: "BSc in CS", subtitle: "TU Berlin", meta: "2016 – 2020" });
    expect(blocksAfter(model, "Certifications")![0]).toEqual({ type: "entry", title: "AWS SA", subtitle: "Amazon", meta: "2022 – 2025" });
    expect(JSON.stringify(model)).not.toContain("REWORDED");
  });

  it("orders skills selected-first using profile names, never optimizedText", () => {
    const model = buildResumeModel(profile, [applied("s3", "skill", "Golang (expert)"), applied("s2", "skill", "SQL!!")]);
    expect(blocksAfter(model, "Skills")![0]).toEqual({ type: "paragraph", text: "Go, SQL, Python" });
  });

  it("adds a GPA to the education subtitle when present", () => {
    const model = buildResumeModel({ ...profile, education: [{ ...profile.education[0], gpa: "3.8" }] }, []);
    expect(blocksAfter(model, "Education")![0]).toMatchObject({ subtitle: "TU Berlin · GPA 3.8" });
  });

  it("omits empty sections and orders sections Experience, Projects, Achievements, Education, Certifications, Skills", () => {
    const model = buildResumeModel({ ...profile, achievements: [], certifications: [] }, []);
    const headings = model.blocks.filter((b) => b.type === "heading").map((b) => (b as { text: string }).text);
    expect(headings).toEqual(["Experience", "Projects", "Education", "Skills"]);
  });

  it("throws when an applied bullet cites a fact that is not in the profile (a bug, not a user error)", () => {
    expect(() => buildResumeModel(profile, [applied("ghost", "work_experience_bullet", "x")])).toThrow(/ghost/);
  });

  // Fix round 1

  it("an applied bullet on one role leaves the other role's bullets untouched", () => {
    const model = buildResumeModel(profile, [applied("b4", "work_experience_bullet", "Helped D loudly")]);
    const exp = blocksAfter(model, "Experience")!;
    expect(exp[1]).toEqual({ type: "bullets", items: ["Built A", "Built B", "Built C"] });
    expect(exp[3]).toEqual({ type: "bullets", items: ["Helped D loudly"] });
  });

  it("renders a duplicated applied entry once, using the first occurrence's text", () => {
    const model = buildResumeModel(profile, [
      applied("b1", "work_experience_bullet", "Built A first"),
      applied("b1", "work_experience_bullet", "Built A second"),
    ]);
    const exp = blocksAfter(model, "Experience")!;
    expect(exp[1]).toEqual({ type: "bullets", items: ["Built A first", "Built B", "Built C"] });
  });

  it("formats certification meta from issueDate/expiryDate, treating blank strings as absent", () => {
    const issueOnly = buildResumeModel({ ...profile, certifications: [{ ...profile.certifications[0], expiryDate: null }] }, []);
    expect(blocksAfter(issueOnly, "Certifications")![0]).toMatchObject({ meta: "2022" });

    const expiryOnly = buildResumeModel({ ...profile, certifications: [{ ...profile.certifications[0], issueDate: null }] }, []);
    expect(blocksAfter(expiryOnly, "Certifications")![0]).toMatchObject({ meta: "Expires 2025" });

    const blankIssue = buildResumeModel({ ...profile, certifications: [{ ...profile.certifications[0], issueDate: "" }] }, []);
    expect(blocksAfter(blankIssue, "Certifications")![0]).toMatchObject({ meta: "Expires 2025" });

    const bothBlank = buildResumeModel(
      { ...profile, certifications: [{ ...profile.certifications[0], issueDate: "  ", expiryDate: "" }] },
      []
    );
    expect(blocksAfter(bothBlank, "Certifications")![0]).toMatchObject({ meta: null });
  });

  it("collapses blank fieldOfStudy, gpa, project url and experience company/location to null/omitted", () => {
    const model = buildResumeModel(
      {
        ...profile,
        experiences: [{ ...profile.experiences[0], company: "  ", location: "" }],
        projects: [{ ...profile.projects[1], url: "   " }],
        education: [{ ...profile.education[0], fieldOfStudy: "  ", gpa: "" }],
      },
      []
    );
    expect(blocksAfter(model, "Experience")![0]).toMatchObject({ subtitle: null });
    expect(blocksAfter(model, "Projects")![0]).toMatchObject({ subtitle: null });
    expect(blocksAfter(model, "Education")![0]).toEqual({ type: "entry", title: "BSc", subtitle: "TU Berlin", meta: "2016 – 2020" });
  });

  it("throws when an applied bullet's id belongs to a different source type", () => {
    expect(() => buildResumeModel(profile, [applied("b1", "achievement", "x")])).toThrow(/b1/);
  });

  // Fix round 2 (second review): an empty/whitespace-only optimizedText must fall back to the original
  // text -- Phase 6's AppliedBullet schema allows z.string(), so the guard does not stop this reaching
  // here, and the item stays first (selection order), not the text.

  it("falls back to the original bullet text when optimizedText is blank, keeping selection order", () => {
    const model = buildResumeModel(profile, [applied("b3", "work_experience_bullet", "   ")]);
    const exp = blocksAfter(model, "Experience")!;
    expect(exp[1]).toEqual({ type: "bullets", items: ["Built C", "Built A", "Built B"] });
  });

  it("falls back to the original achievement text when optimizedText is empty, keeping selection order", () => {
    const model = buildResumeModel(profile, [applied("a2", "achievement", "")]);
    const ach = blocksAfter(model, "Achievements")!;
    expect(ach[0]).toEqual({ type: "bullets", items: ["Award Y", "Award X"] });
  });

  it("falls back to the original project description when optimizedText is blank, keeping selection order", () => {
    const model = buildResumeModel(profile, [applied("p2", "project", "  ")]);
    const proj = blocksAfter(model, "Projects")!;
    expect(proj.slice(0, 2)).toEqual([
      { type: "entry", title: "Proj Two", subtitle: "https://two.example", meta: null },
      { type: "paragraph", text: "Second project" },
    ]);
  });

  it("renders verified skills in the Skills section, selected ones first, using the job's term (R4)", () => {
    const p = { ...profile, skills: [{ id: "s1", name: "SQL" }], verifiedSkills: [{ id: "v1", term: "Docker" }, { id: "v2", term: "Kubernetes" }] };
    const model = buildResumeModel(p, [applied("v2", "verified_skill", "x")]);
    expect(blocksAfter(model, "Skills")![0]).toEqual({ type: "paragraph", text: "SQL, Kubernetes, Docker" });
  });

  it("shows the Skills section when only verified skills exist", () => {
    const model = buildResumeModel({ ...profile, skills: [], verifiedSkills: [{ id: "v1", term: "Docker" }] }, []);
    expect(model.blocks).toContainEqual({ type: "paragraph", text: "Docker" });
  });

  it("still rejects a verified_skill id that is not in the profile", () => {
    expect(() => buildResumeModel({ ...profile, verifiedSkills: [] }, [applied("nope", "verified_skill", "")])).toThrow(/unknown source fact/);
  });
});
