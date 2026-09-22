import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { withUserContext } from "@ai-career/db";
import { runIngestion, type RunSummary } from "./runIngestion";
import { createAdapterFor } from "./adapterFor";
import { storeUpload } from "./storeUpload";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";
import { greenhouseJobFixture } from "../fixtures";
import { IngestError, type RawRecord, type SourceAdapter } from "../types";

const USER = "00000000-0000-0000-0000-0000000000a2";
const OTHER_USER = "00000000-0000-0000-0000-0000000000e2";
const TITLES: Record<number, string> = { 1: "Data Engineer", 2: "Product Designer", 3: "Security Analyst" };
let t: TestDb;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 8, 21, 10, 0, tick++));

beforeAll(async () => {
  t = await openTestDb();
});
beforeEach(async () => {
  tick = 0;
  await wipeUser(t.adminSql, USER);
  await wipeUser(t.adminSql, OTHER_USER);
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await wipeUser(t.adminSql, OTHER_USER);
  await t.close();
});

const rec = (id: number): RawRecord => ({ externalId: String(id), payload: { ...greenhouseJobFixture, id, title: TITLES[id] } });
async function* yielding(list: RawRecord[]) {
  for (const r of list) yield r;
}
const adapterFor = (fetch: () => AsyncIterable<RawRecord>) => vi.fn((): SourceAdapter => ({ fetch }));
const run = (sourceId: string, factory: ReturnType<typeof adapterFor>) =>
  runIngestion(t.db, { userId: USER, sourceId, adapterFor: factory, now: clock });
const ok = (sourceId: string, ...ids: number[]) => run(sourceId, adapterFor(() => yielding(ids.map(rec))));
const statuses = async () =>
  Object.fromEntries((await t.adminSql`SELECT title, status FROM jobs WHERE user_id = ${USER}`).map((r) => [r.title, r.status]));
const lastRun = async (sourceId: string) =>
  (await t.adminSql`SELECT * FROM ingestion_runs WHERE source_id = ${sourceId} ORDER BY started_at DESC LIMIT 1`)[0];
const sourceRow = async (sourceId: string) => (await t.adminSql`SELECT * FROM job_sources WHERE id = ${sourceId}`)[0];
const failureOf = async (p: Promise<RunSummary>) => {
  try {
    await p;
  } catch (e) {
    return e as IngestError;
  }
  throw new Error("expected the run to fail");
};

describe("runIngestion — a normal board", () => {
  it("ingests every record and records the run and the source's status", async () => {
    const source = await insertSource(t.adminSql, USER);
    const summary = await ok(source, 1, 2, 3);
    expect(summary).toMatchObject({ status: "succeeded", complete: true, fetched: 3, created: 3, updated: 0, unchanged: 0, closed: 0, failed: 0, errorClass: null });

    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open", "Security Analyst": "open" });
    const [job] = await t.adminSql`SELECT salary_min, salary_currency, salary_is_parsed FROM jobs WHERE user_id = ${USER} AND title = 'Data Engineer'`;
    expect(Number(job.salary_min)).toBe(150000);
    expect(job).toMatchObject({ salary_currency: "USD", salary_is_parsed: true });
    expect((await t.adminSql`SELECT count(*)::int AS n FROM raw_job_postings WHERE source_id = ${source}`)[0].n).toBe(3);

    expect(await lastRun(source)).toMatchObject({ status: "succeeded", complete: true, fetched_count: 3, new_count: 3, error_class: null });
    expect(await sourceRow(source)).toMatchObject({ last_run_status: "succeeded", last_error_class: null });
  });

  it("a second identical run changes nothing", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2, 3);
    expect(await ok(source, 1, 2, 3)).toMatchObject({ created: 0, updated: 0, unchanged: 3, closed: 0, complete: true });
  });

  it("closes jobs that disappear from a complete fetch", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2, 3);
    expect(await ok(source, 1, 2)).toMatchObject({ closed: 1, complete: true });
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open", "Security Analyst": "closed" });
  });
});

