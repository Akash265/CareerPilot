import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { DbUsageSink, closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { createLogger, initProcessLogging, throttleErrorLog } from "@ai-career/logging";
import { createShutdown, originalJobError, startHeartbeat } from "@ai-career/monitoring";
import { createAnthropicFor, withLangfuseExport, type AiUsageSink } from "@ai-career/ai";
import { MATCHING_QUEUE_NAME, type MatchingJobData } from "@ai-career/matching";
import { createMatchingWorker } from "./worker";
import { createFollowUp, isFinalFailure } from "./followUp";

// Structured logs only: ids and error classes, never job or profile content (CLAUDE.md §9, Phase 11b).
const log = createLogger({ service: "matching-worker" });

/** Our own error classes carry a fixed error class as their message, so that one message is safe to log. */
const failureFields = (error: unknown) => ({
  error,
  ...(error instanceof Error && (error.name === "UnrecoverableError" || error.name === "MatchingError") ? { errorClass: error.message } : {}),
});

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const stopRedactionRefresh = await initProcessLogging({
    level: env.LOG_LEVEL, load: () => loadRedactionValues(db, env.DEFAULT_USER_ID), logger: log,
  });
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  // Phase 11b: beat from right after Redis opens, so /status shows this worker running -- and a crash later in
  // startup reads as "stale" -- at the configured interval; a clean shutdown records "stopped".
  const heartbeat = await startHeartbeat(connection, "matching", { intervalMs: env.HEARTBEAT_INTERVAL_MS });

  const aiFor = (userId: string) => {
    // Typed as AiUsageSink so the compiler checks DbUsageSink still matches the AI package's interface.
    const usageSink: AiUsageSink = withLangfuseExport(new DbUsageSink(db, userId), env);
    return { usageSink, anthropicFor: createAnthropicFor(env, usageSink) };
  };

  const matchingQueue = new Queue<MatchingJobData>(MATCHING_QUEUE_NAME, { connection });
  const followUp = createFollowUp({ redis: connection, queue: matchingQueue, onError: (error) => log.error("rematch_failed", { error }) });

  const worker = createMatchingWorker({ connection, db, aiFor, env });
  worker.on("completed", (job) => log.info("matching_completed", { jobId: job.id }));
  worker.on("failed", (job, rawError) => {
    const error = originalJobError(rawError);
    log.error("matching_failed", { jobId: job?.id, ...failureFields(error) });
  });
  // Phase 13a (D193): one follow-up run if new jobs arrived while this run was in progress.
  worker.on("completed", (job) => void followUp(job.data.userId));
  worker.on("failed", (job, error) => {
    // Only a final failure frees the job id; a failure that will be retried keeps it (attempts: 2).
    if (job && isFinalFailure(job, error)) void followUp(job.data.userId);
  });
  // Redis connection errors are re-emitted here; with no listener the worker would crash with Node's raw print.
  worker.on("error", throttleErrorLog(log, "worker_error"));
  log.info("worker_started");

  // Runs once however many signals arrive, exits 0, and is cut off with exit 1 if a step hangs (Redis unreachable).
  const shutdown = createShutdown({
    logger: log,
    steps: async () => {
      stopRedactionRefresh();
      await worker.close();
      await matchingQueue.close();
      await heartbeat.stop();
      await connection.quit();
      await closeDbClient(db);
    },
  });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log.error("worker_crashed", failureFields(error));
  process.exit(1);
});
