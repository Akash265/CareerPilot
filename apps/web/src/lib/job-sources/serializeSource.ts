import { desc, inArray } from "drizzle-orm";
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

export async function listJobSourceViews(tx: DbClient): Promise<JobSourceView[]> {
  const sources = await tx.select().from(jobSources).orderBy(desc(jobSources.createdAt));
  if (sources.length === 0) return [];
  const latest = await tx
    .selectDistinctOn([ingestionRuns.sourceId])
    .from(ingestionRuns)
    .where(inArray(ingestionRuns.sourceId, sources.map((s) => s.id)))
    .orderBy(ingestionRuns.sourceId, desc(ingestionRuns.startedAt));
  const runBySource = new Map(latest.map((run) => [run.sourceId, run]));
  return sources.map((source) => serializeSource(source, runBySource.get(source.id) ?? null));
}
