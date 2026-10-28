import { AlignmentType, Document, HeadingLevel, LevelFormat, Packer, Paragraph, TextRun } from "docx";
import type { DocumentModel } from "../model/types";

const BULLETS = "cp-bullets";

/** Same structure as the PDF, as a native Word document: heading styles, real bullets, no tables/text boxes. */
export function renderDocx(model: DocumentModel): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(model.title)] })];
  if (model.contactLine) children.push(new Paragraph({ children: [new TextRun(model.contactLine)] }));

  for (const block of model.blocks) {
    if (block.type === "heading") {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(block.text)] }));
    } else if (block.type === "entry") {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(block.title)] }));
      const sub = [block.subtitle, block.meta].filter(Boolean).join(" · ");
      if (sub) children.push(new Paragraph({ children: [new TextRun({ text: sub, italics: true })] }));
    } else if (block.type === "paragraph") {
      children.push(new Paragraph({ children: [new TextRun(block.text)] }));
    } else {
      for (const item of block.items) {
        children.push(new Paragraph({ numbering: { reference: BULLETS, level: 0 }, children: [new TextRun(item)] }));
      }
    }
  }

  const doc = new Document({
    creator: "CareerPilot",
    title: model.title,
    numbering: {
      config: [
        {
          reference: BULLETS,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 260 } } },
            },
          ],
        },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
