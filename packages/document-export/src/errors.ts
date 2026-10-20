export type DocumentExportErrorClass =
  | "job_not_found"
  | "source_mismatch"
  | "profile_changed"
  | "pitch_unsupported"
  | "cover_letter_unsupported"
  | "no_profile"
  | "invalid_content"
  | "storage_unavailable"
  | "compiler_unavailable"
  | "compiler_busy"
  | "compiler_timeout"
  | "compile_failed"
  | "unsupported_character";

export class DocumentExportError extends Error {
  readonly errorClass: DocumentExportErrorClass;
  /** Safe-to-show context, e.g. "Experience, entry 2, bullet 3" -- never resume text. */
  readonly detail: string | undefined;
  constructor(errorClass: DocumentExportErrorClass, options?: { cause?: unknown; detail?: string }) {
    super(errorClass, options);
    this.name = "DocumentExportError";
    this.errorClass = errorClass;
    this.detail = options?.detail;
  }
}
