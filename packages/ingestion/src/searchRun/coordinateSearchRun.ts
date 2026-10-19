import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { insertPendingBoards } from "../discovery/discover";
import { allSourcesSettled, applyRunUpdates, markLate, planSourceRefresh, webSearchDue, type IngestionRunUpdate } from "./plan";
import { probeEmployerNames } from "./probeEmployerNames";
import type { GoalSearchInput, WebSearchBoardsResult } from "./webSearchBoards";

type SearchRunSeeding = schema.SearchRunSeeding;
type SearchRunStatus = schema.SearchRunStatus;

const { careerGoalConstraints, careerGoals, discoverySettings, ingestionRuns, jobSources, matchingRuns, searchRuns } = schema;

export interface CoordinatorDeps {
  db: DbClient;
  userId: string;
  /** Puts one source on the ingest queue (deduped by its fixed job id; an already-queued source is fine). */
  enqueueSource(sourceId: string): Promise<void>;
  requestMatching(): Promise<"enqueued" | "already_queued" | "running">;
  webSearch(goal: GoalSearchInput): Promise<WebSearchBoardsResult>;
  /** Starts a validation pass in the background (the worker's single-flight validateBoards). */
  startValidation(): void;
  env: {
    FIND_JOBS_FRESH_MINUTES: number; FIND_JOBS_MAX_WAIT_SECONDS: number; FIND_JOBS_MATCH_WAIT_SECONDS: number;
    DISCOVERY_PROBE_MAX_NAMES: number; DISCOVERY_WEB_SEARCH: boolean; DISCOVERY_WEB_SEARCH_INTERVAL_DAYS: number;
  };
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The coordinator only writes a run it still owns: one that is `running` or `matching`. */
const OWNED: SearchRunStatus[] = ["running", "matching"];

/** Thrown when a guarded write finds the run no longer owned (stalled, failed by the web side, or finished). */
class RunNoLongerOwned extends Error {}

/**
 * Phase 13a: drives one "Find matching jobs" run (spec §3.3). Sources and seeding never fail the run; each failure
 * is recorded as a fixed code. Matching is requested once the sources settle or the deadline passes.
 */
export async function coordinateSearchRun(deps: CoordinatorDeps, runId: string): Promise<SearchRunStatus> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 2000;
  const inUser = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(deps.db, deps.userId, fn);
  /** Writes the run only while it is still owned; returns the number of rows updated (0 or 1). */
  const guardedUpdate = async (set: Partial<typeof searchRuns.$inferInsert>): Promise<number> =>
    (await inUser((tx) => tx.update(searchRuns).set({ heartbeatAt: now(), ...set })
      .where(and(eq(searchRuns.id, runId), inArray(searchRuns.status, OWNED))).returning({ id: searchRuns.id }))).length;
  // A write that finds the run no longer owned (e.g. the web side marked it `stalled`) stops the run: nothing more
  // is written and matching is not requested.
  const update = async (set: Partial<typeof searchRuns.$inferInsert>): Promise<void> => {
    if ((await guardedUpdate(set)) === 0) throw new RunNoLongerOwned();
  };
  const currentStatus = async (): Promise<SearchRunStatus> => {
    const [row] = await inUser((tx) => tx.select({ status: searchRuns.status }).from(searchRuns).where(eq(searchRuns.id, runId)));
    return row?.status ?? "failed";
  };
  const fail = async (errorCode: string): Promise<SearchRunStatus> => {
    await update({ status: "failed", errorCode, finishedAt: now() });
    return "failed";
  };

