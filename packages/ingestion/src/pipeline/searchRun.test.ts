import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { runIngestion } from "./runIngestion";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";
import { IngestError, type RawRecord, type SourceAdapter, type SourceRef } from "../types";

// Phase 12 test user (…0d03), verified unused repo-wide on 2026-10-12.
const USER = "00000000-0000-0000-0000-000000000d03";
let t: TestDb;
const LIMITS = { maxDaysOld: 30, maxPages: 2, staleAfterDays: 14 };

beforeAll(async () => {
  t = await openTestDb();
});
const wipe = async () => {
  await wipeUser(t.adminSql, USER);
  await t.adminSql`DELETE FROM career_goals WHERE user_id = ${USER}`;
  await t.adminSql`DELETE FROM discovery_settings WHERE user_id = ${USER}`;
};
const grantDiscovery = (autoDiscover = true) =>
  t.adminSql`INSERT INTO discovery_settings (user_id, auto_discover, consented_at) VALUES (${USER}, ${autoDiscover}, now())
             ON CONFLICT (user_id) DO UPDATE SET auto_discover = ${autoDiscover}, consented_at = now()`;
beforeEach(async () => {
  await wipe();
  await grantDiscovery();
});
afterAll(async () => {
  await wipe();
  await t.close();
});

async function insertGoal(opts: { roles: string[]; locations: string[]; workMode: string; active?: boolean; confirmed?: boolean }) {
  const [goal] = await t.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'goal', 1, 'parsed', ${opts.confirmed === false ? "draft" : "confirmed"}, ${opts.active ?? true}) RETURNING id`;
  await t.adminSql`
    INSERT INTO career_goal_constraints (user_id, career_goal_id, target_roles, locations, work_mode)
    VALUES (${USER}, ${goal.id}, ${opts.roles}, ${opts.locations}, ${opts.workMode})`;
}

/** A Remotive-shaped record: the pipeline normalizes it with the source's real kind. */
const rec = (id: number): RawRecord => ({
  externalId: String(id),
  payload: { id, title: `Data Engineer ${id}`, company_name: "Acme", url: `https://remotive.com/remote-jobs/${id}`, description: "<p>SQL</p>" },
});
/** The adapter is a stand-in that records the SourceRef it was given: this file tests the pipeline, not a provider. */
function capture(records: () => RawRecord[] | Error) {
  const seen: SourceRef[] = [];
  const factory = vi.fn((): SourceAdapter => ({
    async *fetch(ref: SourceRef) {
      seen.push(ref);
      const result = records();
      if (result instanceof Error) throw result;
      for (const r of result) yield r;
    },
  }));
  return { seen, factory: () => factory() };
}
const run = (sourceId: string, adapterFor: (s: SourceRef) => SourceAdapter, now = new Date("2026-10-12T10:00:00Z")) =>
  runIngestion(t.db, { userId: USER, sourceId, adapterFor, now: () => now, search: LIMITS });

describe("runIngestion — search sources (Phase 12, D187)", () => {
  it("gives a search source the active confirmed goal as its query, capped at 5 roles and 5 locations", async () => {
    await insertGoal({ roles: ["Data Engineer", "a", "b", "c", "d", "e"], locations: ["London", "Berlin"], workMode: "remote" });
    const source = await insertSource(t.adminSql, USER, { kind: "remotive", label: "Remotive" });
    const { seen, factory } = capture(() => [rec(1)]);
    const summary = await run(source, factory);
    expect(summary).toMatchObject({ status: "succeeded", created: 1, failed: 0 });
    expect(seen[0].query).toEqual({ roles: ["Data Engineer", "a", "b", "c", "d"], locations: ["London", "Berlin"], remoteOnly: true, maxDaysOld: 30, maxPages: 2 });
  });

  it("passes no query when there is no active confirmed goal, so the provider fails with no_active_goal", async () => {
    await insertGoal({ roles: ["x"], locations: [], workMode: "any", confirmed: false });
    const source = await insertSource(t.adminSql, USER, { kind: "remotive", label: "Remotive" });
    const { seen, factory } = capture(() => new IngestError("no_active_goal"));
    await expect(run(source, factory)).rejects.toMatchObject({ errorClass: "no_active_goal" });
    expect(seen[0].query).toBeUndefined();
    const [row] = await t.adminSql`SELECT last_error_class FROM job_sources WHERE id = ${source}`;
    expect(row.last_error_class).toBe("no_active_goal");
  });

  it("gives a board source no query", async () => {
    await insertGoal({ roles: ["Data Engineer"], locations: [], workMode: "any" });
    const source = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    const { seen, factory } = capture(() => [rec(1)]);
    await run(source, factory);
    expect(seen[0].query).toBeUndefined();
  });

  it("closes a search posting only after staleAfterDays without being seen, not when one run misses it", async () => {
    await insertGoal({ roles: ["Data Engineer"], locations: [], workMode: "any" });
    const source = await insertSource(t.adminSql, USER, { kind: "remotive", label: "Remotive" });
    await run(source, capture(() => [rec(1), rec(2)]).factory, new Date("2026-10-01T00:00:00Z"));
    const missed = await run(source, capture(() => [rec(1)]).factory, new Date("2026-10-10T00:00:00Z"));
    expect(missed.closed).toBe(0);
    const later = await run(source, capture(() => [rec(1)]).factory, new Date("2026-10-16T00:00:00Z"));
    expect(later.closed).toBe(1);
    const open = await t.adminSql`SELECT external_id FROM job_postings WHERE source_id = ${source} AND status = 'open' ORDER BY external_id`;
    expect(open.map((r) => r.external_id)).toEqual(["1"]);
  });

  it("refuses a search or discovered source once the standing consent is withdrawn, even with its own consent stamp (review fix)", async () => {
    await insertGoal({ roles: ["Data Engineer"], locations: [], workMode: "any" });
    const search = await insertSource(t.adminSql, USER, { kind: "remotive", label: "Remotive" });
    const discovered = await insertSource(t.adminSql, USER, { kind: "greenhouse", slug: "found" });
    await t.adminSql`UPDATE job_sources SET origin = 'discovered' WHERE id = ${discovered}`;
    await t.adminSql`UPDATE discovery_settings SET consented_at = NULL WHERE user_id = ${USER}`;
    for (const id of [search, discovered]) {
      await expect(run(id, capture(() => [rec(1)]).factory)).rejects.toMatchObject({ errorClass: "consent_missing" });
    }
  });

  it("refuses a discovered source while auto-discovery is off, but still runs a search source", async () => {
    await insertGoal({ roles: ["Data Engineer"], locations: [], workMode: "any" });
    await grantDiscovery(false);
    const discovered = await insertSource(t.adminSql, USER, { kind: "greenhouse", slug: "found" });
    await t.adminSql`UPDATE job_sources SET origin = 'discovered' WHERE id = ${discovered}`;
    await expect(run(discovered, capture(() => [rec(1)]).factory)).rejects.toMatchObject({ errorClass: "source_disabled" });
    const search = await insertSource(t.adminSql, USER, { kind: "remotive", label: "Remotive" });
    expect((await run(search, capture(() => [rec(1)]).factory)).status).toBe("succeeded");
  });
});
