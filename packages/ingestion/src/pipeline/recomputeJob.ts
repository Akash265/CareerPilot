import { eq, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { mergePostings, type MergedJob, type PostingForMerge } from "../identity/merge";
import { deserializeNormalized } from "../identity/serialize";
import type { NormalizedJob } from "../types";

const { jobs, jobPostings, jobSources } = schema;

export function mergedToJobRow(m: MergedJob, now: Date) {
  return {
    companyName: m.companyName,
    companyKey: m.companyKey,
    title: m.title,
    titleKey: m.titleKey,
    seniority: m.seniority,
    locationRaw: m.locationRaw,
    locationKey: m.locationKey,
    countryCode: m.countryCode,
    workMode: m.workMode,
    employmentType: m.employmentType,
    descriptionText: m.descriptionText,
    descriptionHash: m.descriptionHash,
    salaryRaw: m.salaryRaw,
    salaryMin: m.salaryMin === null ? null : String(m.salaryMin),
    salaryMax: m.salaryMax === null ? null : String(m.salaryMax),
    salaryCurrency: m.salaryCurrency,
    salaryPeriod: m.salaryPeriod,
    salaryIsParsed: m.salaryIsParsed,
    minExperienceYears: m.minExperienceYears,
    minExperienceEvidence: m.minExperienceEvidence,
    sponsorship: m.sponsorship,
    sponsorshipEvidence: m.sponsorshipEvidence,
    sponsorshipConflict: m.sponsorshipConflict,
    postedAt: m.postedAt,
    firstSeenAt: m.firstSeenAt,
    lastVerifiedAt: m.lastVerifiedAt,
    status: m.status,
    fieldProvenance: m.fieldProvenance,
    updatedAt: now,
  };
}

/** Rebuild the canonical job from all of its postings. The single writer of derived job fields. */
export async function recomputeJob(tx: DbClient, jobId: string, now: Date): Promise<void> {
  const rows = await tx
    .select({ posting: jobPostings, kind: jobSources.kind })
    .from(jobPostings)
    .innerJoin(jobSources, eq(jobPostings.sourceId, jobSources.id))
    .where(eq(jobPostings.jobId, jobId));
  if (rows.length === 0) return;

  const postings: PostingForMerge[] = [];
  for (const { posting, kind } of rows) {
    let normalized: NormalizedJob;
    try {
      normalized = deserializeNormalized(posting.normalized);
    } catch {
      // An incompatible or corrupted stored snapshot (e.g. from a NormalizedJob shape change)
      // must never crash or silently corrupt the whole job: skip just this posting.
      continue;
    }
    postings.push({ id: posting.id, sourceKind: kind, status: posting.status, firstSeenAt: posting.firstSeenAt, lastSeenAt: posting.lastSeenAt, normalized });
  }
  if (postings.length === 0) return; // every posting's snapshot is unreadable: leave the job as it is
  const merged = mergePostings(postings);

  await tx
    .update(jobs)
    .set({
      ...mergedToJobRow(merged, now),
      // Stamp the close time once; keep it on later recomputes; clear it on reopen.
      closedAt: merged.status === "closed" ? sql`coalesce(${jobs.closedAt}, ${now.toISOString()}::timestamptz)` : null,
    })
    .where(eq(jobs.id, jobId));
}
