import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { Queue } from "bullmq";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { INGEST_JOB_NAME, INGEST_JOB_OPTIONS, type IngestJobData } from "@ai-career/ingestion";
import { planSchedules, type SchedulePlan } from "./schedule";

const { jobSources } = schema;

export interface ReconcileDeps {
  db: DbClient;
  userId: string;
  queue: Queue<IngestJobData>;
  everyMs: number;
  refresh: boolean;
}

/**
 * Make BullMQ's repeatable schedulers match the database: one per enabled, consented, non-upload
 * source. Uploads are one-shot (processed when uploaded), so they are never scheduled.
 */
export async function reconcileSchedules(deps: ReconcileDeps): Promise<SchedulePlan> {
  const eligible = await withUserContext(deps.db, deps.userId, (tx) =>
    tx
      .select({ id: jobSources.id })
      .from(jobSources)
      .where(and(eq(jobSources.enabled, true), isNotNull(jobSources.consentConfirmedAt), ne(jobSources.kind, "upload")))
  );
  const schedulers = await deps.queue.getJobSchedulers();

  const plan = planSchedules({
    eligibleSourceIds: eligible.map((row) => row.id),
    existingSchedulerIds: schedulers.map((s) => s.id ?? s.key),
    refresh: deps.refresh,
  });

  for (const { schedulerId, sourceId } of plan.upsert) {
    await deps.queue.upsertJobScheduler(
      schedulerId,
      { every: deps.everyMs },
      { name: INGEST_JOB_NAME, data: { sourceId }, opts: INGEST_JOB_OPTIONS }
    );
  }
  for (const schedulerId of plan.remove) await deps.queue.removeJobScheduler(schedulerId);
  return plan;
}
