import { and, eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { MAX_EXTERNAL_ID_CHARS, normalizeRecord } from "../normalize/normalizeRecord";
import { IngestError, isSearchKind, type IngestErrorClass, type NormalizedJob, type SearchQuery, type SourceAdapter, type SourceRef } from "../types";
import { closeMissingPostings } from "./closeMissing";
import { hashPayload } from "./hashPayload";
import { persistPosting } from "./persistPosting";

const { jobSources, ingestionRuns, rawJobPostings, jobPostings, careerGoals, careerGoalConstraints } = schema;

/** A goal can name any number of roles and places; each is a request per provider, so only the first few are searched. */
const MAX_QUERY_TERMS = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunIngestionOptions {
  userId: string;
  sourceId: string;
  adapterFor: (source: SourceRef) => SourceAdapter;
  now?: () => Date;
  /** Phase 12 (D187): limits for search sources. Required to run one; board and upload sources ignore it. */
  search?: { maxDaysOld: number; maxPages: number; staleAfterDays: number };
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
  const search = isSearchKind(source.kind);
  // A wiring bug, not a source problem: fail before a run row exists rather than leave one "running".
  if (search && !opts.search) throw new Error("runIngestion: a search source needs opts.search");

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

  // A search source's query is the active confirmed goal; with none, the provider fails with no_active_goal.
  const query = search ? await inUserContext((tx) => activeGoalQuery(tx, opts.search!)) : undefined;
  const ref: SourceRef = { id: source.id, kind: source.kind, label: source.label, config: source.config, ...(query ? { query } : {}) };

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
        // A NUL byte makes the id itself unstorable: Postgres rejects it in ANY text parameter,
        // including the WHERE clause of the last_seen_at bump below (which runs in the outer
        // transaction and would doom it -- D41). Like an over-long id, such an id can never have
        // been previously stored, so it needs no bump.
        if (record.externalId.length > MAX_EXTERNAL_ID_CHARS || record.externalId.includes("\u0000")) {
          counters.failed++;
          return;
        }
        const at = now();
        let contentHash: string;
        try {
          contentHash = hashPayload(record.payload);
          // Runs in its own savepoint (nested transaction): once a statement inside a Postgres
          // transaction errors, Postgres aborts the WHOLE transaction until a ROLLBACK, and
          // postgres.js re-throws that error out of `db.transaction()` even if our own code
          // already caught it -- a plain try/catch around this insert can't stop it from also
          // dooming every record processed after it in this run. A savepoint isolates the
          // failure to just this record's raw-store attempt.
          await tx.transaction((savepoint) =>
            savepoint
              .insert(rawJobPostings)
              .values({ sourceId, externalId: record.externalId, payload: record.payload, contentHash, fetchedAt: at })
              .onConflictDoUpdate({
                target: [rawJobPostings.sourceId, rawJobPostings.externalId],
                set: { payload: record.payload, contentHash, fetchedAt: at },
              })
          );
        } catch {
          // The payload could not be hashed (e.g. pathologically deep JSON) or stored (e.g. an embedded
          // NUL byte, which Postgres text/jsonb columns reject outright): this record is unreadable, not
          // this run. Never let one hostile or malformed record abort every record after it.
          // It WAS seen, though: keep an already-tracked posting alive so a transient corruption
          // cannot make a complete run close it as "missing" (same protection as the normalize-failure
          // branch below). This runs in the outer transaction, which is still usable after the
          // savepoint above rolled back.
          await tx
            .update(jobPostings)
            .set({ lastSeenAt: at })
            .where(and(eq(jobPostings.sourceId, sourceId), eq(jobPostings.externalId, record.externalId)));
          counters.failed++;
          return;
        }

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
    if (complete && search) {
      // Search results depend on the query and the date window, so missing from one run says nothing; a posting
      // closes once it has not been seen for staleAfterDays (D187).
      const cutoff = new Date(startedAt.getTime() - opts.search!.staleAfterDays * 24 * 60 * 60 * 1000);
      counters.closed = await inUserContext((tx) => closeMissingPostings(tx, sourceId, cutoff, now()));
    } else if (complete && source.kind !== "upload") {
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

async function activeGoalQuery(
  tx: DbClient, limits: { maxDaysOld: number; maxPages: number },
): Promise<SearchQuery | undefined> {
  const [goal] = await tx
    .select({ roles: careerGoalConstraints.targetRoles, locations: careerGoalConstraints.locations, workMode: careerGoalConstraints.workMode })
    .from(careerGoals)
    .innerJoin(careerGoalConstraints, eq(careerGoalConstraints.careerGoalId, careerGoals.id))
    .where(and(eq(careerGoals.isActive, true), eq(careerGoals.confirmationStatus, "confirmed")))
    .limit(1);
  if (!goal) return undefined;
  const clean = (list: string[]) => [...new Set(list.map((v) => v.trim()).filter(Boolean))].slice(0, MAX_QUERY_TERMS);
  return {
    roles: clean(goal.roles), locations: clean(goal.locations), remoteOnly: goal.workMode === "remote",
    maxDaysOld: limits.maxDaysOld, maxPages: limits.maxPages,
  };
}
