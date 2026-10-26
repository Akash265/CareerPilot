import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";

const { ingestionRuns, jobSources, searchRuns } = schema;

/** The reason recorded on a run that was cut off because its worker stopped (D219). */
export const INTERRUPTED = "interrupted";

/** Search-run source states that had not finished when the run was cut off. */
const UNFINISHED = new Set(["queued", "running", "late"]);

/**
 * Called by the job-ingestion worker as it starts, before it takes any work (D219). Exactly one job-ingestion worker
 * runs, so an ingestion run or a coordinated search run still marked in progress belongs to a process that is gone:
 * it is failed with reason "interrupted". A source whose last result is older than its interrupted run records the
 * interruption, the way runIngestion records a finished run. Queued search runs are left for the worker to pick up;
 * a running/matching one would never resume (the coordinator only claims queued runs), so it would otherwise block
 * "Find matching jobs" until the 10-minute stall rule.
 */
export async function markInterruptedRuns(
  db: DbClient, userId: string, now: Date = new Date()
): Promise<{ ingestionRuns: number; searchRuns: number }> {
  return withUserContext(db, userId, async (tx) => {
    const runs = await tx
      .update(ingestionRuns)
      .set({ status: "failed", errorClass: INTERRUPTED, finishedAt: now })
      .where(eq(ingestionRuns.status, "running"))
      .returning({ sourceId: ingestionRuns.sourceId, startedAt: ingestionRuns.startedAt });
    for (const run of runs) {
      await tx
        .update(jobSources)
        .set({ lastRunAt: now, lastRunStatus: "failed", lastErrorClass: INTERRUPTED })
        .where(and(eq(jobSources.id, run.sourceId), or(isNull(jobSources.lastRunAt), lt(jobSources.lastRunAt, run.startedAt))));
    }
    const searches = await tx
      .select({ id: searchRuns.id, sources: searchRuns.sources })
      .from(searchRuns)
      .where(inArray(searchRuns.status, ["running", "matching"]));
    for (const search of searches) {
      // Its unfinished sources were cut off too; left as they were, the panel would list them as still fetching.
      const sources = search.sources.map((s) =>
        UNFINISHED.has(s.state) ? { sourceId: s.sourceId, name: s.name, kind: s.kind, state: "failed" as const, reason: INTERRUPTED } : s
      );
      await tx
        .update(searchRuns)
        .set({ status: "failed", errorCode: INTERRUPTED, finishedAt: now, sources })
        .where(and(eq(searchRuns.id, search.id), inArray(searchRuns.status, ["running", "matching"])));
    }
    return { ingestionRuns: runs.length, searchRuns: searches.length };
  });
}
