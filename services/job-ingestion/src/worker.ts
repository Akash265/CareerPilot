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
      try {
        await runIngestion(deps.db, { userId: deps.userId, sourceId: job.data.sourceId, adapterFor: deps.adapterFor });
      } catch (error) {
        if (error instanceof IngestError && !error.retryable) throw new UnrecoverableError(error.errorClass);
        throw error;
      }
    },
    { connection: deps.connection, concurrency: 1 }
  );
}