describe("runIngestion — safety", () => {
  it("a fetch that fails midway closes nothing and records only the error class", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2, 3);
    async function* dies() {
      yield rec(1);
      throw new IngestError("server_error");
    }
    const error = await failureOf(run(source, adapterFor(dies)));
    expect(error).toBeInstanceOf(IngestError);
    expect(error).toMatchObject({ errorClass: "server_error", retryable: true });

    expect(await lastRun(source)).toMatchObject({ status: "failed", complete: false, error_class: "server_error", fetched_count: 1 });
    expect(await sourceRow(source)).toMatchObject({ last_run_status: "failed", last_error_class: "server_error" });
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open", "Security Analyst": "open" });
  });

  it("an empty fetch is incomplete, so it cannot mass-close a board", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2);
    const summary = await ok(source);
    expect(summary).toMatchObject({ status: "succeeded", complete: false, fetched: 0, closed: 0, errorClass: "empty_result" });
    expect(await sourceRow(source)).toMatchObject({ last_error_class: "empty_result" });
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open" });
  });

  it("a record that cannot be normalized is counted and skipped, and its tracked posting stays open", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2);
    const broken: RawRecord = { externalId: "2", payload: { id: 2 } }; // no title
    const summary = await run(source, adapterFor(() => yielding([rec(1), broken])));
    expect(summary).toMatchObject({ fetched: 2, unchanged: 1, failed: 1, closed: 0, complete: true });
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open" });
  });

  it("a record with an over-long external id is counted and skipped before anything is stored, on every run", async () => {
    const source = await insertSource(t.adminSql, USER);
    const longId = randomBytes(1500).toString("hex"); // 3000 incompressible chars: over the ~2.7KB btree index-row limit on raw_job_postings(source_id, external_id)
    const tooLong: RawRecord = { externalId: longId, payload: { ...greenhouseJobFixture, id: 2, title: TITLES[2] } };
    const adapter = adapterFor(() => yielding([rec(1), tooLong]));

    expect(await run(source, adapter)).toMatchObject({ status: "succeeded", complete: true, fetched: 2, created: 1, failed: 1, errorClass: null });
    expect(await statuses()).toEqual({ "Data Engineer": "open" });
    expect((await t.adminSql`SELECT count(*)::int AS n FROM raw_job_postings WHERE source_id = ${source}`)[0].n).toBe(1);
    expect((await t.adminSql`SELECT count(*)::int AS n FROM raw_job_postings WHERE source_id = ${source} AND length(external_id) > 200`)[0].n).toBe(0);
    expect(await sourceRow(source)).toMatchObject({ last_run_status: "succeeded", last_error_class: null });

    // Not bricked: the same input behaves the same on the next run.
    expect(await run(source, adapter)).toMatchObject({ status: "succeeded", complete: true, fetched: 2, unchanged: 1, failed: 1 });
    expect((await t.adminSql`SELECT count(*)::int AS n FROM raw_job_postings WHERE source_id = ${source}`)[0].n).toBe(1);
  });

  it("a record with a NUL byte in its payload is counted and skipped before anything is stored, on every run", async () => {
    const source = await insertSource(t.adminSql, USER);
    const bad: RawRecord = { externalId: "2", payload: { ...greenhouseJobFixture, id: 2, title: "Data\u0000Engineer" } };
    const adapter = adapterFor(() => yielding([rec(1), bad]));

    expect(await run(source, adapter)).toMatchObject({ status: "succeeded", complete: true, fetched: 2, created: 1, failed: 1, errorClass: null });
    expect(await statuses()).toEqual({ "Data Engineer": "open" });
    expect((await t.adminSql`SELECT count(*)::int AS n FROM raw_job_postings WHERE source_id = ${source} AND external_id = '2'`)[0].n).toBe(0);
    expect(await sourceRow(source)).toMatchObject({ last_run_status: "succeeded", last_error_class: null });

    // Not bricked: the same input behaves the same on the next run.
    expect(await run(source, adapter)).toMatchObject({ status: "succeeded", complete: true, fetched: 2, unchanged: 1, failed: 1 });
    expect((await t.adminSql`SELECT count(*)::int AS n FROM raw_job_postings WHERE source_id = ${source} AND external_id = '2'`)[0].n).toBe(0);
  });

  it("a NUL byte on a re-fetch of an already-tracked record keeps its posting open instead of letting a complete run close it", async () => {
    const source = await insertSource(t.adminSql, USER);
    // First, ingest record 2 cleanly: its posting exists and is open.
    await ok(source, 1, 2);
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open" });

    // Re-fetch the SAME external id, but today its payload picks up a NUL byte.
    const bad: RawRecord = { externalId: "2", payload: { ...greenhouseJobFixture, id: 2, title: "Product\u0000Designer" } };
    const summary = await run(source, adapterFor(() => yielding([rec(1), bad])));
    expect(summary).toMatchObject({ status: "succeeded", complete: true, fetched: 2, unchanged: 1, failed: 1, closed: 0 });
    // The posting was seen (just unreadable this time), so it must not be closed as "missing".
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open" });
  });

  it("stores a record whose external id is exactly at the 200-character cap", async () => {
    const source = await insertSource(t.adminSql, USER);
    const atCap: RawRecord = { externalId: "y".repeat(200), payload: { ...greenhouseJobFixture, id: 2, title: TITLES[2] } };
    expect(await run(source, adapterFor(() => yielding([atCap])))).toMatchObject({ created: 1, failed: 0, complete: true });
  });

  it("an unexpected adapter error becomes a retryable 'unknown' and its message is never stored", async () => {
    const source = await insertSource(t.adminSql, USER);
    async function* leaks(): AsyncIterable<RawRecord> {
      throw new Error("secret posting content");
    }
    const error = await failureOf(run(source, adapterFor(leaks)));
    expect(error).toMatchObject({ errorClass: "unknown", retryable: true });
    expect(error.message).toBe("unknown");
    expect(JSON.stringify(await lastRun(source))).not.toContain("secret");
    expect(JSON.stringify(await sourceRow(source))).not.toContain("secret");
  });
});

