import IORedis from "ioredis";
import { Queue } from "bullmq";
import { SEARCH_RUN_JOB_NAME, SEARCH_RUN_JOB_OPTIONS, SEARCH_RUN_QUEUE_NAME, type SearchRunJobData } from "@ai-career/ingestion";

const TIMEOUT_MS = 5000;

/** Fixed message on purpose: driver errors carry the Redis host and port. The run id is the job id (one job per run). */
export async function enqueueSearchRun(env: { REDIS_URL: string }, runId: string, queueName: string = SEARCH_RUN_QUEUE_NAME): Promise<void> {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3000, retryStrategy: () => null });
  const queue = new Queue<SearchRunJobData>(queueName, { connection });
  connection.on("error", () => undefined);
  queue.on("error", () => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      queue.add(SEARCH_RUN_JOB_NAME, { runId }, { ...SEARCH_RUN_JOB_OPTIONS, jobId: runId }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS); }),
    ]);
  } catch {
    throw new Error("queue unavailable");
  } finally {
    clearTimeout(timer);
    await Promise.race([queue.close(), new Promise((r) => setTimeout(r, 1000))]).catch(() => undefined);
    connection.disconnect();
  }
}
