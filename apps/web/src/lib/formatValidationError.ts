import type { z } from "zod";

/**
 * `ZodError.message` is a raw JSON dump of the issue array -- fine for a
 * server log, not something to render to a user. This turns it into a
 * short, readable list of which fields failed and why, e.g.
 * "contact.fullName: String must contain at least 1 character(s);
 * yearsOfExperience: Expected number, received string". No field *values*
 * are included, only paths/messages, so this is safe to surface even when
 * the underlying data is otherwise PII.
 */
export function formatValidationError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}
