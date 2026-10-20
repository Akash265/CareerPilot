// apps/web/src/lib/documents/exportErrors.ts
import { NextResponse } from "next/server";
import type { DocumentExportError } from "@ai-career/document-export";

export const COMPILER_START_COMMAND = "docker compose -f infra/docker-compose.yml --env-file .env --profile latex up -d latex-compiler";

const RESPONSES: Record<DocumentExportError["errorClass"], [number, string]> = {
  job_not_found: [404, "Job not found"],
  source_mismatch: [400, "That version does not belong to this job"],
  profile_changed: [409, "Your profile changed since this optimization. Regenerate it first."],
  pitch_unsupported: [409, "This pitch has an unsupported bullet. Edit or regenerate it first."],
  cover_letter_unsupported: [409, "This cover letter has an unsupported paragraph. Edit or regenerate it first."],
  no_profile: [409, "Confirm your profile first"],
  storage_unavailable: [502, "Document storage is unavailable. Try again."],
  invalid_content: [500, "The document could not be generated."],
  compiler_unavailable: [503, `The LaTeX compiler isn't running. Start it with: ${COMPILER_START_COMMAND}`],
  compiler_busy: [503, "The LaTeX compiler is busy. Try again in a moment."],
  compiler_timeout: [504, "The LaTeX compiler took too long. Try again."],
  compile_failed: [502, "The resume could not be typeset. This is a bug; the compiler log has the line number."],
  unsupported_character: [422, "Your profile contains a character the LaTeX resume can't typeset"],
};

export function exportErrorResponse(error: DocumentExportError): NextResponse {
  const [status, message] = RESPONSES[error.errorClass];
  const text = error.errorClass === "unsupported_character" && error.detail ? `${message} (${error.detail}). Edit your profile to remove it.` : message;
  return NextResponse.json({ error: text }, { status });
}
