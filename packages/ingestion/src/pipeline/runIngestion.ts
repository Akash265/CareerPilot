import { and, eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { normalizeRecord } from "../normalize/normalizeRecord";
import { IngestError, type IngestErrorClass, type NormalizedJob, type SourceAdapter, type SourceRef } from "../types";
import { closeMissingPostings } from "./closeMissing";
import { hashPayload } from "./hashPayload";
import { persistPosting } from "./persistPosting";

const { jobSources, ingestionRuns, rawJobPostings, jobPostings } = schema;

export interface RunIngestionOptions {
  userId: string;
  sourceId: string;
  adapterFor: (source: SourceRef) => SourceAdapter;
  now?: () => Date;
}

export interface RunSummary {
  runId: string;
  status: "succeeded" | "failed";
  /** True only when the fetch returned every record; only a complete run may close jobs. */
  complete: boolean;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  closed: number;
  failed: number;
  errorClass: IngestErrorClass | "empty_result" | null;
}

/**
 * One fetch -> store raw -> normalize -> identify/upsert -> close cycle for a source.
 * Throws `IngestError` (with a class only) when the run fails, after recording it.
 */
export async function runIngestion(db: DbClient, opts: RunIngestionOptions): Promise<RunSummary> {
  const { userId, sourceId } = opts;
  const now = opts.now ?? (() => new Date());
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, userId, fn);

  const [source] = await inUserContext((tx) => tx.select().from(jobSources).where(eq(jobSources.id, sourceId)).limit(1));
  if (!source) throw new IngestError("not_found");

  const startedAt = now();
  const [run] = await inUserContext((tx) =>
    tx.insert(ingestionRuns).values({ sourceId, startedAt }).returning({ id: ingestionRuns.id })
  );

  const counters = { fetched: 0, created: 0, updated: 0, unchanged: 0, closed: 0, failed: 0 };
  const finish = (status: "succeeded" | "failed", complete: boolean, errorClass: RunSummary["errorClass"]) =>
    inUserContext(async (tx) => {
      const finishedAt = now();
      await tx
        .update(ingestionRuns)
        .set({
          finishedAt,
          status,
          complete,
          fetchedCount: counters.fetched,
          newCount: counters.created,
          updatedCount: counters.updated,
          unchangedCount: counters.unchanged,
          closedCount: counters.closed,
          failedCount: counters.failed,
          errorClass,
        })
        .where(eq(ingestionRuns.id, run.id));
      await tx
        .update(jobSources)
        .set({ lastRunAt: finishedAt, lastRunStatus: status, lastErrorClass: errorClass })
        .where(eq(jobSources.id, sourceId));
    });
  const summary = (status: RunSummary["status"], complete: boolean, errorClass: RunSummary["errorClass"]): RunSummary => ({
    runId: run.id, status, complete, errorClass, ...counters,
  });

  // The D3 consent gate lives here, in worker code, not only in the UI.
  const guard: IngestErrorClass | null = !source.enabled
    ? "source_disabled"
    : !source.consentConfirmedAt
      ? "consent_missing"
      : null;
  if (guard) {
    await finish("failed", false, guard);
    throw new IngestError(guard);
  }

  const ref: SourceRef = { id: source.id, kind: source.kind, label: source.label, config: source.config };

  try {
    for await (const record of opts.adapterFor(ref).fetch(ref)) {
      counters.fetched++;
      await inUserContext(async (tx) => {
        const at = now();
        const contentHash = hashPayload(record.payload);
        await tx
          .insert(rawJobPostings)
          .values({ sourceId, externalId: record.externalId, payload: record.payload, contentHash, fetchedAt: at })
          .onConflictDoUpdate({
            target: [rawJobPostings.sourceId, rawJobPostings.externalId],
            set: { payload: record.payload, contentHash, fetchedAt: at },
          });

        let normalized: NormalizedJob | null;
        try {
          normalized = normalizeRecord(ref, record);
        } catch {
          normalized = null;
        }
        if (!normalized) {
          // Unreadable this time, but it WAS seen: keep an already-tracked posting alive so it is not closed.
          await tx
            .update(jobPostings)
            .set({ lastSeenAt: at })
            .where(and(eq(jobPostings.sourceId, sourceId), eq(jobPostings.externalId, record.externalId)));
          counters.failed++;
          return;
        }

        const { outcome } = await persistPosting(tx, {
          sourceId, sourceKind: source.kind, normalized, contentHash, now: at,
        });
        if (outcome === "created" || outcome === "linked") counters.created++;
        else if (outcome === "updated") counters.updated++;
        else counters.unchanged++;
      });
    }
  } catch (error) {
    const errorClass: IngestErrorClass = error instanceof IngestError ? error.errorClass : "unknown";
    await finish("failed", false, errorClass);
    throw error instanceof IngestError ? error : new IngestError("unknown");
  }

  // A fetch that returned nothing is more likely an API glitch than an emptied board: treat it as
  // incomplete so it can never mass-close a source's jobs.
  const complete = counters.fetched > 0;
  if (complete && source.kind !== "upload") {
    counters.closed = await inUserContext((tx) => closeMissingPostings(tx, sourceId, startedAt, now()));
  }
  const errorClass = complete ? null : "empty_result";
  await finish("succeeded", complete, errorClass);
  return summary("succeeded", complete, errorClass);
}
