import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";

const { ingestionRuns, searchRuns } = schema;

/**
 * Phase 13a: new, changed or closed jobs from a run outside an active search run need a re-match. A search run in
 * `queued`/`running` will request matching itself; one already `matching` cannot see these jobs, so it does not
 * suppress the re-match (late sources).
 */
export function shouldRematch(input: { counts: { newCount: number; updatedCount: number; closedCount: number } | null; activeSearchRun: boolean }): boolean {
  if (!input.counts || input.activeSearchRun) return false;
  return input.counts.newCount + input.counts.updatedCount + input.counts.closedCount > 0;
}

export async function afterRunRematch(db: DbClient, userId: string, sourceId: string, since: Date): Promise<boolean> {
  return withUserContext(db, userId, async (tx) => {
    const [run] = await tx
      .select({ newCount: ingestionRuns.newCount, updatedCount: ingestionRuns.updatedCount, closedCount: ingestionRuns.closedCount })
      .from(ingestionRuns)
      .where(and(eq(ingestionRuns.sourceId, sourceId), gte(ingestionRuns.startedAt, since)))
      .orderBy(desc(ingestionRuns.startedAt))
      .limit(1);
    const active = await tx.select({ id: searchRuns.id }).from(searchRuns).where(inArray(searchRuns.status, ["queued", "running"])).limit(1);
    return shouldRematch({ counts: run ?? null, activeSearchRun: active.length > 0 });
  });
}

type RematchLog = {
  info: (message: string, fields: Record<string, unknown>) => void;
  error: (message: string, fields: Record<string, unknown>) => void;
};

/**
 * Phase 13a (R8): the re-match runs before board discovery in `afterRun`, so a DB or Redis failure here is logged
 * and swallowed -- it may never skip recordBoardsFromRun / validateBoards for the same run.
 */
export async function requestRematchSafely(
  check: () => Promise<boolean>,
  rematch: () => Promise<string>,
  log: RematchLog,
  sourceId: string,
): Promise<void> {
  try {
    if (await check()) log.info("rematch_requested", { sourceId, result: await rematch() });
  } catch (error) {
    log.error("rematch_failed", { sourceId, error });
  }
}
