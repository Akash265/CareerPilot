import type { StoredDocumentFormat, DocumentKind } from "./types";

const MAX_BASE = 120;
const MAX_PART = 50;

/** Same cleaning `sanitizeFilename` applies, without the extension or the "document" fallback -- shared so
 *  `buildDownloadFilename` can cap the name and company parts independently before they are joined. */
function cleanPart(value: string, maxLen: number): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 .,_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
    .trim();
}

/** ASCII-only, filesystem- and header-safe download name (the real key in storage is generated). */
export function sanitizeFilename(base: string, extension: StoredDocumentFormat): string {
  const cleaned = cleanPart(base, MAX_BASE);
  const safe = cleaned.replace(/^[.\s]+/, "");
  return `${safe.length > 0 ? safe : "document"}.${extension}`;
}

const KIND_LABELS: Record<DocumentKind, string> = {
  resume: "Resume",
  pitch: "Pitch",
  cover_letter: "Cover Letter",
  interview_prep: "Interview Prep",
  tailored_resume: "Resume",
};

/**
 * `sanitizeFilename`'s 120-char cap applies to the whole "name - company - kind" string, so a long company
 * name could truncate the string before it reached " - Resume"/" - Pitch" -- the resume and pitch downloads
 * for the same job then collided on one filename. Capping the name and company parts independently (50
 * chars each -- well under half of `MAX_BASE`, leaving headroom for the separators and the kind suffix)
 * guarantees the suffix always survives.
 */
export function buildDownloadFilename(fullName: string, companyName: string, kind: DocumentKind, format: StoredDocumentFormat): string {
  const name = cleanPart(fullName, MAX_PART);
  const company = cleanPart(companyName, MAX_PART);
  return sanitizeFilename(`${name} - ${company} - ${KIND_LABELS[kind]}`, format);
}
