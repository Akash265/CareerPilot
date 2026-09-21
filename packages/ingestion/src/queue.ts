// Shared by the worker (services/job-ingestion) and the web app's "Run now".
// Constants only -- this package deliberately does not depend on bullmq.

export const INGEST_QUEUE_NAME = "job-ingestion";
export const INGEST_JOB_NAME = "ingest-source";
export const SCHEDULER_PREFIX = "schedule-";

export interface IngestJobData {
  sourceId: string;
}

/**
 * A fixed job id per source makes BullMQ ignore a second enqueue while one is waiting or running.
 * (BullMQ rejects custom ids containing ":", hence the dash.)
 */
export const ingestJobId = (sourceId: string): string => `ingest-${sourceId}`;
export const schedulerIdFor = (sourceId: string): string => `${SCHEDULER_PREFIX}${sourceId}`;

/**
 * Transient failures (rate limit, 5xx, network) retry with backoff. Both removal flags are on so a
 * finished or failed job never keeps its id reserved and blocks the next enqueue; the outcome of
 * every attempt is recorded in `ingestion_runs`, not in Redis.
 */
export const INGEST_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
};
