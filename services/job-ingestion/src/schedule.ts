import { SCHEDULER_PREFIX, schedulerIdFor } from "@ai-career/ingestion";

export interface SchedulePlan {
  upsert: { schedulerId: string; sourceId: string }[];
  /** Scheduler ids to remove. */
  remove: string[];
}

/**
 * Decide what to change so BullMQ's repeatable schedulers match the database (the source of truth).
 * - `refresh: true` (boot) re-upserts every eligible scheduler so a changed interval takes effect;
 * - `refresh: false` (the periodic reconcile) only adds the missing ones, so an unchanged scheduler is
 *   never touched (and its next-run timer never reset);
 * - only schedulers this service created (by prefix) are ever removed.
 */
export function planSchedules(input: {
  eligibleSourceIds: string[];
  existingSchedulerIds: string[];
  refresh: boolean;
}): SchedulePlan {
  const wanted = new Set(input.eligibleSourceIds.map(schedulerIdFor));
  const existing = new Set(input.existingSchedulerIds);
  return {
    upsert: input.eligibleSourceIds
      .filter((sourceId) => input.refresh || !existing.has(schedulerIdFor(sourceId)))
      .map((sourceId) => ({ schedulerId: schedulerIdFor(sourceId), sourceId })),
    remove: input.existingSchedulerIds.filter((id) => id.startsWith(SCHEDULER_PREFIX) && !wanted.has(id)),
  };
}
