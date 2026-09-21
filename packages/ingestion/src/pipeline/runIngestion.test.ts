import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { withUserContext } from "@ai-career/db";
import { runIngestion, type RunSummary } from "./runIngestion";
import { createAdapterFor } from "./adapterFor";
import { storeUpload } from "./storeUpload";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";
import { greenhouseJobFixture } from "../fixtures";
import { IngestError, type RawRecord, type SourceAdapter } from "../types";

const USER = "00000000-0000-0000-0000-0000000000a2";
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
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
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

  it("refuses a disabled source, and reports an unknown source id as not_found", async () => {
    const disabled = await insertSource(t.adminSql, USER, { enabled: false });
    expect(await failureOf(ok(disabled, 1))).toMatchObject({ errorClass: "source_disabled", retryable: false });
    expect(await failureOf(ok("00000000-0000-0000-0000-00000000ffff", 1))).toMatchObject({ errorClass: "not_found" });
  });
});

describe("runIngestion — uploads", () => {
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
