import { z } from "zod";
import type { NormalizedJob } from "../types";

/** `job_postings.normalized` is jsonb, so Dates travel as ISO strings. */
export function serializeNormalized(job: NormalizedJob): Record<string, unknown> {
  return { ...job, postedAt: job.postedAt ? job.postedAt.toISOString() : null };
}

const SalaryResultSchema = z.object({
  raw: z.string().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  currency: z.string().nullable(),
  period: z.enum(["year", "month", "hour"]).nullable(),
  isParsed: z.boolean(),
});

// Validates the shape of a stored `NormalizedJob` snapshot on read (D42): a snapshot written
// under an older shape (a field renamed or added since) must never silently pass through as
// `undefined` -- see the call site in recomputeJob.ts for why.
const NormalizedJobSchema = z.object({
  externalId: z.string(),
  url: z.string().nullable(),
  companyName: z.string(),
  companyKey: z.string(),
  title: z.string(),
  titleKey: z.string(),
  seniority: z.string().nullable(),
  locationRaw: z.string().nullable(),
  locationKey: z.string(),
  countryCode: z.string().nullable(),
  workMode: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  employmentType: z.string().nullable(),
  descriptionText: z.string(),
  descriptionHash: z.string(),
  salary: SalaryResultSchema,
  minExperience: z.object({ years: z.number().nullable(), evidence: z.string().nullable() }),
  sponsorship: z.object({
    value: z.enum(["offered", "not_offered", "unknown"]),
    evidence: z.string().nullable(),
    conflict: z.boolean(),
  }),
  postedAt: z.date().nullable(),
});

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
  const candidate = { ...v, postedAt };
  const parsed = NormalizedJobSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("invalid normalized snapshot"); // same fixed message as above -- never leak snapshot content
  return parsed.data;
}
