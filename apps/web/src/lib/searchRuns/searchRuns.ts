import { and, desc, eq, inArray, lt, or, isNull, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";

type SearchRunSeeding = schema.SearchRunSeeding;
type SearchRunSource = schema.SearchRunSource;
type SearchRunStatus = schema.SearchRunStatus;

const { careerGoals, discoverySettings, searchRuns } = schema;
export const STALL_AFTER_MS = 10 * 60_000;
const ACTIVE: SearchRunStatus[] = ["queued", "running", "matching"];

export interface SearchRunView {
  id: string;
  status: SearchRunStatus;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sources: SearchRunSource[];
  seeding: SearchRunSeeding;
}

const toView = (r: typeof searchRuns.$inferSelect): SearchRunView => ({
  id: r.id, status: r.status, errorCode: r.errorCode, createdAt: r.createdAt.toISOString(),
  startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null,
  sources: r.sources, seeding: r.seeding,
});

/** A run whose coordinator stopped beating (or never started) for 10 minutes is over: the next click starts fresh. */
export async function failStalled(tx: DbClient, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - STALL_AFTER_MS);
  await tx.update(searchRuns).set({ status: "failed", errorCode: "stalled", finishedAt: now })
    .where(and(
      inArray(searchRuns.status, ACTIVE),
      or(lt(searchRuns.heartbeatAt, cutoff), and(isNull(searchRuns.heartbeatAt), lt(searchRuns.createdAt, cutoff))),
    ));
}

export async function latestRun(tx: DbClient, now: Date): Promise<SearchRunView | null> {
  await failStalled(tx, now);
  const [row] = await tx.select().from(searchRuns).orderBy(desc(searchRuns.createdAt)).limit(1);
  return row ? toView(row) : null;
}

export type StartResult =
  | { kind: "consent_required" } | { kind: "no_active_goal" }
  | { kind: "existing"; run: SearchRunView } | { kind: "created"; run: SearchRunView };

export async function startRun(tx: DbClient, now: Date): Promise<StartResult> {
  // Serialize clicks for this user: the partial unique index would otherwise turn a double click into a 500.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('search_runs'), hashtext(current_setting('app.current_user_id')))`);
  const [settings] = await tx.select().from(discoverySettings).limit(1);
  if (!settings?.consentedAt) return { kind: "consent_required" };
  const [goal] = await tx.select({ id: careerGoals.id }).from(careerGoals)
    .where(and(eq(careerGoals.isActive, true), eq(careerGoals.confirmationStatus, "confirmed"))).limit(1);
  if (!goal) return { kind: "no_active_goal" };
  await failStalled(tx, now);
  const [active] = await tx.select().from(searchRuns).where(inArray(searchRuns.status, ACTIVE)).limit(1);
  if (active) return { kind: "existing", run: toView(active) };
  const [created] = await tx.insert(searchRuns).values({ createdAt: now }).returning();
  return { kind: "created", run: toView(created) };
}

export async function failQueued(tx: DbClient, runId: string, errorCode: string, now: Date): Promise<void> {
  await tx.update(searchRuns).set({ status: "failed", errorCode, finishedAt: now }).where(eq(searchRuns.id, runId));
}
