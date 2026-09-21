import type { NormalizedJob } from "../types";

/** `job_postings.normalized` is jsonb, so Dates travel as ISO strings. */
export function serializeNormalized(job: NormalizedJob): Record<string, unknown> {
  return { ...job, postedAt: job.postedAt ? job.postedAt.toISOString() : null };
}

export function deserializeNormalized(value: unknown): NormalizedJob {
  const v = value as Record<string, unknown>;
  return {
    ...(v as unknown as NormalizedJob),
    postedAt: typeof v.postedAt === "string" ? new Date(v.postedAt) : null,
  };
}
