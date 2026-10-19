import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { DbUsageSink, closeDbClient, createDbClient, loadRedactionValues } from "@ai-career/db";
import { createLogger, initProcessLogging, throttleErrorLog } from "@ai-career/logging";
import { createShutdown, originalJobError, startHeartbeat } from "@ai-career/monitoring";
import {
  INGEST_JOB_NAME, INGEST_JOB_OPTIONS, INGEST_QUEUE_NAME, createAdapterFor, createPoliteFetch, providerConfigFromEnv, ingestJobId, recordBoardsFromRun, retireIfGone, searchWebForBoards, validatePendingBoards,
  type IngestJobData,
} from "@ai-career/ingestion";
import { createAnthropicFor, withLangfuseExport } from "@ai-career/ai";
import { flagRematchIfRunning, MATCHING_QUEUE_NAME, pushMatching, requestRematch, type MatchingJobData } from "@ai-career/matching";
import { afterRunRematch, requestRematchSafely } from "./rematch";
import { createSearchRunWorker } from "./searchRunWorker";
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
  const matchingQueue = new Queue<MatchingJobData>(MATCHING_QUEUE_NAME, { connection });
  const rematch = () => requestRematch({ redis: connection, queue: matchingQueue }, env.DEFAULT_USER_ID, env.MATCH_DEBOUNCE_SECONDS * 1000);
  // One polite fetch for every provider: requests to a host are DISCOVERY_MIN_INTERVAL_MS apart (Phase 12, D188).
  const fetchFn = createPoliteFetch({ minIntervalMs: env.DISCOVERY_MIN_INTERVAL_MS });
  const adapterFor = createAdapterFor({ db, userId: env.DEFAULT_USER_ID, providers: providerConfigFromEnv(env), fetchFn });
  const search = { maxDaysOld: env.DISCOVERY_MAX_DAYS_OLD, maxPages: env.DISCOVERY_MAX_PAGES, staleAfterDays: env.DISCOVERY_STALE_DAYS };
  // Phase 12 (D186): automatic company discovery. Validation fetches each pending board once; one pass at a time.
  let validating = false;
  const validateBoards = async () => {
    if (validating) return;
    validating = true;
    try {
      const result = await validatePendingBoards(db, {
        userId: env.DEFAULT_USER_ID, adapterFor, maxSources: env.DISCOVERY_MAX_SOURCES, maxPerRun: env.DISCOVERY_MAX_NEW_PER_RUN,
      });
      if (result.enabled + result.rejected > 0) log.info("boards_validated", { ...result });
    } finally {
      validating = false;
    }
  };
  const afterRun = async ({ sourceId, since, errorClass }: { sourceId: string; since: Date; errorClass: string | null }) => {
    // Phase 13a: changes outside a search run's collection phase are re-matched, debounced.
    // Guarded: a failure here must never skip board discovery below.
    if (errorClass === null) {
      await requestRematchSafely(() => afterRunRematch(db, env.DEFAULT_USER_ID, sourceId, since), rematch, log, sourceId);
    }
    if (errorClass === null) {
      const found = await recordBoardsFromRun(db, { userId: env.DEFAULT_USER_ID, sourceId, since });
      if (found > 0) log.info("boards_discovered", { sourceId, found });
      // In the background: a pass can take minutes (one request per second per host), and the queue processes one
      // job at a time, so awaiting it here would hold up every other source.
      void validateBoards().catch((error) => log.error("discovery_failed", { error }));
    } else if (errorClass === "not_found" && (await retireIfGone(db, { userId: env.DEFAULT_USER_ID, sourceId }))) {
      log.info("board_retired", { sourceId });
    }
  };
  const worker = createIngestWorker({
    connection, db, userId: env.DEFAULT_USER_ID, adapterFor, search,
    afterRun, onAfterRunError: (error) => log.error("discovery_failed", { error }),
  });
  worker.on("completed", (job) => log.info("ingest_completed", { jobId: job.id }));
  worker.on("failed", (job, rawError) => {
    const error = originalJobError(rawError);
    log.error("ingest_failed", { jobId: job?.id, ...failureFields(error) });
  });
  // Redis connection errors are re-emitted here; with no listener the worker would crash with Node's raw print.
  worker.on("error", throttleErrorLog(log, "worker_error"));

  const usageSink = withLangfuseExport(new DbUsageSink(db, env.DEFAULT_USER_ID), env);
  const anthropicFor = createAnthropicFor(env, usageSink);
  const searchRunWorker = createSearchRunWorker({
    connection,
    userId: env.DEFAULT_USER_ID,
    coordinatorDeps: {
      db,
      env,
      enqueueSource: async (sourceId) => {
        await queue.add(INGEST_JOB_NAME, { sourceId }, { ...INGEST_JOB_OPTIONS, jobId: ingestJobId(sourceId) });
      },
      requestMatching: async () => {
        const result = await pushMatching(matchingQueue, env.DEFAULT_USER_ID, { promoteDelayed: true });
        // A run in progress cannot see this run's jobs: the matching worker runs once more when it finishes.
        return flagRematchIfRunning({ redis: connection, queue: matchingQueue }, env.DEFAULT_USER_ID, result);
      },
      webSearch: (goal) => searchWebForBoards(anthropicFor("discovery_web_search"), env, goal),
      startValidation: () => void validateBoards().catch((error) => log.error("discovery_failed", { error })),
    },
  });
  searchRunWorker.on("completed", (job) => log.info("search_run_finished", { runId: job.data.runId }));
  searchRunWorker.on("failed", (job, rawError) => log.error("search_run_crashed", { runId: job?.data.runId, ...failureFields(originalJobError(rawError)) }));
  searchRunWorker.on("error", throttleErrorLog(log, "search_run_worker_error"));

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
  // The database is the source of truth: pick up sources enabled/disabled from the web app, and boards pasted there.
  const timer = setInterval(() => {
    void reconcile(false);
    void validateBoards().catch((error) => log.error("discovery_failed", { error }));
  }, 60_000);
  log.info("worker_started", { everyMinutes: env.INGEST_INTERVAL_MINUTES });

  // Runs once however many signals arrive, exits 0, and is cut off with exit 1 if a step hangs (Redis unreachable).
  const shutdown = createShutdown({
    logger: log,
    steps: async () => {
      clearInterval(timer);
      stopRedactionRefresh();
      await worker.close();
      await searchRunWorker.close();
      await queue.close();
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
