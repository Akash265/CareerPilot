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