describe("runIngestion — the consent gate (D3) is enforced in worker code", () => {
  it("never calls the adapter for a source without consent, and records why", async () => {
    const source = await insertSource(t.adminSql, USER, { consent: false });
    const factory = adapterFor(() => yielding([rec(1)]));
    const error = await failureOf(run(source, factory));
    expect(error).toMatchObject({ errorClass: "consent_missing", retryable: false });
    expect(factory).not.toHaveBeenCalled();
    expect(await lastRun(source)).toMatchObject({ status: "failed", error_class: "consent_missing" });
    expect(await statuses()).toEqual({});
  });

  it("refuses a disabled source without calling the adapter, and records why", async () => {
    const disabled = await insertSource(t.adminSql, USER, { enabled: false });
    const factory = adapterFor(() => yielding([rec(1)]));
    expect(await failureOf(run(disabled, factory))).toMatchObject({ errorClass: "source_disabled", retryable: false });
    expect(factory).not.toHaveBeenCalled();
    expect(await lastRun(disabled)).toMatchObject({ status: "failed", error_class: "source_disabled" });
    expect(await statuses()).toEqual({});
  });

  it("reports an unknown source id as not_found", async () => {
    expect(await failureOf(ok("00000000-0000-0000-0000-00000000ffff", 1))).toMatchObject({ errorClass: "not_found" });
  });

  it("reports a source owned by another user as not_found (RLS scoping) and never calls the adapter", async () => {
    const foreign = await insertSource(t.adminSql, OTHER_USER);
    const factory = adapterFor(() => yielding([rec(1)]));
    const error = await failureOf(run(foreign, factory));
    expect(error).toMatchObject({ errorClass: "not_found", retryable: false });
    expect(factory).not.toHaveBeenCalled();
    expect((await t.adminSql`SELECT count(*)::int AS n FROM ingestion_runs WHERE source_id = ${foreign}`)[0].n).toBe(0);
    expect(await sourceRow(foreign)).toMatchObject({ last_run_status: null });
  });

  it("reports a source id that is not a UUID as not_found, without a database error", async () => {
    const factory = adapterFor(() => yielding([rec(1)]));
    const error = await failureOf(run("not-a-uuid", factory));
    expect(error).toBeInstanceOf(IngestError);
    expect(error).toMatchObject({ errorClass: "not_found", retryable: false });
    expect(error.message).toBe("not_found");
    expect(factory).not.toHaveBeenCalled();
  });
});

