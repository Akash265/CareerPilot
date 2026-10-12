import { contentFreeJobError } from "@ai-career/monitoring";
import { Worker, UnrecoverableError, type ConnectionOptions } from "bullmq";
import type { DbClient } from "@ai-career/db";
import {
  INGEST_QUEUE_NAME,
  IngestError,
  runIngestion,
  type IngestJobData,
  type SourceAdapter,
  type SourceRef,
} from "@ai-career/ingestion";

export interface IngestWorkerDeps {
  connection: ConnectionOptions;
  db: DbClient;
  userId: string;
  adapterFor: (source: SourceRef) => SourceAdapter;
  /** Phase 12: limits for goal-driven search sources (D187). */
  search: { maxDaysOld: number; maxPages: number; staleAfterDays: number };
  /**
   * Phase 12 (D186): runs after every run, successful or not -- the worker hooks board discovery and retirement
   * here. It can never fail the job: an error is passed to `onAfterRunError` (a log line) and swallowed.
   */
  afterRun?: (event: { sourceId: string; since: Date; errorClass: string | null }) => Promise<void>;
  onAfterRunError?: (error: unknown) => void;
  /** Overridable so tests use an isolated queue. */
  queueName?: string;
}

/**
 * The worker holds no domain logic: it hands a source id to `runIngestion` and maps its error classes
 * onto BullMQ's retry model. Permanent failures (no consent, bad slug, 404, schema mismatch) must not
 * retry; transient ones (429, 5xx, network, timeout) do, with the queue's backoff.
 * Concurrency 1: fetches are I/O-bound and a personal watch-list is small, so this is simply "one
 * source at a time" and it rules out two runs of the same source racing.
 */
export function createIngestWorker(deps: IngestWorkerDeps): Worker<IngestJobData> {
  return new Worker<IngestJobData>(
    deps.queueName ?? INGEST_QUEUE_NAME,
    async (job) => {
      const since = new Date();
      const after = async (errorClass: string | null) => {
        try {
          await deps.afterRun?.({ sourceId: job.data.sourceId, since, errorClass });
        } catch (error) {
          deps.onAfterRunError?.(error);
        }
      };
      try {
        await runIngestion(deps.db, { userId: deps.userId, sourceId: job.data.sourceId, adapterFor: deps.adapterFor, search: deps.search });
      } catch (error) {
        await after(error instanceof IngestError ? error.errorClass : "unknown");
        if (error instanceof IngestError && !error.retryable) throw new UnrecoverableError(error.errorClass);
        throw contentFreeJobError(error);
      }
      await after(null);
    },
    { connection: deps.connection, concurrency: 1 }
  );
}
