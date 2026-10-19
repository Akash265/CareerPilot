// Real pdflatex via services/latex-compiler (Phase 13c spec §8). Runs only when LATEX_COMPILER_URL and
// LATEX_COMPILER_TOKEN are set and the service runs with LATEX_COMPILER_TEST_MODE=1 (CI does this; locally see docs/development.md).
import { describe, it, expect } from "vitest";
import { createHttpTexCompiler } from "./render/compileTex";
import { renderTex } from "./render/tex/renderTex";
import { SUPPORTED_SAMPLE } from "./render/tex/escapeTex";
import { selectTailoredResume } from "./model/selectTailoredResume";
import { estimateLines, lineBudget } from "./model/estimateLines";
import type { ResumeProfile } from "./model/resumeProfile";
import type { DocumentModel, PaperSize } from "./model/types";

const url = process.env.LATEX_COMPILER_URL;
const token = process.env.LATEX_COMPILER_TOKEN;
const enabled = Boolean(url && token);
const compiler = enabled ? createHttpTexCompiler({ url: url!, token: token! }) : null;

async function extract(pdf: Buffer): Promise<string> {
  const res = await fetch(new URL("/extract", url!), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: new Uint8Array(pdf) });
  expect(res.status).toBe(200);
  return res.text();
}
const squash = (s: string) => s.replace(/\s+/g, " ");

const injection = "\\input{/etc/passwd} \\write18{id} \\catcode`\\@=11 {braces} 50% $5 & #1 a_b ^ ~ [Remote] a--b it''s ,,x <<y>>";
const profile: ResumeProfile = {
  contact: { fullName: "Jürgen Müller", email: "j@example.com", phoneNumber: "+49 30 1234", linkedinUrl: "linkedin.com/in/jm" },
  experiences: [
    { id: "e1", company: "Globex", title: "Senior Engineer", location: "Berlin", startDate: "2021", endDate: null,
      bullets: [{ id: "b1", text: "Built C++, C# and .NET services – 40% faster" }, { id: "b2", text: injection }] },
  ],
  achievements: [],
  projects: [],
  certifications: [],
  education: [{ id: "ed1", institution: "TU Berlin", degree: "MSc", fieldOfStudy: "Informatik", startDate: "2015", endDate: "2017", gpa: null }],
  skills: [{ id: "s1", name: "Python" }, { id: "s2", name: "Kafka" }],
  verifiedSkills: [],
};

describe.skipIf(!enabled)("real pdflatex compile", () => {
  it("compiles a resume to one page whose text layer reads in order with exact characters", async () => {
    const { model } = selectTailoredResume(profile, [], [{ termText: "Kafka", requirementLevel: "required" }], { paperSize: "a4" });
    const out = await compiler!.compile(renderTex(model, { paperSize: "a4" }));
    expect(out.pageCount).toBe(1);
    const text = squash(await extract(out.pdf));
    const order = ["Jürgen Müller", "Experience", "Senior Engineer", "Globex", "Education", "Skills", "Kafka"].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("C++, C# and .NET services – 40% faster");
  });

  it("typesets TeX-looking text literally (no injection)", async () => {
    const model: DocumentModel = { title: "A", contactLine: null, blocks: [{ type: "heading", text: "Experience" }, { type: "bullets", items: [injection] }] };
    const out = await compiler!.compile(renderTex(model, { paperSize: "a4" }));
    // TeX typesets an ASCII apostrophe as the typographic one, so the text layer reads ’ where the input has '.
    expect(squash(await extract(out.pdf))).toContain(squash(injection).replace(/'/g, "\u2019"));
  });

  it("compiles every whitelisted character (whitelist is honest)", async () => {
    const model: DocumentModel = { title: "Sample", contactLine: null, blocks: [{ type: "paragraph", text: SUPPORTED_SAMPLE }] };
    await expect(compiler!.compile(renderTex(model, { paperSize: "a4" }))).resolves.toMatchObject({ pageCount: 1 });
  });

  it.each(["a4", "letter"] as PaperSize[])("estimate calibration (%s): at budget fits one page; well over budget does not", async (paperSize) => {
    // ~150 characters: two lines under both the estimate and real pdflatex on both paper sizes. (A bullet near the
    // single-line limit, ~111 chars on A4 / ~115 on Letter, would wrap differently per paper and make this test about the edge.)
    const bullet = "Designed and shipped a streaming ingestion service in Python and Kafka, cutting latency by 40% for 2M daily events and mentoring two engineers on the team";
    const modelWith = (n: number): DocumentModel => ({
      title: "Jane Doe", contactLine: "jane@example.com",
      blocks: [{ type: "heading", text: "Experience" }, { type: "entry", title: "Engineer", subtitle: "Globex", meta: "2021 – present" }, { type: "bullets", items: Array.from({ length: n }, () => bullet) }],
    });
    let n = 1;
    while (estimateLines(modelWith(n + 1), paperSize) <= lineBudget(paperSize)) n++;
    const atBudget = await compiler!.compile(renderTex(modelWith(n), { paperSize }));
    expect(atBudget.pageCount).toBe(1);
    let over = n;
    while (estimateLines(modelWith(over), paperSize) < lineBudget(paperSize) + 12) over++;
    const overBudget = await compiler!.compile(renderTex(modelWith(over), { paperSize }));
    expect(overBudget.pageCount).toBe(2);
  });
});
