import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { openAdminDb, wipeJobData, insertSource } from "../../test/jobsDb";
import { listJobSourceViews } from "./serializeSource";

const USER = "00000000-0000-0000-0000-0000000000d1";
const appDb = createDbClient({
  DATABASE_URL:
    process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
});
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeJobData(admin, USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await admin.end();
  await closeDbClient(appDb);
});

const views = () => withUserContext(appDb, USER, (tx) => listJobSourceViews(tx));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

async function insertRun(
  sourceId: string,
  opts: { startedAt: string; status: "running" | "succeeded" | "failed"; fetched?: number; created?: number; complete?: boolean }
) {
  await admin`INSERT INTO ingestion_runs (user_id, source_id, started_at, status, complete, fetched_count, new_count)
              VALUES (${USER}, ${sourceId}, ${opts.startedAt}::timestamptz, ${opts.status}, ${opts.complete ?? false},
                      ${opts.fetched ?? 0}, ${opts.created ?? 0})`;
}

describe("listJobSourceViews — a run in flight", () => {
  it("reports 'running' with no counters while the latest run is running and recent", async () => {
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    await admin`UPDATE job_sources SET last_run_status = 'succeeded', last_run_at = ${minutesAgo(60 * 24)}::timestamptz WHERE id = ${id}`;
    await insertRun(id, { startedAt: minutesAgo(60 * 24), status: "succeeded", complete: true, fetched: 7, created: 2 });
    await insertRun(id, { startedAt: minutesAgo(1), status: "running" });

    const [view] = await views();
    expect(view.lastRunStatus).toBe("running");
    expect(view.lastRun).toBeNull();
  });

  it("treats a running row started 31 minutes ago as a crashed run: falls back to the last finished run", async () => {
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    await admin`UPDATE job_sources SET last_run_status = 'succeeded', last_run_at = ${minutesAgo(60 * 24)}::timestamptz WHERE id = ${id}`;
    await insertRun(id, { startedAt: minutesAgo(60 * 24), status: "succeeded", complete: true, fetched: 7, created: 2 });
    await insertRun(id, { startedAt: minutesAgo(31), status: "running" });

    const [view] = await views();
    expect(view.lastRunStatus).toBe("succeeded");
    expect(view.lastRun).toEqual({ complete: true, fetched: 7, created: 2, updated: 0, unchanged: 0, closed: 0, failed: 0 });
  });

  it("a stale running row with no finished run behind it shows the source's own last_run values and no counters", async () => {
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    await insertRun(id, { startedAt: minutesAgo(31), status: "running" });

    const [view] = await views();
    expect(view.lastRunStatus).toBeNull();
    expect(view.lastRun).toBeNull();
  });

  it("leaves a finished latest run unchanged", async () => {
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    await admin`UPDATE job_sources SET last_run_status = 'succeeded', last_run_at = ${minutesAgo(5)}::timestamptz WHERE id = ${id}`;
    await insertRun(id, { startedAt: minutesAgo(60), status: "failed", complete: false });
    await insertRun(id, { startedAt: minutesAgo(5), status: "succeeded", complete: true, fetched: 9, created: 3 });

    const [view] = await views();
    expect(view.lastRunStatus).toBe("succeeded");
    expect(view.lastRun).toEqual({ complete: true, fetched: 9, created: 3, updated: 0, unchanged: 0, closed: 0, failed: 0 });
  });

  it("a fresh running row older than the latest finished run is not in flight", async () => {
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    await admin`UPDATE job_sources SET last_run_status = 'succeeded', last_run_at = ${minutesAgo(1)}::timestamptz WHERE id = ${id}`;
    await insertRun(id, { startedAt: minutesAgo(10), status: "running" });
    await insertRun(id, { startedAt: minutesAgo(1), status: "succeeded", complete: true, fetched: 4 });

    const [view] = await views();
    expect(view.lastRunStatus).toBe("succeeded");
    expect(view.lastRun).toMatchObject({ fetched: 4 });
  });
});
