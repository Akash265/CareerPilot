import type { DocumentModel, PaperSize } from "./types";

/**
 * Line metrics for renderTex's template (10pt Latin Modern, 0.6in margins). Starting values come from the page
 * geometry (A4: 756pt text height / 12pt baselineskip ≈ 63 lines; ~4.5pt average glyph width); the real-compile
 * test (latex.integration.test.ts) calibrates them. Changing them changes selection, not the template.
 */
export interface LineMetrics { linesPerPage: number; charsPerLine: number; charsPerBulletLine: number }
export const LINE_METRICS: Record<PaperSize, LineMetrics> = {
  a4: { linesPerPage: 63, charsPerLine: 110, charsPerBulletLine: 104 },
  letter: { linesPerPage: 58, charsPerLine: 114, charsPerBulletLine: 108 },
};
export const PAGE_SAFETY_LINES = 3;

const HEADER_LINES = 3;
const HEADING_LINES = 2;
const ENTRY_GAP = 0.3;
const LIST_GAP = 0.4;

const wrap = (length: number, perLine: number): number => Math.max(1, Math.ceil(length / perLine));

export function estimateLines(model: DocumentModel, paperSize: PaperSize): number {
  const m = LINE_METRICS[paperSize];
  let lines = HEADER_LINES;
  for (const block of model.blocks) {
    switch (block.type) {
      case "heading":
        lines += HEADING_LINES;
        break;
      case "entry":
        // title and meta share one line (\hfill); +1 separates them visually.
        lines += wrap(block.title.length + (block.meta?.length ?? 0) + 1, m.charsPerLine) + (block.subtitle !== null ? 1 : 0) + ENTRY_GAP;
        break;
      case "paragraph":
        lines += wrap(block.text.length, m.charsPerLine);
        break;
      case "bullets":
        if (block.items.length > 0) lines += LIST_GAP + block.items.reduce((sum, item) => sum + wrap(item.length, m.charsPerBulletLine), 0);
        break;
    }
  }
  return lines;
}

export function lineBudget(paperSize: PaperSize): number {
  return LINE_METRICS[paperSize].linesPerPage - PAGE_SAFETY_LINES;
}
