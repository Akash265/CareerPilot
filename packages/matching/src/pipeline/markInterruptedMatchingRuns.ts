import { eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";

const { matchingRuns } = schema;

/** The reason recorded on a run that was cut off because its worker stopped (D219). */
export const INTERRUPTED_MATCHING = "interrupted";

/**
 * Called by the matching worker as it starts, before it takes any work (D219). Exactly one matching worker runs, so a
 * matching run still marked running belongs to a process that is gone: it is failed with reason "interrupted". BullMQ
 * re-runs the interrupted job itself (stalled-job recovery), which records a new run.
 */
export async function markInterruptedMatchingRuns(db: DbClient, userId: string, now: Date = new Date()): Promise<number> {
  const rows = await withUserContext(db, userId, (tx) =>
    tx
      .update(matchingRuns)
      .set({ status: "failed", errorClass: INTERRUPTED_MATCHING, finishedAt: now })
      .where(eq(matchingRuns.status, "running"))
      .returning({ id: matchingRuns.id })
  );
  return rows.length;
}
