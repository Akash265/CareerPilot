import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { createLogger, initProcessLogging, throttleErrorLog } from "@ai-career/logging";
import { createShutdown, originalJobError, startHeartbeat } from "@ai-career/monitoring";
import { INGEST_QUEUE_NAME, createAdapterFor, createPoliteFetch, providerConfigFromEnv, type IngestJobData } from "@ai-career/ingestion";
import { reconcileSchedules } from "./reconcile";
import { createIngestWorker } from "./worker";

// Structured logs only, and never posting content: ids, counts and error classes (CLAUDE.md §9, D29, Phase 11b).
const log = createLogger({ service: "job-ingestion" });

/** Our own error classes carry a fixed error class as their message, so that one message is safe to log. */
const failureFields = (error: unknown) => ({
  error,
  ...(error instanceof Error && (error.name === "UnrecoverableError" || error.name === "IngestError") ? { errorClass: error.message } : {}),
});

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  const stopRedactionRefresh = await initProcessLogging({
    level: env.LOG_LEVEL, load: () => loadRedactionValues(db, env.DEFAULT_USER_ID), logger: log,
  });
  // BullMQ workers require maxRetriesPerRequest: null on their connection.
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  // Phase 11b: beat from right after Redis opens, so /status shows this worker running -- and a crash later in
  // startup reads as "stale" -- at the configured interval; a clean shutdown records "stopped".
  const heartbeat = await startHeartbeat(connection, "job-ingestion", { intervalMs: env.HEARTBEAT_INTERVAL_MS });
  const queue = new Queue<IngestJobData>(INGEST_QUEUE_NAME, { connection });
  // One polite fetch for every provider: requests to a host are DISCOVERY_MIN_INTERVAL_MS apart (Phase 12, D188).
  const fetchFn = createPoliteFetch({ minIntervalMs: env.DISCOVERY_MIN_INTERVAL_MS });
  const adapterFor = createAdapterFor({ db, userId: env.DEFAULT_USER_ID, providers: providerConfigFromEnv(env), fetchFn });
  const search = { maxDaysOld: env.DISCOVERY_MAX_DAYS_OLD, maxPages: env.DISCOVERY_MAX_PAGES, staleAfterDays: env.DISCOVERY_STALE_DAYS };
  const worker = createIngestWorker({ connection, db, userId: env.DEFAULT_USER_ID, adapterFor, search });
  worker.on("completed", (job) => log.info("ingest_completed", { jobId: job.id }));
  worker.on("failed", (job, rawError) => {
    const error = originalJobError(rawError);
    log.error("ingest_failed", { jobId: job?.id, ...failureFields(error) });
  });
  // Redis connection errors are re-emitted here; with no listener the worker would crash with Node's raw print.
  worker.on("error", throttleErrorLog(log, "worker_error"));

  const everyMs = env.INGEST_INTERVAL_MINUTES * 60_000;
  const reconcile = async (refresh: boolean) => {
    try {
      const plan = await reconcileSchedules({ db, userId: env.DEFAULT_USER_ID, queue, everyMs, refresh });
      if (refresh || plan.upsert.length > 0 || plan.remove.length > 0) {
        log.info("schedules_reconciled", { upserted: plan.upsert.length, removed: plan.remove.length });
      }
    } catch (error) {
      log.error("schedule_reconcile_failed", failureFields(error));
    }
  };

  await reconcile(true);
  // The database is the source of truth: pick up sources enabled/disabled from the web app.
  const timer = setInterval(() => void reconcile(false), 60_000);
  log.info("worker_started", { everyMinutes: env.INGEST_INTERVAL_MINUTES });

  // Runs once however many signals arrive, exits 0, and is cut off with exit 1 if a step hangs (Redis unreachable).
  const shutdown = createShutdown({
    logger: log,
    steps: async () => {
      clearInterval(timer);
      stopRedactionRefresh();
      await worker.close();
      await queue.close();
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
