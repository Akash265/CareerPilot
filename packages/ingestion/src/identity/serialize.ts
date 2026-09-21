import type { NormalizedJob } from "../types";

/** `job_postings.normalized` is jsonb, so Dates travel as ISO strings. */
export function serializeNormalized(job: NormalizedJob): Record<string, unknown> {
  return { ...job, postedAt: job.postedAt ? job.postedAt.toISOString() : null };
}

/**
 * Rebuilds a NormalizedJob from a stored snapshot. The message of the thrown error is fixed on
 * purpose: the snapshot holds job/company text and must never leak into logs.
 */
export function deserializeNormalized(value: unknown): NormalizedJob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid normalized snapshot");
  }
  const v = value as Record<string, unknown>;
  let postedAt: Date | null = null;
  if (typeof v.postedAt === "string") {
    const parsed = new Date(v.postedAt);
    // A corrupt stored date must not become an (truthy) Invalid Date that poisons merging.
    postedAt = Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return { ...(v as unknown as NormalizedJob), postedAt };
}
