import PDFDocument from "pdfkit";
import type { DocumentModel } from "../model/types";
import { NOTO_SANS_BOLD_BASE64, NOTO_SANS_REGULAR_BASE64 } from "./fonts.generated";

const MARGIN = 50;
const BULLET_INDENT = 12;

/**
 * Single-column, text-only A4 PDF (Phase 7b design §4.5): real text in an embedded Unicode font, no images or
 * tables, automatic page breaks -- the machine-readable shape the spec's §10.2 scorecard asks for.
 */
export function renderPdf(model: DocumentModel): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: MARGIN, info: { Title: model.title, Producer: "CareerPilot" } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.registerFont("body", Buffer.from(NOTO_SANS_REGULAR_BASE64, "base64"));
  doc.registerFont("bold", Buffer.from(NOTO_SANS_BOLD_BASE64, "base64"));
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.font("bold").fontSize(18).text(model.title, left, doc.y, { width });
  if (model.contactLine) doc.font("body").fontSize(10).text(model.contactLine, left, doc.y, { width });

  for (const block of model.blocks) {
    if (block.type === "heading") {
      doc.moveDown(0.8);
      doc.font("bold").fontSize(12).text(block.text, left, doc.y, { width });
      const y = doc.y + 1;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).stroke();
      doc.moveDown(0.3);
    } else if (block.type === "entry") {
      doc.moveDown(0.3);
      doc.font("bold").fontSize(11).text(block.title, left, doc.y, { width });
      const sub = [block.subtitle, block.meta].filter(Boolean).join(" · ");
      if (sub) doc.font("body").fontSize(10).text(sub, left, doc.y, { width });
    } else if (block.type === "paragraph") {
      doc.font("body").fontSize(10).text(block.text, left, doc.y, { width, lineGap: 1 });
    } else {
      for (const item of block.items) {
        const y = doc.y;
        doc.font("body").fontSize(10).text("•", left, y, { lineBreak: false });
        doc.text(item, left + BULLET_INDENT, y, { width: width - BULLET_INDENT, lineGap: 1 });
      }
    }
    doc.x = left;
  }

  doc.end();
  return done;
}
