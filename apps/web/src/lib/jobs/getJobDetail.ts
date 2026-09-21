import { eq, inArray, or } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { toJobListItem, type JobListItem } from "./listJobs";

const { jobs, jobPostings, jobSources, jobDuplicateCandidates } = schema;

export interface JobDetail extends JobListItem {
  seniority: string | null;
  employmentType: string | null;
  countryCode: string | null;
  descriptionText: string;
  minExperienceEvidence: string | null;
  sponsorshipEvidence: string | null;
  sponsorshipConflict: boolean;
  lastVerifiedAt: string;
  closedAt: string | null;
  /** field group -> id of the posting that supplied it. */
  fieldProvenance: Record<string, string>;
  postings: {
    id: string;
    sourceId: string;
    sourceKind: "greenhouse" | "lever" | "upload";
    sourceLabel: string;
    url: string | null;
    status: "open" | "closed";
    firstSeenAt: string;
    lastSeenAt: string;
  }[];
  /** Possible duplicates: never merged, listed for the user to judge. */
  duplicateCandidates: {
    jobId: string;
    title: string;
    companyName: string;
    locationRaw: string | null;
    status: "open" | "closed";
    similarity: number;
    review: "pending" | "same" | "different";
  }[];
}

export async function getJobDetail(tx: DbClient, id: string): Promise<JobDetail | null> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) return null;

  const postings = await tx
    .select({ posting: jobPostings, kind: jobSources.kind, label: jobSources.label })
    .from(jobPostings)
    .innerJoin(jobSources, eq(jobPostings.sourceId, jobSources.id))
    .where(eq(jobPostings.jobId, id))
    .orderBy(jobPostings.firstSeenAt);

  const pairs = await tx
    .select()
    .from(jobDuplicateCandidates)
    .where(or(eq(jobDuplicateCandidates.jobIdA, id), eq(jobDuplicateCandidates.jobIdB, id)));
  const otherIds = pairs.map((p) => (p.jobIdA === id ? p.jobIdB : p.jobIdA));
  const others =
    otherIds.length > 0 ? await tx.select().from(jobs).where(inArray(jobs.id, otherIds)) : [];
  const otherById = new Map(others.map((o) => [o.id, o]));

  return {
    ...toJobListItem(job),
    seniority: job.seniority,
    employmentType: job.employmentType,
    countryCode: job.countryCode,
    descriptionText: job.descriptionText,
    minExperienceEvidence: job.minExperienceEvidence,
    sponsorshipEvidence: job.sponsorshipEvidence,
    sponsorshipConflict: job.sponsorshipConflict,
    lastVerifiedAt: job.lastVerifiedAt.toISOString(),
    closedAt: job.closedAt?.toISOString() ?? null,
    fieldProvenance: job.fieldProvenance,
    postings: postings.map(({ posting, kind, label }) => ({
      id: posting.id,
      sourceId: posting.sourceId,
      sourceKind: kind,
      sourceLabel: label,
      url: posting.url,
      status: posting.status,
      firstSeenAt: posting.firstSeenAt.toISOString(),
      lastSeenAt: posting.lastSeenAt.toISOString(),
    })),
    duplicateCandidates: pairs
      .map((pair) => {
        const other = otherById.get(pair.jobIdA === id ? pair.jobIdB : pair.jobIdA);
        return other
          ? {
              jobId: other.id,
              title: other.title,
              companyName: other.companyName,
              locationRaw: other.locationRaw,
              status: other.status,
              similarity: pair.similarity,
              review: pair.status,
            }
          : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.similarity - a.similarity),
  };
}
