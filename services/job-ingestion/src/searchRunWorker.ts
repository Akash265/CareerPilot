import { Worker, type ConnectionOptions } from "bullmq";
import { contentFreeJobError } from "@ai-career/monitoring";
import { SEARCH_RUN_QUEUE_NAME, coordinateSearchRun, type CoordinatorDeps, type SearchRunJobData } from "@ai-career/ingestion";

/**
 * Phase 13a: its own Worker, not the ingest worker -- the ingest worker runs one job at a time, so a coordinator
 * waiting inside it for ingestion jobs would wait for itself. Concurrency 1: one search run at a time per user.
 */
export function createSearchRunWorker(deps: {
  connection: ConnectionOptions; userId: string; coordinatorDeps: Omit<CoordinatorDeps, "userId">; queueName?: string;
}): Worker<SearchRunJobData> {
  return new Worker<SearchRunJobData>(
    deps.queueName ?? SEARCH_RUN_QUEUE_NAME,
    async (job) => {
      try {
        await coordinateSearchRun({ ...deps.coordinatorDeps, userId: deps.userId }, job.data.runId);
      } catch (error) {
        throw contentFreeJobError(error);
      }
    },
    // A run can take FIND_JOBS_MAX_WAIT_SECONDS + FIND_JOBS_MATCH_WAIT_SECONDS; the coordinator's own heartbeat on
    // the row is what /api/search-runs reads, so BullMQ's lock only needs renewing, which the Worker does.
    { connection: deps.connection, concurrency: 1 },
  );
}
