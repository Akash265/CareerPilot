import IORedis from "ioredis";
import { Queue } from "bullmq";
import {
  INGEST_JOB_NAME,
  INGEST_JOB_OPTIONS,
  INGEST_QUEUE_NAME,
  ingestJobId,
  type IngestJobData,
} from "@ai-career/ingestion";

export type EnqueueResult = "enqueued" | "already_queued";

const PENDING_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);
const ENQUEUE_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 1000;

/** Fixed message on purpose: driver errors carry the Redis host and port, which callers must never echo. */
const unavailable = () => new Error("queue unavailable");

/** Resolves or rejects with `promise`, or rejects with `onTimeout()` after `ms`. The timer never outlives the race. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  // If the timeout wins, `promise` may still reject later (its connection is torn down); keep that handled.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Put a source on the ingestion queue. The fixed job id per source means a second click while a run is
 * waiting or active is reported as `already_queued` instead of piling up. `queueName` is overridable so
 * tests never touch a real worker's queue.
 *
 * This is a producer, so it must fail fast when Redis is down (the default ioredis settings BullMQ's
 * Workers need -- `maxRetriesPerRequest: null` -- would make every call wait forever). Any failure, a
 * timeout included, is reported as the plain error "queue unavailable".
 */
export async function enqueueIngestion(
  env: { REDIS_URL: string },
  sourceId: string,
  queueName: string = INGEST_QUEUE_NAME
): Promise<EnqueueResult> {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    retryStrategy: () => null,
  });
  const queue = new Queue<IngestJobData>(queueName, { connection });
  // Both emit 'error' while Redis is unreachable; without a listener that would crash the process.
  connection.on("error", () => undefined);
  queue.on("error", () => undefined);
  try {
    return await withTimeout(push(queue, sourceId), ENQUEUE_TIMEOUT_MS, unavailable);
  } catch {
    throw unavailable();
  } finally {
    // Best-effort: never let cleanup throw or hang, or mask the result.
    await withTimeout(queue.close(), CLOSE_TIMEOUT_MS, unavailable).catch(() => undefined);
    connection.disconnect();
  }
}

async function push(queue: Queue<IngestJobData>, sourceId: string): Promise<EnqueueResult> {
  const existing = await queue.getJob(ingestJobId(sourceId));
  if (existing && PENDING_STATES.has(await existing.getState())) return "already_queued";
  await queue.add(INGEST_JOB_NAME, { sourceId }, { ...INGEST_JOB_OPTIONS, jobId: ingestJobId(sourceId) });
  return "enqueued";
}
