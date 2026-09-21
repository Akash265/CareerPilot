import { and, eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { MAX_EXTERNAL_ID_CHARS, normalizeRecord } from "../normalize/normalizeRecord";
import { IngestError, type IngestErrorClass, type NormalizedJob, type SourceAdapter, type SourceRef } from "../types";
import { closeMissingPostings } from "./closeMissing";
import { hashPayload } from "./hashPayload";
import { persistPosting } from "./persistPosting";

const { jobSources, ingestionRuns, rawJobPostings, jobPostings } = schema;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // A malformed id can never name a source; say so instead of letting Postgres reject the cast.
  if (!UUID.test(sourceId)) throw new IngestError("not_found");

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
  // Recording a failure is best-effort: if it fails too, the caller must still see the ORIGINAL error
  // class, never the (possibly value-carrying) database error from the recording attempt.
  const finishQuietly = async (errorClass: IngestErrorClass) => {
    try {
      await finish("failed", false, errorClass);
    } catch {
      // swallowed on purpose; see above
    }
  };
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
    await finishQuietly(guard);
    throw new IngestError(guard);
  }

  const ref: SourceRef = { id: source.id, kind: source.kind, label: source.label, config: source.config };

  // A fetch that returned nothing is more likely an API glitch than an emptied board: treat it as
  // incomplete so it can never mass-close a source's jobs.
  let complete = false;

  // The fetch loop AND the closing step share one catch, so any failure in either is recorded as a
  // failed, incomplete run and surfaces as an IngestError (class only), never a raw error.
  try {
    for await (const record of opts.adapterFor(ref).fetch(ref)) {
      counters.fetched++;
      await inUserContext(async (tx) => {
        // Checked before the raw upsert, not only inside normalizeRecord: an over-long id would make the
        // raw table's unique btree index throw, failing this run and every later run of the source.
        if (record.externalId.length > MAX_EXTERNAL_ID_CHARS) {
          counters.failed++;
          return;
        }
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

    complete = counters.fetched > 0;
    if (complete && source.kind !== "upload") {
      counters.closed = await inUserContext((tx) => closeMissingPostings(tx, sourceId, startedAt, now()));
    }
  } catch (error) {
    const failure = error instanceof IngestError ? error : new IngestError("unknown");
    await finishQuietly(failure.errorClass);
    throw failure;
  }

  const errorClass = complete ? null : "empty_result";
  try {
    await finish("succeeded", complete, errorClass);
  } catch {
    // The work is done but could not be recorded as such: mark the run failed if we still can.
    await finishQuietly("unknown");
    throw new IngestError("unknown");
  }
  return summary("succeeded", complete, errorClass);
}
