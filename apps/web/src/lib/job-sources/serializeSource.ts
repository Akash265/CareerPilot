import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";

const { jobSources, ingestionRuns } = schema;

type SourceRow = typeof jobSources.$inferSelect;
type RunRow = typeof ingestionRuns.$inferSelect;

export interface JobSourceView {
  id: string;
  kind: "greenhouse" | "lever" | "upload";
  label: string;
  slug: string | null;
  companyName: string | null;
  enabled: boolean;
  consentConfirmedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: "running" | "succeeded" | "failed" | null;
  /** An error class such as "not_found" or "empty_result" -- never a message. */
  lastErrorClass: string | null;
  lastRun: {
    complete: boolean;
    fetched: number;
    created: number;
    updated: number;
    unchanged: number;
    closed: number;
    failed: number;
  } | null;
  createdAt: string;
}

export function serializeSource(row: SourceRow, run: RunRow | null): JobSourceView {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    slug: row.config.slug ?? null,
    companyName: row.config.companyName ?? null,
    enabled: row.enabled,
    consentConfirmedAt: row.consentConfirmedAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus: row.lastRunStatus,
    lastErrorClass: row.lastErrorClass,
    lastRun: run
      ? {
          complete: run.complete,
          fetched: run.fetchedCount,
          created: run.newCount,
          updated: run.updatedCount,
          unchanged: run.unchangedCount,
          closed: run.closedCount,
          failed: run.failedCount,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A `running` row older than this is a crashed run (the worker died before it could finish the row),
 * not a run in flight. runIngestion only writes job_sources.last_run_status when a run ends, so the
 * running row itself is the only signal that a run is in progress.
 */
export const RUN_IN_FLIGHT_MAX_AGE_MS = 30 * 60 * 1000;

export async function listJobSourceViews(tx: DbClient): Promise<JobSourceView[]> {
  const sources = await tx.select().from(jobSources).orderBy(desc(jobSources.createdAt));
  if (sources.length === 0) return [];
  const sourceIds = sources.map((s) => s.id);
  const latestOf = (running: boolean) =>
    tx
      .selectDistinctOn([ingestionRuns.sourceId])
      .from(ingestionRuns)
      .where(
        and(
          inArray(ingestionRuns.sourceId, sourceIds),
          running ? eq(ingestionRuns.status, "running") : ne(ingestionRuns.status, "running")
        )
      )
      .orderBy(ingestionRuns.sourceId, desc(ingestionRuns.startedAt));
  const [latestRunning, latestFinished] = await Promise.all([latestOf(true), latestOf(false)]);
  const runningBySource = new Map(latestRunning.map((run) => [run.sourceId, run]));
  const finishedBySource = new Map(latestFinished.map((run) => [run.sourceId, run]));

  const now = Date.now();
  return sources.map((source) => {
    const running = runningBySource.get(source.id);
    const finished = finishedBySource.get(source.id) ?? null;
    const inFlight =
      running !== undefined &&
      now - running.startedAt.getTime() < RUN_IN_FLIGHT_MAX_AGE_MS &&
      (finished === null || running.startedAt > finished.startedAt);
    if (inFlight) {
      // Its counters are all still zero: showing them would read as a finished run that found nothing.
      return { ...serializeSource(source, null), lastRunStatus: "running" as const };
    }
    return serializeSource(source, finished);
  });
}