// The clock is the fault-injection point: `now()` is called once at the start (startedAt), once per
// record, once for the closing step and once inside every finish(), so making call N throw a raw
// error simulates a database failure at that exact step. The raw message must never surface.
describe("runIngestion — failures after or around the fetch never escape as raw errors", () => {
  const SECRET = "secret posting content";
  const faultyClock = (failOnCall: number) => {
    let calls = 0;
    return () => {
      calls++;
      if (calls === failOnCall) throw new Error(SECRET);
      return new Date(Date.UTC(2026, 8, 21, 11, 0, calls));
    };
  };
  const runWith = (sourceId: string, factory: ReturnType<typeof adapterFor>, now: () => Date) =>
    runIngestion(t.db, { userId: USER, sourceId, adapterFor: factory, now });
  const storedText = async (sourceId: string) =>
    JSON.stringify([
      await t.adminSql`SELECT * FROM ingestion_runs WHERE source_id = ${sourceId}`,
      await t.adminSql`SELECT * FROM job_sources WHERE id = ${sourceId}`,
      await t.adminSql`SELECT * FROM jobs WHERE user_id = ${USER}`,
    ]);
  const expectSanitized = (error: IngestError) => {
    expect(error).toBeInstanceOf(IngestError);
    expect(error.message).toBe(error.errorClass);
    expect(`${error.stack}${JSON.stringify(error)}${String(error.cause)}`).not.toContain("secret");
  };

  it("(a) a failure while closing is recorded as a failed, incomplete run and closes nothing", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2, 3);
    // Second run sees one record, so a close WOULD run: calls are startedAt(1), record(2), close(3).
    const error = await failureOf(runWith(source, adapterFor(() => yielding([rec(1)])), faultyClock(3)));
    expect(error).toMatchObject({ errorClass: "unknown", retryable: true });
    expect(error.message).toBe("unknown");
    expectSanitized(error);

    expect(await lastRun(source)).toMatchObject({ status: "failed", complete: false, error_class: "unknown", fetched_count: 1, closed_count: 0 });
    expect(await sourceRow(source)).toMatchObject({ last_run_status: "failed", last_error_class: "unknown" });
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open", "Security Analyst": "open" });
    expect(await storedText(source)).not.toContain("secret");
  });

  it("(b) if recording the failure also fails, the caller still sees the original error class", async () => {
    const source = await insertSource(t.adminSql, USER);
    async function* dies(): AsyncIterable<RawRecord> {
      throw new IngestError("server_error");
    }
    // Calls: startedAt(1), then the catch-path finish(2) blows up.
    const error = await failureOf(runWith(source, adapterFor(dies), faultyClock(2)));
    expect(error).toMatchObject({ errorClass: "server_error", retryable: true });
    expectSanitized(error);
    // The fault really fired: the failure could not be recorded, so the run row is still 'running'.
    expect(await lastRun(source)).toMatchObject({ status: "running" });
    expect(await storedText(source)).not.toContain("secret");
  });

  it("(b2) an unexpected adapter error whose recording also fails still surfaces as class 'unknown'", async () => {
    const source = await insertSource(t.adminSql, USER);
    async function* leaks(): AsyncIterable<RawRecord> {
      throw new Error(SECRET);
    }
    const error = await failureOf(runWith(source, adapterFor(leaks), faultyClock(2)));
    expect(error).toMatchObject({ errorClass: "unknown", retryable: true });
    expectSanitized(error);
    expect(await lastRun(source)).toMatchObject({ status: "running" });
    expect(await storedText(source)).not.toContain("secret");
  });

  it("(c) if recording a consent refusal fails, the caller still sees consent_missing", async () => {
    const source = await insertSource(t.adminSql, USER, { consent: false });
    const factory = adapterFor(() => yielding([rec(1)]));
    // Calls: startedAt(1), then the guard-path finish(2) blows up.
    const error = await failureOf(runWith(source, factory, faultyClock(2)));
    expect(error).toMatchObject({ errorClass: "consent_missing", retryable: false });
    expectSanitized(error);
    expect(factory).not.toHaveBeenCalled();
    expect(await lastRun(source)).toMatchObject({ status: "running" });
    expect(await storedText(source)).not.toContain("secret");
  });

  it("(d) if recording success fails, the caller sees IngestError('unknown') and the run is marked failed", async () => {
    const source = await insertSource(t.adminSql, USER);
    // Calls: startedAt(1), record(2), close(3), success finish(4) blows up; the fallback finish(5) works.
    const error = await failureOf(runWith(source, adapterFor(() => yielding([rec(1)])), faultyClock(4)));
    expect(error).toMatchObject({ errorClass: "unknown", retryable: true });
    expect(error.message).toBe("unknown");
    expectSanitized(error);
    expect(await lastRun(source)).toMatchObject({ status: "failed", complete: false, error_class: "unknown" });
    expect(await sourceRow(source)).toMatchObject({ last_run_status: "failed", last_error_class: "unknown" });
    expect(await storedText(source)).not.toContain("secret");
  });

  it("(e) a raw error from the closing step never appears in the thrown error or in any stored row", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2, 3);
    const error = await failureOf(runWith(source, adapterFor(() => yielding([rec(1), rec(2)])), faultyClock(4)));
    // Calls: startedAt(1), record(2), record(3), close(4).
    expectSanitized(error);
    expect(error).toMatchObject({ errorClass: "unknown" });
    expect(await lastRun(source)).toMatchObject({ status: "failed", error_class: "unknown", fetched_count: 2 });
    expect(await storedText(source)).not.toContain("secret");
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open", "Security Analyst": "open" });
  });
});

