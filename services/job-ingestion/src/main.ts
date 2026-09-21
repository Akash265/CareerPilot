import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { INGEST_QUEUE_NAME, createAdapterFor, type IngestJobData } from "@ai-career/ingestion";
import { reconcileSchedules } from "./reconcile";
import { createIngestWorker } from "./worker";

// Structured logs only, and never posting content: ids, counts and error CLASSES (CLAUDE.md §9, D29).
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));

const safeErrorLabel = (error: unknown): string =>
  error instanceof Error && (error.name === "UnrecoverableError" || error.name === "IngestError")
    ? error.message
    : error instanceof Error
      ? error.name
      : "unknown";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  // BullMQ workers require maxRetriesPerRequest: null on their connection.
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<IngestJobData>(INGEST_QUEUE_NAME, { connection });
  const adapterFor = createAdapterFor({
    db,
    userId: env.DEFAULT_USER_ID,
    greenhouseBaseUrl: env.GREENHOUSE_API_BASE,
    leverBaseUrl: env.LEVER_API_BASE,
  });
  const worker = createIngestWorker({ connection, db, userId: env.DEFAULT_USER_ID, adapterFor });
  worker.on("completed", (job) => log("ingest_completed", { jobId: job.id }));
  worker.on("failed", (job, error) => log("ingest_failed", { jobId: job?.id, error: safeErrorLabel(error) }));

  const everyMs = env.INGEST_INTERVAL_MINUTES * 60_000;
  const reconcile = async (refresh: boolean) => {
    try {
      const plan = await reconcileSchedules({ db, userId: env.DEFAULT_USER_ID, queue, everyMs, refresh });
      if (refresh || plan.upsert.length > 0 || plan.remove.length > 0) {
        log("schedules_reconciled", { upserted: plan.upsert.length, removed: plan.remove.length });
      }
    } catch (error) {
      log("schedule_reconcile_failed", { error: safeErrorLabel(error) });
    }
  };

  await reconcile(true);
  // The database is the source of truth: pick up sources enabled/disabled from the web app.
  const timer = setInterval(() => void reconcile(false), 60_000);
  log("worker_started", { everyMinutes: env.INGEST_INTERVAL_MINUTES });

  const shutdown = async () => {
    clearInterval(timer);
    await worker.close();
    await queue.close();
    await connection.quit();
    await closeDbClient(db);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log("worker_crashed", { error: safeErrorLabel(error) });
  process.exit(1);
});
