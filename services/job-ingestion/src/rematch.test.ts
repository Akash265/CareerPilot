import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { insertSource, openTestDb, wipeUser, type TestDb } from "@ai-career/ingestion/testing";
import { afterRunRematch, requestRematchSafely, shouldRematch } from "./rematch";

describe("shouldRematch (Phase 13a)", () => {
  const counts = { newCount: 0, updatedCount: 0, closedCount: 0 };
  it("re-matches when a run changed jobs and no search run is collecting results", () => {
    expect(shouldRematch({ counts: { ...counts, newCount: 2 }, activeSearchRun: false })).toBe(true);
    expect(shouldRematch({ counts: { ...counts, closedCount: 1 }, activeSearchRun: false })).toBe(true);
  });
  it("does not when nothing changed, the run is unknown, or a search run will match anyway", () => {
    expect(shouldRematch({ counts, activeSearchRun: false })).toBe(false);
    expect(shouldRematch({ counts: null, activeSearchRun: false })).toBe(false);
    expect(shouldRematch({ counts: { ...counts, newCount: 2 }, activeSearchRun: true })).toBe(false);
  });
});

const USER = "00000000-0000-0000-0000-000000000d0b";
let t: TestDb;
let sourceId: string;
const since = new Date(Date.now() - 60_000);

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.adminSql`DELETE FROM search_runs WHERE user_id = ${USER}`;
  await t.close();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
  await t.adminSql`DELETE FROM search_runs WHERE user_id = ${USER}`;
  sourceId = await insertSource(t.adminSql, USER);
});

const insertRun = (newCount: number, startedAt = new Date()) =>
  t.adminSql`INSERT INTO ingestion_runs (user_id, source_id, started_at, status, new_count)
             VALUES (${USER}, ${sourceId}, ${startedAt.toISOString()}::timestamptz, 'succeeded', ${newCount})`;
const insertSearchRun = (status: string) => t.adminSql`INSERT INTO search_runs (user_id, status) VALUES (${USER}, ${status})`;

describe("afterRunRematch (Phase 13a)", () => {
  it("is true for a run that changed jobs with no search run", async () => {
    await insertRun(3);
    expect(await afterRunRematch(t.db, USER, sourceId, since)).toBe(true);
  });
  it("is false when there is no run since the cutoff or nothing changed", async () => {
    await insertRun(3, new Date(Date.now() - 3_600_000));
    expect(await afterRunRematch(t.db, USER, sourceId, since)).toBe(false);
    await insertRun(0);
    expect(await afterRunRematch(t.db, USER, sourceId, since)).toBe(false);
  });
  it("is suppressed by a queued or running search run", async () => {
    await insertRun(3);
    await insertSearchRun("running");
    expect(await afterRunRematch(t.db, USER, sourceId, since)).toBe(false);
  });
  it("is NOT suppressed by a search run already matching (late sources must still be ranked)", async () => {
    await insertRun(3);
    await insertSearchRun("matching");
    expect(await afterRunRematch(t.db, USER, sourceId, since)).toBe(true);
  });
});

describe("requestRematchSafely (Phase 13a, R8)", () => {
  const mkLog = () => ({ info: vi.fn(), error: vi.fn() });
  it("logs rematch_failed and resolves when the re-match rejects", async () => {
    const log = mkLog();
    await expect(requestRematchSafely(async () => true, async () => { throw new Error("redis down"); }, log, "s1")).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith("rematch_failed", expect.objectContaining({ sourceId: "s1" }));
  });
  it("logs rematch_failed and resolves when the check rejects", async () => {
    const log = mkLog();
    await expect(requestRematchSafely(async () => { throw new Error("db down"); }, async () => "enqueued", log, "s1")).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
  it("logs rematch_requested on success and nothing when no re-match is needed", async () => {
    const log = mkLog();
    await requestRematchSafely(async () => true, async () => "enqueued", log, "s1");
    expect(log.info).toHaveBeenCalledWith("rematch_requested", { sourceId: "s1", result: "enqueued" });
    const quiet = mkLog();
    await requestRematchSafely(async () => false, async () => "enqueued", quiet, "s1");
    expect(quiet.info).not.toHaveBeenCalled();
  });
});
