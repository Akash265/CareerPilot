// apps/web/src/lib/documents/serializeDocument.ts
import type { GeneratedDocumentRow, TailoredResumeDetails } from "@ai-career/document-export";

export interface DocumentView {
  id: string;
  kind: "resume" | "pitch" | "cover_letter" | "interview_prep" | "tailored_resume";
  format: "pdf" | "docx" | "tex";
  sourceVersion: number | null;
  downloadFilename: string;
  byteSize: number;
  createdAt: string;
  downloadUrl: string;
  /** Phase 13c: tailored_resume only. */
  details: TailoredResumeDetails | null;
}

export function toDocumentView(row: GeneratedDocumentRow, sourceVersion: number | null): DocumentView {
  return {
    id: row.id,
    kind: row.kind,
    format: row.format,
    sourceVersion,
    downloadFilename: row.downloadFilename,
    byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(),
    downloadUrl: `/api/documents/${row.id}/download`,
    details: (row.details as TailoredResumeDetails | null) ?? null,
  };
}

export const CONTENT_TYPES: Record<"pdf" | "docx" | "tex", string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  tex: "application/x-tex; charset=utf-8",
};

/** RFC 6266 / 5987: ASCII fallback plus UTF-8 filename*. The stored name is already ASCII-sanitized. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
