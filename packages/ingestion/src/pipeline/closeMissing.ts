import { and, eq, lt } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { recomputeJob } from "./recomputeJob";

const { jobPostings } = schema;

/**
 * Close every open posting of `sourceId` that was not seen since `runStartedAt`, then recompute each
 * affected job (a job closes only when NONE of its postings, from any source, is open).
 * The caller must only invoke this for a COMPLETE run of a non-upload source.
 */
export async function closeMissingPostings(
  tx: DbClient,
  sourceId: string,
  runStartedAt: Date,
  now: Date
): Promise<number> {
  const closed = await tx
    .update(jobPostings)
    .set({ status: "closed" })
    .where(and(eq(jobPostings.sourceId, sourceId), eq(jobPostings.status, "open"), lt(jobPostings.lastSeenAt, runStartedAt)))
    .returning({ jobId: jobPostings.jobId });

  for (const jobId of new Set(closed.map((r) => r.jobId))) {
    await recomputeJob(tx, jobId, now);
  }
  return closed.length;
}
