/** Format-neutral document (Phase 7b design §4.1); both renderers consume only this. */
export type DocumentBlock =
  | { type: "heading"; text: string }
  | { type: "entry"; title: string; subtitle: string | null; meta: string | null }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] };

export interface DocumentModel {
  title: string;
  contactLine: string | null;
  blocks: DocumentBlock[];
}

export type DocumentFormat = "pdf" | "docx";
/** What a stored generated_documents row can be: the two rendered formats plus LaTeX source (Phase 13c). */
export type StoredDocumentFormat = DocumentFormat | "tex";
export type DocumentKind = "resume" | "pitch" | "cover_letter" | "interview_prep" | "tailored_resume";

/** Bump whenever either renderer's output for the same model changes (it is part of the content hash). */
export const RENDERER_VERSION = "1";

/** Phase 13c. Bump whenever renderTex's output for the same model changes (part of the tailored content hash). */
export const TEX_TEMPLATE_VERSION = "1";

export type PaperSize = "a4" | "letter";

/** The items a tailored resume may leave out; everything else is always kept. */
export type RankableSourceType = "work_experience_bullet" | "project" | "achievement";

export interface OmittedItem {
  /** Skills and verified skills are reported only when they do not fit the skills line. */
  sourceType: RankableSourceType | "skill" | "verified_skill";
  sourceFactId: string;
  reason: "no_requirement_match" | "page_limit";
}

/** Stored in generated_documents.details for kind tailored_resume (ids and reasons only, no resume text). */
export interface TailoredResumeDetails {
  pageCount: number | null;
  pageVerified: boolean;
  includedCount: number;
  totalCount: number;
  omitted: OmittedItem[];
}
