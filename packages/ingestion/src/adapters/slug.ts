import { IngestError } from "../types";

/**
 * Board tokens are interpolated into a URL path. This character set cannot
 * introduce a host, port, path separator, query or fragment, so a slug can
 * never redirect a request to a different destination (SSRF).
 */
export const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function assertValidSlug(slug: unknown): string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new IngestError("invalid_slug");
  return slug;
}
