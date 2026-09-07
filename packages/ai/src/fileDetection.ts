import { fileTypeFromBuffer } from "file-type";

export type ResumeFileType = "pdf" | "docx" | "tex";

export class UnsupportedFileTypeError extends Error {
  constructor(detail: string) {
    super(`Unsupported resume file type: ${detail}`);
    this.name = "UnsupportedFileTypeError";
  }
}

export async function detectResumeFileType(
  buffer: Buffer,
  originalFilename: string
): Promise<ResumeFileType> {
  const detected = await fileTypeFromBuffer(buffer);
  if (detected?.mime === "application/pdf") return "pdf";
  if (
    detected?.mime ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (originalFilename.toLowerCase().endsWith(".tex") && !buffer.includes(0)) {
    return "tex";
  }
  throw new UnsupportedFileTypeError(
    `detected=${detected?.mime ?? "unknown"}, filename=${originalFilename}`
  );
}
