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
export const REMATCH_FLAG_TTL_SECONDS = 3600;

export interface RematchFlagDeps {
  redis: Pick<IORedis, "set" | "del">;
  queue: Queue<MatchingJobData>;
}

/**
 * A run in progress cannot see newer jobs, so for a `running` result leave a flag the matching worker takes when
 * that run finishes. The run may have finished (and its job been removed) between pushMatching's state read and the
 * flag write, leaving the flag for no one: re-check the job, and if it is gone take the flag back and queue a run now.
 * Taking the flag is atomic, so this and the worker's follow-up never both queue.
 */
export async function flagRematchIfRunning(deps: RematchFlagDeps, userId: string, result: PushResult): Promise<PushResult> {
  if (result !== "running") return result;
  await deps.redis.set(rematchFlagKey(userId), "1", "EX", REMATCH_FLAG_TTL_SECONDS);
  if (await deps.queue.getJob(matchingJobId(userId))) return result;
  if (await takeRematchFlag(deps.redis, userId)) return pushMatching(deps.queue, userId);
  return result;
}

/**
 * New jobs arrived outside a search run (a schedule, a late source, a newly validated board). Queue a debounced run;
 * if one is already running it cannot see them, so leave a flag the matching worker reads when that run finishes.
 */
export async function requestRematch(deps: RematchFlagDeps, userId: string, debounceMs: number): Promise<PushResult> {
  return flagRematchIfRunning(deps, userId, await pushMatching(deps.queue, userId, { delayMs: debounceMs }));
}

/** True once per flag: DEL is atomic, so two finishing runs never both take it. */
export async function takeRematchFlag(redis: Pick<IORedis, "del">, userId: string): Promise<boolean> {
  return (await redis.del(rematchFlagKey(userId))) === 1;
}
