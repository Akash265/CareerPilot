import { describe, it, expect } from "vitest";
import { estimateLines, lineBudget, LINE_METRICS, PAGE_SAFETY_LINES } from "./estimateLines";
import type { DocumentModel } from "./types";

const base: DocumentModel = { title: "Jane", contactLine: "x", blocks: [] };

describe("estimateLines", () => {
  it("counts the header alone", () => {
    expect(estimateLines(base, "a4")).toBe(3);
  });
  it("adds headings, entries (subtitle adds a line), wrapped paragraphs and bullets", () => {
    const cpl = LINE_METRICS.a4.charsPerLine;
    const bcpl = LINE_METRICS.a4.charsPerBulletLine;
    const model: DocumentModel = {
      ...base,
      blocks: [
        { type: "heading", text: "Experience" },                                   // 2
        { type: "entry", title: "E", subtitle: "S", meta: "2021" },                 // 2.3
        { type: "bullets", items: ["a".repeat(bcpl), "a".repeat(bcpl + 1)] },       // 0.4 + 1 + 2
        { type: "paragraph", text: "a".repeat(cpl * 2 + 1) },                       // 3
        { type: "bullets", items: [] },                                             // 0
      ],
    };
    expect(estimateLines(model, "a4")).toBeCloseTo(3 + 2 + 2.3 + 3.4 + 3, 5);
  });
  it("wraps an entry whose title and meta do not fit on one line", () => {
    const long = "a".repeat(LINE_METRICS.letter.charsPerLine);
    expect(estimateLines({ ...base, blocks: [{ type: "entry", title: long, subtitle: null, meta: "2021" }] }, "letter")).toBeCloseTo(3 + 2 + 0.3, 5);
  });
  it("budget is the page minus the safety margin", () => {
    expect(lineBudget("a4")).toBe(LINE_METRICS.a4.linesPerPage - PAGE_SAFETY_LINES);
  });
});
