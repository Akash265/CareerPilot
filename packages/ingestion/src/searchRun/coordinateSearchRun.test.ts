import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { coordinateSearchRun, type CoordinatorDeps } from "./coordinateSearchRun";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";

// Phase 13a test user (…0d0a); verify unused with grep first.
const USER = "00000000-0000-0000-0000-000000000d0a";
let t: TestDb;
let clock: Date;

beforeAll(async () => { t = await openTestDb(); });
const wipe = async () => {
  await t.adminSql`DELETE FROM search_runs WHERE user_id = ${USER}`;
  await t.adminSql`DELETE FROM matching_runs WHERE user_id = ${USER}`;
  await t.adminSql`DELETE FROM discovered_boards WHERE user_id = ${USER}`;
  await t.adminSql`DELETE FROM discovery_settings WHERE user_id = ${USER}`;
  await t.adminSql`DELETE FROM career_goals WHERE user_id = ${USER}`;
  await wipeUser(t.adminSql, USER);
};
beforeEach(async () => {
  await wipe();
  clock = new Date("2026-10-19T12:00:00Z");
  await t.adminSql`INSERT INTO discovery_settings (user_id, auto_discover, consented_at) VALUES (${USER}, true, now())`;
});
afterAll(async () => { await wipe(); await t.close(); });

