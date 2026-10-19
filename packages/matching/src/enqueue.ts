import type { Queue } from "bullmq";
import type IORedis from "ioredis";
import { MATCHING_JOB_NAME, MATCHING_JOB_OPTIONS, matchingJobId, type MatchingJobData } from "./queue";

export type PushResult = "enqueued" | "already_queued" | "running";

const WAITING_STATES = new Set(["waiting", "prioritized", "waiting-children"]);

/**
 * Phase 13a: the one place a matching run is put on the queue (web click, search-run coordinator, debounced
 * re-match). The fixed job id keeps at most one queued run per user. A user's click promotes a debounced (delayed)
 * run instead of waiting it out. "running" tells the caller a run is in progress and will not see later changes.
 */
export async function pushMatching(
  queue: Queue<MatchingJobData>, userId: string, opts: { delayMs?: number; promoteDelayed?: boolean } = {},
): Promise<PushResult> {
  const existing = await queue.getJob(matchingJobId(userId));
  if (existing) {
    const state = await existing.getState();
    if (state === "active") return "running";
    if (state === "delayed") {
      if (!opts.promoteDelayed) return "already_queued";
      try {
        await existing.promote();
        return "enqueued";
      } catch {
        // The debounce timer fired (and maybe a worker picked it up) between the state read and promote: the job
        // exists and will run, so report that instead of failing the caller.
        return (await existing.getState()) === "active" ? "running" : "already_queued";
      }
    }
    if (WAITING_STATES.has(state)) return "already_queued";
  }
  await queue.add(MATCHING_JOB_NAME, { userId }, {
    ...MATCHING_JOB_OPTIONS, jobId: matchingJobId(userId), ...(opts.delayMs ? { delay: opts.delayMs } : {}),
  });
  return "enqueued";
}

export const rematchFlagKey = (userId: string): string => `careerpilot:rematch:${userId}`;
const FLAG_TTL_SECONDS = 3600;

/**
 * New jobs arrived outside a search run (a schedule, a late source, a newly validated board). Queue a debounced run;
 * if one is already running it cannot see them, so leave a flag the matching worker reads when that run finishes.
 */
export async function requestRematch(
  deps: { redis: Pick<IORedis, "set">; queue: Queue<MatchingJobData> }, userId: string, debounceMs: number,
): Promise<PushResult> {
  const result = await pushMatching(deps.queue, userId, { delayMs: debounceMs });
  if (result === "running") await deps.redis.set(rematchFlagKey(userId), "1", "EX", FLAG_TTL_SECONDS);
  return result;
}

/** True once per flag: DEL is atomic, so two finishing runs never both take it. */
export async function takeRematchFlag(redis: Pick<IORedis, "del">, userId: string): Promise<boolean> {
  return (await redis.del(rematchFlagKey(userId))) === 1;
}