  // 1. Claim the run (only a queued one) and re-check consent and goal.
  const startedAt = now();
  const claimed = await inUser((tx) =>
    tx.update(searchRuns).set({ status: "running", startedAt, heartbeatAt: startedAt })
      .where(and(eq(searchRuns.id, runId), eq(searchRuns.status, "queued"))).returning({ id: searchRuns.id }));
  if (claimed.length === 0) return currentStatus();
  try {
  const context = await inUser(async (tx) => {
    const [settings] = await tx.select().from(discoverySettings).limit(1);
    const [goal] = await tx
      .select({
        constraintsId: careerGoalConstraints.id, confirmedAt: careerGoals.confirmedAt, roles: careerGoalConstraints.targetRoles,
        locations: careerGoalConstraints.locations, workMode: careerGoalConstraints.workMode, skills: careerGoalConstraints.skills,
      })
      .from(careerGoals)
      .innerJoin(careerGoalConstraints, eq(careerGoalConstraints.careerGoalId, careerGoals.id))
      .where(and(eq(careerGoals.isActive, true), eq(careerGoals.confirmationStatus, "confirmed")))
      .limit(1);
    return { settings, goal };
  });
  if (!context.goal) return fail("no_active_goal");
  if (!context.settings?.consentedAt) return fail("consent_missing");
  const { goal, settings } = context;
  const deadlineAt = new Date(startedAt.getTime() + deps.env.FIND_JOBS_MAX_WAIT_SECONDS * 1000);
  await update({ goalConstraintsId: goal.constraintsId, deadlineAt });

  // 2. Plan sources: reuse fresh ones, queue the rest.
  let sources = await inUser(async (tx) => {
    const rows = await tx
      .select({
        sourceId: jobSources.id, name: jobSources.label, kind: jobSources.kind,
        // Columns are written out: Drizzle drops the table qualifier inside a single-table select, which would turn
        // the correlation into `source_id = id` on the inner table.
        lastSuccessAt: sql<Date | null>`(SELECT max(ir.finished_at) FROM ingestion_runs ir
          WHERE ir.source_id = job_sources.id AND ir.status = 'succeeded')`.mapWith((v) => (v ? new Date(v) : null)),
      })
      .from(jobSources)
      .where(and(eq(jobSources.enabled, true), isNotNull(jobSources.consentConfirmedAt), ne(jobSources.kind, "upload")))
      .orderBy(jobSources.createdAt);
    return planSourceRefresh({ sources: rows, now: startedAt, freshMinutes: deps.env.FIND_JOBS_FRESH_MINUTES, goalConfirmedAt: goal.confirmedAt });
  });
  for (const s of sources) {
    if (s.state !== "queued") continue;
    try {
      await deps.enqueueSource(s.sourceId);
    } catch {
      sources = sources.map((x) => (x.sourceId === s.sourceId ? { ...x, state: "failed", reason: "queue_unavailable" } : x));
    }
  }
  await update({ sources });

  // 3. Seed: name probing, then the web search when due. Each step is isolated.
  const seeding: SearchRunSeeding = {};
  try {
    const probe = await inUser((tx) => probeEmployerNames(tx, { goalId: goal.constraintsId, now: now(), maxNames: deps.env.DISCOVERY_PROBE_MAX_NAMES }));
    seeding.probe = { state: "ran", ...probe };
  } catch {
    seeding.probe = { state: "failed", names: 0, boardsQueued: 0, reason: "unknown" };
  }
  const due = settings.autoDiscover
    ? webSearchDue({
      enabled: deps.env.DISCOVERY_WEB_SEARCH, lastAt: settings.lastWebSearchAt, lastGoalId: settings.lastWebSearchGoalId,
      goalId: goal.constraintsId, now: now(), intervalDays: deps.env.DISCOVERY_WEB_SEARCH_INTERVAL_DAYS,
    })
    : "skipped_disabled";
  if (due === "due") {
    try {
      const found = await deps.webSearch({ roles: goal.roles, locations: goal.locations, remote: goal.workMode === "remote", skills: goal.skills });
      const boardsQueued = found.boards.length ? await inUser((tx) => insertPendingBoards(tx, found.boards, { foundVia: "web_search" })) : 0;
      seeding.webSearch = { state: found.state, boardsQueued, unsupported: found.unsupported, ...(found.reason ? { reason: found.reason } : {}) };
      if (found.state === "ran") {
        await inUser((tx) => tx.update(discoverySettings).set({ lastWebSearchAt: now(), lastWebSearchGoalId: goal.constraintsId }));
      }
    } catch {
      seeding.webSearch = { state: "failed", boardsQueued: 0, unsupported: 0, reason: "unknown" };
    }
  } else {
    seeding.webSearch = { state: due, boardsQueued: 0, unsupported: 0 };
  }
  await update({ seeding });
  deps.startValidation();

  // 4. Wait for queued sources, or the deadline.
  const queuedIds = sources.filter((s) => s.state === "queued").map((s) => s.sourceId);
  const readRuns = () => inUser((tx) =>
    tx.selectDistinctOn([ingestionRuns.sourceId], {
      sourceId: ingestionRuns.sourceId, status: ingestionRuns.status, newCount: ingestionRuns.newCount, errorClass: ingestionRuns.errorClass,
    })
      .from(ingestionRuns)
      // Also a run already in flight (enqueue dedupes on the job id, so it started before this search run).
      .where(and(
        inArray(ingestionRuns.sourceId, queuedIds),
        or(gte(ingestionRuns.startedAt, startedAt), isNull(ingestionRuns.finishedAt), gte(ingestionRuns.finishedAt, startedAt)),
      ))
      .orderBy(ingestionRuns.sourceId, desc(ingestionRuns.startedAt)));
  while (queuedIds.length > 0 && !allSourcesSettled(sources)) {
    if (now() >= deadlineAt) {
      sources = markLate(sources);
      break;
    }
    await sleep(pollMs);
    sources = applyRunUpdates(sources, (await readRuns()) as IngestionRunUpdate[]);
    await update({ sources });
  }
  await update({ sources });

  // 5. Match, and wait for a matching run that started after this request.
  const matchRequestedAt = now();
  await update({ status: "matching" });
  try {
    await deps.requestMatching();
  } catch {
    return fail("queue_unavailable");
  }
  const matchDeadline = matchRequestedAt.getTime() + deps.env.FIND_JOBS_MATCH_WAIT_SECONDS * 1000;
  while (now().getTime() < matchDeadline) {
    await sleep(pollMs);
    const [run] = await inUser((tx) =>
      tx.select({ status: matchingRuns.status }).from(matchingRuns)
        .where(gte(matchingRuns.startedAt, matchRequestedAt)).orderBy(desc(matchingRuns.startedAt)).limit(1));
    await update({});
    if (run?.status === "completed") {
      await update({ status: "completed", finishedAt: now() });
      return "completed";
    }
    if (run?.status === "failed") return fail("matching_failed");
  }
  return fail("matching_timeout");
  } catch (err) {
    if (err instanceof RunNoLongerOwned) return currentStatus();
    // Unexpected (DB) error: leave the row terminal rather than for the 10-minute stall rule, then surface it.
    // Guarded too: a run that is already terminal keeps its status and code.
    try { await guardedUpdate({ status: "failed", errorCode: "coordinator_error", finishedAt: now() }); } catch { /* best effort */ }
    throw err;
  }
}
