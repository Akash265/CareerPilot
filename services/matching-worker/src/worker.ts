import { Worker, UnrecoverableError, type ConnectionOptions } from "bullmq";
import type Anthropic from "@anthropic-ai/sdk";
import type { DbClient } from "@ai-career/db";
import { MATCHING_QUEUE_NAME, MatchingError, runMatching, type MatchingJobData, type RunMatchingEnv } from "@ai-career/matching";

export interface MatchingWorkerDeps {
  connection: ConnectionOptions;
  db: DbClient;
  anthropicClient: Pick<Anthropic, "messages">;
  env: RunMatchingEnv;
  /** Overridable so tests use an isolated queue. */
  queueName?: string;
}

/**
 * Holds no domain logic: hands the user id to `runMatching` and maps its error class onto BullMQ's
 * retry model. "no_active_goal" would fail identically on every retry, so it is unrecoverable;
 * anything else (network, an unexpected exception) may be transient and gets the queue's backoff.
 * Concurrency 1, same rationale as the ingestion worker: this is a personal tool, one run at a time.
 */
export function createMatchingWorker(deps: MatchingWorkerDeps): Worker<MatchingJobData> {
  return new Worker<MatchingJobData>(
    deps.queueName ?? MATCHING_QUEUE_NAME,
    async (job) => {
      try {
        await runMatching(deps.db, { userId: job.data.userId, anthropicClient: deps.anthropicClient, env: deps.env });
      } catch (error) {
        if (error instanceof MatchingError && error.errorClass === "no_active_goal") {
          throw new UnrecoverableError(error.errorClass);
        }
        throw error;
      }
    },
    { connection: deps.connection, concurrency: 1 }
  );
}
