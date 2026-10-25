import type { DocumentBlock, DocumentModel, PaperSize } from "../../model/types";
import { escapeTex } from "./escapeTex";

const PAPER: Record<PaperSize, string> = { a4: "a4paper", letter: "letterpaper" };

/**
 * One single-column, ATS-safe template (Phase 13c spec §4): standard section names, no tables/columns/icons/
 * graphics, glyphtounicode so the PDF text layer is real characters. Change => bump TEX_TEMPLATE_VERSION.
 */
function preamble(model: DocumentModel, paperSize: PaperSize): string[] {
  const name = escapeTex(model.title);
  return [
    "\\documentclass[10pt]{article}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage{lmodern}",
    `\\usepackage[${PAPER[paperSize]},margin=0.6in]{geometry}`,
    "\\usepackage{titlesec}",
    "\\usepackage{enumitem}",
    "\\usepackage[hidelinks]{hyperref}",
    "\\input{glyphtounicode}",
    "\\pdfgentounicode=1",
    "\\pagestyle{empty}",
    "\\setlength{\\parindent}{0pt}",
    "\\titleformat{\\section}{\\large\\bfseries}{}{0pt}{}[\\titlerule]",
    "\\titlespacing*{\\section}{0pt}{8pt}{4pt}",
    "\\setlist[itemize]{leftmargin=1.2em,itemsep=1pt,topsep=2pt,parsep=0pt}",
    `\\hypersetup{pdftitle={${name} - Resume},pdfauthor={${name}}}`,
  ];
}

function blockTex(block: DocumentBlock): string {
  switch (block.type) {
    case "heading":
      return `\\section*{${escapeTex(block.text)}}`;
    case "entry": {
      const title = `\\textbf{${escapeTex(block.title)}}`;
      const first = block.meta !== null ? `${title}\\hfill{}${escapeTex(block.meta)}\\par` : `${title}\\par`;
      const lines = ["\\vspace{2pt}", first];
      if (block.subtitle !== null) lines.push(`\\textit{${escapeTex(block.subtitle)}}\\par`);
      return lines.join("\n");
    }
    case "paragraph":
      return `${escapeTex(block.text)}\\par`;
    case "bullets":
      if (block.items.length === 0) return "";
      return ["\\begin{itemize}", ...block.items.map((item) => `\\item ${escapeTex(item)}`), "\\end{itemize}"].join("\n");
  }
}

export function renderTex(model: DocumentModel, opts: { paperSize: PaperSize }): string {
  const header = [
    "\\begin{center}",
    `{\\LARGE\\bfseries ${escapeTex(model.title)}}\\par`,
    ...(model.contactLine !== null ? ["\\vspace{2pt}", `{\\small ${escapeTex(model.contactLine)}}\\par`] : []),
    "\\end{center}",
  ];
  const body = model.blocks.map(blockTex).filter((s) => s.length > 0);
  // Last action before \end{document}: report the space left on the (last) page so the export can refill it from
  // the real layout (D217). The compiler service reads only this line-anchored number from the log.
  const reportFreeSpace = "\\par\\typeout{CAREERPILOT-FREE-SPACE=\\the\\dimexpr\\pagegoal-\\pagetotal\\relax}";
  return [...preamble(model, opts.paperSize), "\\begin{document}", ...header, ...body, reportFreeSpace, "\\end{document}", ""].join("\n");
}
