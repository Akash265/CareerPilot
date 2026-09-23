export const MATCHING_QUEUE_NAME = "matching";
export const MATCHING_JOB_NAME = "run-matching";

export interface MatchingJobData {
  userId: string;
}

/** A fixed job id per user makes BullMQ ignore a second "Find Matches" click while one run is queued or active. */
export const matchingJobId = (userId: string): string => `matching-${userId}`;

/**
 * Only 2 attempts (vs. ingestion's 3): a retry re-runs the whole pipeline, and every explanation
 * call it repeats is a billed LLM request, not just an idempotent DB write. `upsertMatchRow` and the
 * explanation-staleness check together mean a retry mostly re-uses what the first attempt already
 * wrote, but that "mostly" is why this stays low rather than zero.
 */
export const MATCHING_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: "exponential" as const, delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
};
