import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import type { ResumeFileType } from "./fileDetection";

export async function extractText(buffer: Buffer, fileType: ResumeFileType): Promise<string> {
  if (fileType === "pdf") {
    const result = await pdfParse(buffer);
    return result.text;
  }
  if (fileType === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  return buffer.toString("utf-8");
}
