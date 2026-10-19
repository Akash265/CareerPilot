import type { Queue } from "bullmq";
import type IORedis from "ioredis";
import { pushMatching, takeRematchFlag, type MatchingJobData } from "@ai-career/matching";

/** Phase 13a: after a run finishes, one follow-up run if new jobs arrived while it ran (the re-match flag). */
export function createFollowUp(deps: { redis: Pick<IORedis, "del">; queue: Queue<MatchingJobData>; onError: (error: unknown) => void }) {
  return async (userId: string | undefined): Promise<void> => {
    if (!userId) return;
    try {
      if (await takeRematchFlag(deps.redis, userId)) await pushMatching(deps.queue, userId);
    } catch (error) {
      deps.onError(error);
    }
  };
}