describe("runIngestion — uploads", () => {
  it("strips a NUL byte from an attacker-controlled filename instead of throwing", async () => {
    const records: RawRecord[] = [{ externalId: "u1", payload: { title: "Data Analyst", company: "Acme" } }];
    const stored = await withUserContext(t.db, USER, (tx) =>
      storeUpload(tx, { filename: "jobs\u0000.csv", records, now: new Date("2026-09-21T09:00:00Z") })
    );
    expect(await sourceRow(stored.sourceId)).toMatchObject({ kind: "upload", label: "jobs.csv" });
  });

  it("processes a stored upload and never closes anything, even when a later run has fewer records", async () => {
    const uploadAdapterFor = createAdapterFor({ db: t.db, userId: USER, greenhouseBaseUrl: "http://unused.test", leverBaseUrl: "http://unused.test" });
    const records: RawRecord[] = [
      { externalId: "u1", payload: { title: "Data Analyst", company: "Acme" } },
      { externalId: "u2", payload: { title: "Site Reliability Engineer", company: "Acme" } },
    ];
    const stored = await withUserContext(t.db, USER, (tx) => storeUpload(tx, { filename: "jobs.csv", records, now: new Date("2026-09-21T09:00:00Z") }));
    expect(stored.count).toBe(2);
    expect(await sourceRow(stored.sourceId)).toMatchObject({ kind: "upload", label: "jobs.csv", enabled: true });
    expect((await sourceRow(stored.sourceId)).consent_confirmed_at).not.toBeNull();

    const first = await runIngestion(t.db, { userId: USER, sourceId: stored.sourceId, adapterFor: uploadAdapterFor, now: clock });
    expect(first).toMatchObject({ created: 2, closed: 0, complete: true });

    await t.adminSql`DELETE FROM raw_job_postings WHERE source_id = ${stored.sourceId} AND external_id = 'u2'`;
    const second = await runIngestion(t.db, { userId: USER, sourceId: stored.sourceId, adapterFor: uploadAdapterFor, now: clock });
    expect(second).toMatchObject({ unchanged: 1, closed: 0 });
    expect(await statuses()).toEqual({ "Data Analyst": "open", "Site Reliability Engineer": "open" });
  });
});
