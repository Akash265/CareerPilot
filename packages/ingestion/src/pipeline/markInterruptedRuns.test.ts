import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, insertSource, type TestDb } from "../testing";
import { markInterruptedRuns } from "./markInterruptedRuns";

const USER = "00000000-0000-0000-0000-000000000d30";
const OTHER = "00000000-0000-0000-0000-000000000d32";
let t: TestDb;

async function wipe() {
  for (const u of [USER, OTHER]) {
    await t.adminSql`DELETE FROM search_runs WHERE user_id = ${u}`;
    await wipeUser(t.adminSql, u); // job_sources cascade to ingestion_runs
  }
}
beforeAll(async () => { t = await openTestDb(); });
beforeEach(wipe);
afterAll(async () => { await wipe(); await t.close(); });

const run = async (user: string, sourceId: string, status: string, startedAt: string) => {
  const [r] = await t.adminSql`INSERT INTO ingestion_runs (user_id, source_id, started_at, status, finished_at)
    VALUES (${user}, ${sourceId}, ${startedAt}, ${status}, ${status === "running" ? null : startedAt}) RETURNING id`;
  return r.id as string;
};
const searchRun = async (user: string, status: string) => {
  const [r] = await t.adminSql`INSERT INTO search_runs (user_id, status) VALUES (${user}, ${status}) RETURNING id`;
  return r.id as string;
};

describe("markInterruptedRuns", () => {
  it("fails ingestion runs left running, with reason interrupted, and leaves finished ones alone", async () => {
    const source = await insertSource(t.adminSql, USER);
    const stuck = await run(USER, source, "running", "2026-10-26T08:00:00Z");
    const done = await run(USER, source, "succeeded", "2026-10-26T07:00:00Z");
    const now = new Date("2026-10-26T09:00:00Z");

    const counts = await markInterruptedRuns(t.db, USER, now);

    expect(counts.ingestionRuns).toBe(1);
    const rows = await t.adminSql`SELECT id, status, error_class, finished_at FROM ingestion_runs WHERE user_id = ${USER}`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[stuck]).toMatchObject({ status: "failed", error_class: "interrupted" });
    expect(new Date(byId[stuck].finished_at).toISOString()).toBe(now.toISOString());
    expect(byId[done]).toMatchObject({ status: "succeeded", error_class: null });
  });

  it("records the interruption on the source, unless the source has a newer result", async () => {
    const stale = await insertSource(t.adminSql, USER, { label: "Stale" });
    const newer = await insertSource(t.adminSql, USER, { label: "Newer" });
    await run(USER, stale, "running", "2026-10-26T08:00:00Z");
    await run(USER, newer, "running", "2026-10-26T08:00:00Z");
    // "Newer" already finished a later run (its summary is from after the stuck run started).
    await t.adminSql`UPDATE job_sources SET last_run_at = '2026-10-26T08:30:00Z', last_run_status = 'succeeded', last_error_class = NULL WHERE id = ${newer}`;
    const now = new Date("2026-10-26T09:00:00Z");

    await markInterruptedRuns(t.db, USER, now);

    const sources = await t.adminSql`SELECT id, last_run_status, last_error_class, last_run_at FROM job_sources WHERE user_id = ${USER}`;
    const byId = Object.fromEntries(sources.map((s) => [s.id, s]));
    expect(byId[stale]).toMatchObject({ last_run_status: "failed", last_error_class: "interrupted" });
    expect(new Date(byId[stale].last_run_at).toISOString()).toBe(now.toISOString());
    expect(byId[newer]).toMatchObject({ last_run_status: "succeeded", last_error_class: null });
  });

  // Only one active search run per user can exist (search_runs_user_active_uniq), so each case seeds one.
  it.each(["running", "matching"])("fails a search run cut off while %s, which frees the next click", async (status) => {
    const id = await searchRun(USER, status);
    const completed = await searchRun(USER, "completed");

    const counts = await markInterruptedRuns(t.db, USER, new Date("2026-10-26T09:00:00Z"));

    expect(counts.searchRuns).toBe(1);
    const [row] = await t.adminSql`SELECT status, error_code, finished_at FROM search_runs WHERE id = ${id}`;
    expect(row).toMatchObject({ status: "failed", error_code: "interrupted" });
    expect(row.finished_at).not.toBeNull();
    const [done] = await t.adminSql`SELECT status FROM search_runs WHERE id = ${completed}`;
    expect(done.status).toBe("completed");
    await expect(searchRun(USER, "queued")).resolves.toBeTruthy(); // a new run can start immediately
  });

  it("marks the cut-off run's unfinished sources interrupted, keeping finished ones as they were", async () => {
    const sources = [
      { sourceId: "a", name: "A", kind: "remotive", state: "running" },
      { sourceId: "b", name: "B", kind: "greenhouse", state: "queued" },
      { sourceId: "c", name: "C", kind: "lever", state: "late" },
      { sourceId: "d", name: "D", kind: "ashby", state: "done", newCount: 3 },
      { sourceId: "e", name: "E", kind: "ashby", state: "reused" },
      { sourceId: "f", name: "F", kind: "ashby", state: "failed", reason: "not_found" },
    ];
    const [r] = await t.adminSql`INSERT INTO search_runs (user_id, status, sources) VALUES (${USER}, 'running', ${JSON.stringify(sources)}::jsonb) RETURNING id`;

    await markInterruptedRuns(t.db, USER, new Date("2026-10-26T09:00:00Z"));

    const [row] = await t.adminSql`SELECT sources FROM search_runs WHERE id = ${r.id}`;
    expect(row.sources).toEqual([
      { sourceId: "a", name: "A", kind: "remotive", state: "failed", reason: "interrupted" },
      { sourceId: "b", name: "B", kind: "greenhouse", state: "failed", reason: "interrupted" },
      { sourceId: "c", name: "C", kind: "lever", state: "failed", reason: "interrupted" },
      { sourceId: "d", name: "D", kind: "ashby", state: "done", newCount: 3 },
      { sourceId: "e", name: "E", kind: "ashby", state: "reused" },
      { sourceId: "f", name: "F", kind: "ashby", state: "failed", reason: "not_found" },
    ]);
  });

  it("keeps a queued search run for the worker to pick up", async () => {
    const id = await searchRun(USER, "queued");
    const counts = await markInterruptedRuns(t.db, USER, new Date("2026-10-26T09:00:00Z"));
    expect(counts.searchRuns).toBe(0);
    const [row] = await t.adminSql`SELECT status, error_code FROM search_runs WHERE id = ${id}`;
    expect(row).toMatchObject({ status: "queued", error_code: null });
  });

  it("touches only the given user's rows", async () => {
    const mine = await insertSource(t.adminSql, USER);
    const theirs = await insertSource(t.adminSql, OTHER);
    await run(USER, mine, "running", "2026-10-26T08:00:00Z");
    const otherRun = await run(OTHER, theirs, "running", "2026-10-26T08:00:00Z");
    const otherSearch = await searchRun(OTHER, "running");

    await markInterruptedRuns(t.db, USER, new Date("2026-10-26T09:00:00Z"));

    const [r] = await t.adminSql`SELECT status FROM ingestion_runs WHERE id = ${otherRun}`;
    const [s] = await t.adminSql`SELECT status FROM search_runs WHERE id = ${otherSearch}`;
    expect(r.status).toBe("running");
    expect(s.status).toBe("running");
  });

  it("does nothing when no run was interrupted", async () => {
    expect(await markInterruptedRuns(t.db, USER, new Date())).toEqual({ ingestionRuns: 0, searchRuns: 0 });
  });
});