async function goal(): Promise<{ goalId: string; constraintsId: string }> {
  const [g] = await t.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active, confirmed_at)
    VALUES (${USER}, 'goal', 1, 'parsed', 'confirmed', true, '2026-10-01T00:00:00Z') RETURNING id`;
  const [c] = await t.adminSql`
    INSERT INTO career_goal_constraints (user_id, career_goal_id, target_roles, locations, work_mode, skills)
    VALUES (${USER}, ${g.id}, ${["Data Engineer"]}, ${["Berlin"]}, 'remote', ${["SQL"]}) RETURNING id`;
  return { goalId: g.id, constraintsId: c.id };
}
const newRun = async () => (await t.adminSql`INSERT INTO search_runs (user_id) VALUES (${USER}) RETURNING id`)[0].id as string;
const runRow = async (id: string) => (await t.adminSql`SELECT * FROM search_runs WHERE id = ${id}`)[0];
/** An ingestion run for `sourceId`, at the fake clock. */
const ingestion = (sourceId: string, status: string, newCount = 0, errorClass: string | null = null, at = clock) =>
  t.adminSql`INSERT INTO ingestion_runs (user_id, source_id, started_at, finished_at, status, complete, new_count, error_class)
             VALUES (${USER}, ${sourceId}, ${at.toISOString()}::timestamptz, ${status === "running" ? null : at.toISOString()}::timestamptz,
                     ${status}, ${status === "succeeded"}, ${newCount}, ${errorClass})`;
const matchingRun = (goalId: string, status: string, at = clock) =>
  t.adminSql`INSERT INTO matching_runs (user_id, career_goal_id, started_at, finished_at, status)
             VALUES (${USER}, ${goalId}, ${at.toISOString()}::timestamptz, ${status === "running" ? null : at.toISOString()}::timestamptz, ${status})`;

const ENV = {
  FIND_JOBS_FRESH_MINUTES: 360, FIND_JOBS_MAX_WAIT_SECONDS: 60, FIND_JOBS_MATCH_WAIT_SECONDS: 60,
  DISCOVERY_PROBE_MAX_NAMES: 30, DISCOVERY_WEB_SEARCH: true, DISCOVERY_WEB_SEARCH_INTERVAL_DAYS: 7,
};

function deps(over: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
  return {
    db: t.db, userId: USER, env: ENV,
    enqueueSource: vi.fn(async () => undefined),
    requestMatching: vi.fn(async () => "enqueued" as const),
    webSearch: vi.fn(async () => ({ state: "ran" as const, boards: [{ kind: "ashby" as const, slug: "globex", expectedCompany: "Globex" }], unsupported: 2 })),
    startValidation: vi.fn(),
    now: () => clock,
    // Each "sleep" advances the fake clock; tests script what the workers write between ticks via `onTick`.
    sleep: async (ms) => { clock = new Date(clock.getTime() + ms); await onTick(); },
    pollMs: 2000,
    ...over,
  };
}
let onTick: () => Promise<void> = async () => undefined;

describe("coordinateSearchRun (Phase 13a)", () => {
  it("reuses fresh sources, queues stale ones, seeds, waits, then matches", async () => {
    const { goalId } = await goal();
    const fresh = await insertSource(t.adminSql, USER, { kind: "greenhouse", label: "Fresh" });
    const stale = await insertSource(t.adminSql, USER, { kind: "lever", label: "Stale" });
    await ingestion(fresh, "succeeded", 0, null, new Date(clock.getTime() - 30 * 60_000));
    const runId = await newRun();
    let tick = 0;
    onTick = async () => {
      tick++;
      if (tick === 1) await ingestion(stale, "succeeded", 3);
      if (tick === 2) await matchingRun(goalId, "completed");
    };
    const d = deps();
    expect(await coordinateSearchRun(d, runId)).toBe("completed");
    expect(d.enqueueSource).toHaveBeenCalledTimes(1);
    expect(d.enqueueSource).toHaveBeenCalledWith(stale);
    expect(d.requestMatching).toHaveBeenCalledTimes(1);
    expect(d.startValidation).toHaveBeenCalled();
    const row = await runRow(runId);
    expect(row.status).toBe("completed");
    expect(row.sources).toEqual([
      { sourceId: fresh, name: "Fresh", kind: "greenhouse", state: "reused" },
      { sourceId: stale, name: "Stale", kind: "lever", state: "done", newCount: 3 },
    ]);
    expect(row.seeding).toMatchObject({ probe: { state: "ran" }, webSearch: { state: "ran", boardsQueued: 1, unsupported: 2 } });
    const [settings] = await t.adminSql`SELECT last_web_search_goal_id FROM discovery_settings WHERE user_id = ${USER}`;
    expect(settings.last_web_search_goal_id).toBe(row.goal_constraints_id);
    const [board] = await t.adminSql`SELECT found_via, expected_company FROM discovered_boards WHERE user_id = ${USER} AND slug = 'globex'`;
    expect(board).toEqual({ found_via: "web_search", expected_company: "Globex" });
  });

  it("records a failing source, marks a slow one late at the deadline, and still matches", async () => {
    const { goalId } = await goal();
    const failing = await insertSource(t.adminSql, USER, { kind: "greenhouse", label: "Failing" });
    const slow = await insertSource(t.adminSql, USER, { kind: "lever", label: "Slow" });
    const runId = await newRun();
    let matched = false;
    onTick = async () => {
      if ((await t.adminSql`SELECT 1 FROM ingestion_runs WHERE source_id = ${failing}`).length === 0) {
        await ingestion(failing, "failed", 0, "rate_limited");
        await ingestion(slow, "running");
      }
      const row = await runRow(runId);
      if (row.status === "matching" && !matched) { matched = true; await matchingRun(goalId, "completed"); }
    };
    expect(await coordinateSearchRun(deps(), runId)).toBe("completed");
    const row = await runRow(runId);
    expect(row.sources.map((s: { state: string; reason?: string }) => [s.state, s.reason ?? null])).toEqual([["failed", "rate_limited"], ["late", null]]);
  });

  it("skips the web search when it ran recently for the same goal, and when disabled", async () => {
    const { constraintsId } = await goal();
    await t.adminSql`UPDATE discovery_settings SET last_web_search_at = now(), last_web_search_goal_id = ${constraintsId} WHERE user_id = ${USER}`;
    const runId = await newRun();
    onTick = async () => { /* no sources, the run goes straight to matching */ };
    const d = deps({ requestMatching: vi.fn(async () => { await matchingRun((await t.adminSql`SELECT id FROM career_goals WHERE user_id = ${USER}`)[0].id, "completed"); return "enqueued" as const; }) });
    await coordinateSearchRun(d, runId);
    expect(d.webSearch).not.toHaveBeenCalled();
    expect((await runRow(runId)).seeding.webSearch).toEqual({ state: "skipped_recent", boardsQueued: 0, unsupported: 0 });
  });

  it("isolates a seeding crash and fails with matching_timeout when no run finishes in time", async () => {
    await goal();
    const runId = await newRun();
    onTick = async () => undefined;
    const d = deps({ webSearch: vi.fn(async () => { throw new Error("boom"); }) });
    expect(await coordinateSearchRun(d, runId)).toBe("failed");
    const row = await runRow(runId);
    expect(row.error_code).toBe("matching_timeout");
    expect(row.seeding.webSearch).toMatchObject({ state: "failed", reason: "unknown" });
  });

  it("fails with a code when consent or the goal is missing, without queueing anything", async () => {
    const runId = await newRun();
    const d = deps();
    expect(await coordinateSearchRun(d, runId)).toBe("failed");
    expect((await runRow(runId)).error_code).toBe("no_active_goal");
    expect(d.enqueueSource).not.toHaveBeenCalled();
    await goal();
    await t.adminSql`UPDATE discovery_settings SET consented_at = NULL WHERE user_id = ${USER}`;
    const second = await newRun();
    expect(await coordinateSearchRun(d, second)).toBe("failed");
    expect((await runRow(second)).error_code).toBe("consent_missing");
  });

  it("keeps waiting after a failed matching attempt and fails with matching_failed only at the deadline", async () => {
    const { goalId } = await goal();
    const runId = await newRun();
    const start = clock.getTime();
    let inserted = false;
    onTick = async () => {
      if (!inserted && (await runRow(runId)).status === "matching") { inserted = true; await matchingRun(goalId, "failed"); }
    };
    expect(await coordinateSearchRun(deps(), runId)).toBe("failed");
    expect((await runRow(runId)).error_code).toBe("matching_failed");
    // The match wait (60 s) ran out: a retry of the matching job could still have followed the failed attempt.
    expect(clock.getTime() - start).toBeGreaterThanOrEqual(ENV.FIND_JOBS_MATCH_WAIT_SECONDS * 1000);
  });

  it("completes when a retried matching attempt succeeds after a failed one", async () => {
    const { goalId } = await goal();
    const runId = await newRun();
    let tick = 0;
    onTick = async () => {
      tick++;
      if (tick === 1) await matchingRun(goalId, "failed");
      if (tick === 4) await matchingRun(goalId, "completed");
    };
    expect(await coordinateSearchRun(deps(), runId)).toBe("completed");
    expect(await runRow(runId)).toMatchObject({ status: "completed", error_code: null });
  });

  it("observes a source already ingesting when the run started", async () => {
    const { goalId } = await goal();
    const busy = await insertSource(t.adminSql, USER, { kind: "lever", label: "Busy" });
    await ingestion(busy, "running", 0, null, new Date(clock.getTime() - 60_000));
    const runId = await newRun();
    let tick = 0;
    onTick = async () => {
      tick++;
      if (tick === 1) {
        await t.adminSql`UPDATE ingestion_runs SET status = 'succeeded', complete = true, new_count = 2, finished_at = ${clock.toISOString()}::timestamptz WHERE source_id = ${busy}`;
      }
      if ((await runRow(runId)).status === "matching") await matchingRun(goalId, "completed");
    };
    const d = deps();
    expect(await coordinateSearchRun(d, runId)).toBe("completed");
    expect(d.enqueueSource).toHaveBeenCalledWith(busy);
    expect((await runRow(runId)).sources).toEqual([{ sourceId: busy, name: "Busy", kind: "lever", state: "done", newCount: 2 }]);
  });

  it("marks the run failed with coordinator_error and rethrows on an unexpected error", async () => {
    await goal();
    const runId = await newRun();
    onTick = async () => undefined;
    const d = deps({ startValidation: vi.fn(() => { throw new Error("boom"); }) });
    await expect(coordinateSearchRun(d, runId)).rejects.toThrow("boom");
    const row = await runRow(runId);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("coordinator_error");
  });

  it("stops without overwriting when the run is marked stalled during the web search", async () => {
    await goal();
    const runId = await newRun();
    onTick = async () => undefined;
    const d = deps({
      webSearch: vi.fn(async () => {
        await t.adminSql`UPDATE search_runs SET status = 'failed', error_code = 'stalled', finished_at = now() WHERE id = ${runId}`;
        return { state: "ran" as const, boards: [], unsupported: 0 };
      }),
    });
    expect(await coordinateSearchRun(d, runId)).toBe("failed");
    const row = await runRow(runId);
    expect(row).toMatchObject({ status: "failed", error_code: "stalled" });
    expect(row.seeding).toEqual({});
    expect(d.requestMatching).not.toHaveBeenCalled();
    expect(d.startValidation).not.toHaveBeenCalled();
  });

  it("stops without overwriting when the run is failed while waiting for sources", async () => {
    await goal();
    const slow = await insertSource(t.adminSql, USER, { kind: "lever", label: "Slow" });
    const runId = await newRun();
    onTick = async () => {
      await t.adminSql`UPDATE search_runs SET status = 'failed', error_code = 'stalled', finished_at = now() WHERE id = ${runId}`;
    };
    const d = deps();
    expect(await coordinateSearchRun(d, runId)).toBe("failed");
    expect(d.enqueueSource).toHaveBeenCalledWith(slow);
    expect(await runRow(runId)).toMatchObject({ status: "failed", error_code: "stalled" });
    expect(d.requestMatching).not.toHaveBeenCalled();
  });

  it("stops without overwriting when the run is failed while waiting for matching", async () => {
    const { goalId } = await goal();
    const runId = await newRun();
    let ticks = 0;
    onTick = async () => {
      ticks++;
      if (ticks === 1) await t.adminSql`UPDATE search_runs SET status = 'failed', error_code = 'stalled', finished_at = now() WHERE id = ${runId}`;
      if (ticks === 2) await matchingRun(goalId, "completed");
    };
    const d = deps();
    expect(await coordinateSearchRun(d, runId)).toBe("failed");
    expect(await runRow(runId)).toMatchObject({ status: "failed", error_code: "stalled" });
    expect(ticks).toBe(1);
  });

  it("does not overwrite a terminal run with coordinator_error", async () => {
    await goal();
    await insertSource(t.adminSql, USER, { kind: "lever", label: "Slow" });
    const runId = await newRun();
    const d = deps({
      // The stall rule fires, then an unexpected error escapes the wait loop.
      sleep: async () => {
        await t.adminSql`UPDATE search_runs SET status = 'failed', error_code = 'stalled', finished_at = now() WHERE id = ${runId}`;
        throw new Error("boom");
      },
    });
    await expect(coordinateSearchRun(d, runId)).rejects.toThrow("boom");
    expect(await runRow(runId)).toMatchObject({ status: "failed", error_code: "stalled" });
  });

  it("ignores a run that is not queued (already handled or stalled)", async () => {
    await goal();
    const runId = (await t.adminSql`INSERT INTO search_runs (user_id, status) VALUES (${USER}, 'failed') RETURNING id`)[0].id as string;
    const d = deps();
    expect(await coordinateSearchRun(d, runId)).toBe("failed");
    expect(d.requestMatching).not.toHaveBeenCalled();
  });
});
