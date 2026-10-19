import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { insertSource, openTestDb, wipeUser, type TestDb } from "@ai-career/ingestion/testing";
import { afterRunRematch, shouldRematch } from "./rematch";

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
