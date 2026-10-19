export const SEARCH_RUN_QUEUE_NAME = "search-runs";
export const SEARCH_RUN_JOB_NAME = "coordinate-search-run";

export interface SearchRunJobData {
  runId: string;
}

/** One attempt: a crashed coordinator leaves the run to the 10-minute stall rule, and the user's next click. */
export const SEARCH_RUN_JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: true };
