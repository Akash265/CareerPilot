import { describe, it, expect } from "vitest";
import { renderTex } from "./renderTex";
import type { DocumentModel } from "../../model/types";

const model: DocumentModel = {
  title: "Jane Doe",
  contactLine: "jane@example.com · +49 1",
  blocks: [
    { type: "heading", text: "Experience" },
    { type: "entry", title: "Engineer", subtitle: "Globex · Berlin", meta: "2021 – present" },
    { type: "bullets", items: ["Built A & B", "[Remote] 50% faster"] },
    { type: "heading", text: "Projects" },
    { type: "entry", title: "Tool", subtitle: null, meta: null },
    { type: "paragraph", text: "A CLI" },
    { type: "heading", text: "Skills" },
    { type: "paragraph", text: "C++, C#, .NET" },
  ],
};

describe("renderTex", () => {
  it("renders the template (golden)", () => {
    expect(renderTex(model, { paperSize: "a4" })).toMatchSnapshot();
  });
  it("switches paper size", () => {
    expect(renderTex(model, { paperSize: "letter" })).toContain("\\usepackage[letterpaper,margin=0.6in]{geometry}");
    expect(renderTex(model, { paperSize: "a4" })).toContain("\\usepackage[a4paper,margin=0.6in]{geometry}");
  });
  it("escapes every model string and keeps ATS-safe settings", () => {
    const tex = renderTex(model, { paperSize: "a4" });
    expect(tex).toContain("\\item Built A \\& B");
    expect(tex).toContain("\\item {[}Remote{]} 50\\% faster");
    expect(tex).toContain("C++, C\\#, .NET");
    expect(tex).toContain("\\pdfgentounicode=1");
    expect(tex).not.toMatch(/tabular|multicol|includegraphics|fontawesome/);
  });
  it("omits an empty contact line, empty bullet lists and a missing subtitle/meta", () => {
    const tex = renderTex({ title: "A", contactLine: null, blocks: [{ type: "entry", title: "T", subtitle: null, meta: null }, { type: "bullets", items: [] }] }, { paperSize: "a4" });
    expect(tex).not.toContain("\\small");
    expect(tex).not.toContain("\\begin{itemize}");
    expect(tex).not.toContain("\\hfill");
    expect(tex).not.toContain("\\textit");
  });
});
