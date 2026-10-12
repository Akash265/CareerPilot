import type { PortalAdapter } from "./types";
import { SAFE_IDENTIFIER } from "./types";
import { greenhouseV1 } from "./greenhouse";
import { leverV1 } from "./lever";

/** One posting of a job, joined with its source. `slug` comes from job_sources.config. */
export interface PostingRef {
  /** Any source kind; only Greenhouse and Lever postings can be autofilled (Phase 12 added more kinds). */
  sourceKind: string;
  slug: string | null;
  externalId: string;
  status: "open" | "closed";
  lastSeenAt: Date;
}

export type UnsupportedReason = "no_supported_posting" | "invalid_identifiers";
export type AutofillTarget =
  | { supported: true; adapter: PortalAdapter; formUrl: string }
  | { supported: false; reason: UnsupportedReason };

const BY_KIND = { greenhouse: greenhouseV1, lever: leverV1 } as const;

/**
 * Design §4.1: the form URL is built from the source's board slug and the posting's external id, never taken
 * from the scraped posting URL (often a company page that iframes the form). Newest open posting wins.
 */
export function resolveAutofillTarget(postings: PostingRef[]): AutofillTarget {
  const candidates = postings
    .filter((p) => p.status === "open" && (p.sourceKind === "greenhouse" || p.sourceKind === "lever"))
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  if (candidates.length === 0) return { supported: false, reason: "no_supported_posting" };
  for (const p of candidates) {
    if (p.slug === null || !SAFE_IDENTIFIER.test(p.slug) || !SAFE_IDENTIFIER.test(p.externalId)) continue;
    const adapter = BY_KIND[p.sourceKind as "greenhouse" | "lever"];
    return { supported: true, adapter, formUrl: adapter.buildFormUrl({ slug: p.slug, externalId: p.externalId }) };
  }
  return { supported: false, reason: "invalid_identifiers" };
}
