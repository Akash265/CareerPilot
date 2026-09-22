import IORedis from "ioredis";
import { Queue } from "bullmq";
import {
  MATCHING_JOB_NAME,
  MATCHING_JOB_OPTIONS,
  MATCHING_QUEUE_NAME,
  matchingJobId,
  type MatchingJobData,
} from "@ai-career/matching";

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
 * Put a matching run on the queue. The fixed job id per user means a second click while a run is
 * waiting or active is reported as `already_queued` instead of piling up. `queueName` is overridable
 * so tests never touch a real worker's queue.
 *
 * This is a producer, so it must fail fast when Redis is down (the default ioredis settings BullMQ's
 * Workers need -- `maxRetriesPerRequest: null` -- would make every call wait forever). Any failure, a
 * timeout included, is reported as the plain error "queue unavailable".
 *
 * Mirrors `enqueueIngestion` exactly (same queue-producer failure-mode requirements); see its docstring.
 */
export async function enqueueMatching(
  env: { REDIS_URL: string },
  userId: string,
  queueName: string = MATCHING_QUEUE_NAME
): Promise<EnqueueResult> {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    retryStrategy: () => null,
  });
  const queue = new Queue<MatchingJobData>(queueName, { connection });
  // Both emit 'error' while Redis is unreachable; without a listener that would crash the process.
  connection.on("error", () => undefined);
  queue.on("error", () => undefined);
  try {
    return await withTimeout(push(queue, userId), ENQUEUE_TIMEOUT_MS, unavailable);
  } catch {
    throw unavailable();
  } finally {
    // Best-effort: never let cleanup throw or hang, or mask the result.
    await withTimeout(queue.close(), CLOSE_TIMEOUT_MS, unavailable).catch(() => undefined);
    connection.disconnect();
  }
}

async function push(queue: Queue<MatchingJobData>, userId: string): Promise<EnqueueResult> {
  const existing = await queue.getJob(matchingJobId(userId));
  if (existing && PENDING_STATES.has(await existing.getState())) return "already_queued";
  await queue.add(MATCHING_JOB_NAME, { userId }, { ...MATCHING_JOB_OPTIONS, jobId: matchingJobId(userId) });
  return "enqueued";
}
