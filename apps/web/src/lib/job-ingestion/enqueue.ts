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

/**
 * Put a source on the ingestion queue. The fixed job id per source means a second click while a run is
 * waiting or active is reported as `already_queued` instead of piling up. `queueName` is overridable so
 * tests never touch a real worker's queue.
 */
export async function enqueueIngestion(
  env: { REDIS_URL: string },
  sourceId: string,
  queueName: string = INGEST_QUEUE_NAME
): Promise<EnqueueResult> {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<IngestJobData>(queueName, { connection });
  try {
    const existing = await queue.getJob(ingestJobId(sourceId));
    if (existing && PENDING_STATES.has(await existing.getState())) return "already_queued";
    await queue.add(INGEST_JOB_NAME, { sourceId }, { ...INGEST_JOB_OPTIONS, jobId: ingestJobId(sourceId) });
    return "enqueued";
  } finally {
    await queue.close();
    connection.disconnect();
  }
}
