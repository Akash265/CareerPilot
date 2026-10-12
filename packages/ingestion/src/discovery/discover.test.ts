import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { recordBoardsFromRun, retireIfGone, validatePendingBoards } from "./discover";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";
import { IngestError, type RawRecord, type SourceAdapter, type SourceRef } from "../types";

// Phase 12 test user (…0d04), verified unused repo-wide on 2026-10-12.
const USER = "00000000-0000-0000-0000-000000000d04";
let t: TestDb;
const CONSENT = new Date("2026-10-12T09:00:00Z");
const NOW = new Date("2026-10-12T10:00:00Z");
const iso = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

beforeAll(async () => {
  t = await openTestDb();
});
const wipe = async () => {
  await t.adminSql`DELETE FROM discovered_boards WHERE user_id = ${USER}`;
  await t.adminSql`DELETE FROM discovery_settings WHERE user_id = ${USER}`;
  await wipeUser(t.adminSql, USER);
};
beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await t.close();
});

const consent = (autoDiscover = true) =>
  t.adminSql`INSERT INTO discovery_settings (user_id, auto_discover, consented_at) VALUES (${USER}, ${autoDiscover}, ${CONSENT.toISOString()}::timestamptz)`;
async function storeRaw(sourceId: string, externalId: string, payload: unknown, fetchedAt = NOW) {
  await t.adminSql`INSERT INTO raw_job_postings (user_id, source_id, external_id, payload, content_hash, fetched_at)
                   VALUES (${USER}, ${sourceId}, ${externalId}, ${JSON.stringify(payload)}::jsonb, ${externalId}, ${fetchedAt.toISOString()}::timestamptz)`;
}
const boards = () => t.adminSql`SELECT kind, slug, status, source_id, found_via_source_id FROM discovered_boards WHERE user_id = ${USER} ORDER BY slug`;

/** Boards answer from this map: a list of records, or an error class to throw. */
function adapterFor(boardsBySlug: Record<string, RawRecord[] | string>) {
  return (source: SourceRef): SourceAdapter => ({
    async *fetch(ref: SourceRef) {
      const answer = boardsBySlug[ref.config.slug ?? ""];
      if (answer === undefined || typeof answer === "string") throw new IngestError((answer ?? "not_found") as never);
      for (const r of answer) yield r;
      void source;
    },
  });
}
const ashbyJob = (id: string) => ({ externalId: id, payload: { id, title: "Data Engineer", jobUrl: "https://jobs.ashbyhq.com/x" } });
const workableJob = { externalId: "W1", payload: { shortcode: "W1", title: "ML Engineer", account_name: "Hugging Face" } };

describe("recordBoardsFromRun (Phase 12, D186)", () => {
  it("records boards linked from this run's raw records, once, pending, and none the user already has as a source", async () => {
    await consent();
    const hn = await insertSource(t.adminSql, USER, { kind: "hn_hiring", label: "HN" });
    const own = await insertSource(t.adminSql, USER, { kind: "ashby", slug: "self" });
    await storeRaw(hn, "1", { text: 'Apply <a href="https:&#x2F;&#x2F;jobs.ashbyhq.com&#x2F;linear">here</a> or https://apply.workable.com/huggingface/' });
    await storeRaw(hn, "2", { text: "Also https://jobs.ashbyhq.com/Linear and https://jobs.ashbyhq.com/self" });
    await storeRaw(hn, "3", { text: "old https://jobs.lever.co/old" }, new Date("2026-10-01T00:00:00Z"));
    expect(await recordBoardsFromRun(t.db, { userId: USER, sourceId: hn, since: new Date("2026-10-12T00:00:00Z") })).toBe(2);
    expect(await recordBoardsFromRun(t.db, { userId: USER, sourceId: hn, since: new Date("2026-10-12T00:00:00Z") })).toBe(0);
    expect(await boards()).toEqual([
      { kind: "workable", slug: "huggingface", status: "pending", source_id: null, found_via_source_id: hn },
      { kind: "ashby", slug: "linear", status: "pending", source_id: null, found_via_source_id: hn },
    ].sort((a, b) => a.slug.localeCompare(b.slug)));
    void own;
  });

  it("does nothing without the standing consent or with auto-discovery off", async () => {
    const hn = await insertSource(t.adminSql, USER, { kind: "hn_hiring", label: "HN" });
    await storeRaw(hn, "1", { text: "https://jobs.ashbyhq.com/linear" });
    expect(await recordBoardsFromRun(t.db, { userId: USER, sourceId: hn, since: new Date(0) })).toBe(0);
    await consent(false);
    expect(await recordBoardsFromRun(t.db, { userId: USER, sourceId: hn, since: new Date(0) })).toBe(0);
    expect(await boards()).toEqual([]);
  });
});

describe("validatePendingBoards", () => {
  const limits = { maxSources: 300, maxPerRun: 25 };

  it("turns a board with jobs into an enabled, consented, discovered source named after the company", async () => {
    await consent();
    await t.adminSql`INSERT INTO discovered_boards (user_id, kind, slug) VALUES (${USER}, 'workable', 'huggingface'), (${USER}, 'ashby', 'linear')`;
    const result = await validatePendingBoards(t.db, { userId: USER, adapterFor: adapterFor({ huggingface: [workableJob], linear: [ashbyJob("A1")] }), ...limits, now: () => NOW });
    expect(result).toEqual({ enabled: 2, rejected: 0, pending: 0 });
    const sources = await t.adminSql`SELECT kind, label, config, origin, enabled, consent_confirmed_at = ${CONSENT.toISOString()}::timestamptz AS consented
                                     FROM job_sources WHERE user_id = ${USER} ORDER BY kind`;
    expect(sources).toEqual([
      { kind: "ashby", label: "linear", config: { slug: "linear" }, origin: "discovered", enabled: true, consented: true },
      { kind: "workable", label: "Hugging Face", config: { slug: "huggingface" }, origin: "discovered", enabled: true, consented: true },
    ]);
    expect((await boards()).every((b) => b.status === "enabled" && b.source_id)).toBe(true);
  });

  it("rejects a board that does not exist or has no jobs, and keeps one whose fetch failed transiently", async () => {
    await consent();
    await t.adminSql`INSERT INTO discovered_boards (user_id, kind, slug) VALUES (${USER}, 'ashby', 'gone'), (${USER}, 'ashby', 'empty'), (${USER}, 'ashby', 'flaky')`;
    const result = await validatePendingBoards(t.db, { userId: USER, adapterFor: adapterFor({ empty: [], flaky: "server_error" }), ...limits, now: () => NOW });
    expect(result).toEqual({ enabled: 0, rejected: 2, pending: 1 });
    expect((await boards()).map((b) => [b.slug, b.status])).toEqual([["empty", "rejected"], ["flaky", "pending"], ["gone", "rejected"]]);
  });

  it("stops at maxPerRun and at maxSources discovered sources, leaving the rest pending", async () => {
    await consent();
    await t.adminSql`INSERT INTO discovered_boards (user_id, kind, slug) VALUES (${USER}, 'ashby', 'a'), (${USER}, 'ashby', 'b'), (${USER}, 'ashby', 'c')`;
    const all = adapterFor({ a: [ashbyJob("1")], b: [ashbyJob("2")], c: [ashbyJob("3")] });
    expect(await validatePendingBoards(t.db, { userId: USER, adapterFor: all, maxSources: 300, maxPerRun: 1, now: () => NOW })).toEqual({ enabled: 1, rejected: 0, pending: 2 });
    expect(await validatePendingBoards(t.db, { userId: USER, adapterFor: all, maxSources: 2, maxPerRun: 25, now: () => NOW })).toEqual({ enabled: 1, rejected: 0, pending: 1 });
  });

  it("does nothing without consent", async () => {
    await t.adminSql`INSERT INTO discovered_boards (user_id, kind, slug) VALUES (${USER}, 'ashby', 'a')`;
    expect(await validatePendingBoards(t.db, { userId: USER, adapterFor: adapterFor({ a: [ashbyJob("1")] }), ...limits, now: () => NOW }))
      .toEqual({ enabled: 0, rejected: 0, pending: 1 });
  });
});

describe("retireIfGone", () => {
  it("disables a discovered source whose last two runs were not_found, and marks its board gone", async () => {
    await consent();
    const source = await insertSource(t.adminSql, USER, { kind: "ashby", slug: "x" });
    await t.adminSql`UPDATE job_sources SET origin = 'discovered' WHERE id = ${source}`;
    await t.adminSql`INSERT INTO discovered_boards (user_id, kind, slug, status, source_id) VALUES (${USER}, 'ashby', 'x', 'enabled', ${source})`;
    const runAt = (minutes: number, errorClass: string | null) =>
      t.adminSql`INSERT INTO ingestion_runs (user_id, source_id, started_at, finished_at, status, error_class)
                 VALUES (${USER}, ${source}, ${iso(minutes)}::timestamptz, ${iso(minutes)}::timestamptz, ${errorClass ? "failed" : "succeeded"}, ${errorClass})`;
    await runAt(0, "not_found");
    expect(await retireIfGone(t.db, { userId: USER, sourceId: source })).toBe(false);
    await runAt(1, "not_found");
    expect(await retireIfGone(t.db, { userId: USER, sourceId: source })).toBe(true);
    const [row] = await t.adminSql`SELECT enabled FROM job_sources WHERE id = ${source}`;
    expect(row.enabled).toBe(false);
    expect((await boards())[0].status).toBe("gone");
  });

  it("never retires a source the user added", async () => {
    const source = await insertSource(t.adminSql, USER, { kind: "ashby", slug: "mine" });
    for (const m of [0, 1]) {
      await t.adminSql`INSERT INTO ingestion_runs (user_id, source_id, started_at, finished_at, status, error_class)
                       VALUES (${USER}, ${source}, ${iso(m)}::timestamptz, ${iso(m)}::timestamptz, 'failed', 'not_found')`;
    }
    expect(await retireIfGone(t.db, { userId: USER, sourceId: source })).toBe(false);
  });
});
