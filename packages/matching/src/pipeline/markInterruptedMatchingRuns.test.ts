import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { markInterruptedMatchingRuns } from "./markInterruptedMatchingRuns";

const USER = "00000000-0000-0000-0000-000000000d31";
let t: TestDb;
let goalId: string;

beforeAll(async () => { t = await openTestDb(); });
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
  const [goal] = await t.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
  goalId = goal.id as string;
});
afterAll(async () => { await wipeUser(t.adminSql, USER); await t.close(); });

const run = async (status: string, startedAt: string) => {
  const [r] = await t.adminSql`INSERT INTO matching_runs (user_id, career_goal_id, started_at, status, finished_at)
    VALUES (${USER}, ${goalId}, ${startedAt}, ${status}, ${status === "running" ? null : startedAt}) RETURNING id`;
  return r.id as string;
};

describe("markInterruptedMatchingRuns", () => {
  it("fails matching runs left running, with reason interrupted, and leaves finished ones alone", async () => {
    const stuck = await run("running", "2026-10-26T08:00:00Z");
    const done = await run("completed", "2026-10-26T07:00:00Z");
    const failed = await run("failed", "2026-10-26T06:00:00Z");
    const now = new Date("2026-10-26T09:00:00Z");

    expect(await markInterruptedMatchingRuns(t.db, USER, now)).toBe(1);

    const rows = await t.adminSql`SELECT id, status, error_class, finished_at FROM matching_runs WHERE user_id = ${USER}`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[stuck]).toMatchObject({ status: "failed", error_class: "interrupted" });
    expect(new Date(byId[stuck].finished_at).toISOString()).toBe(now.toISOString());
    expect(byId[done]).toMatchObject({ status: "completed", error_class: null });
    expect(byId[failed]).toMatchObject({ status: "failed", error_class: null });
  });

  it("does nothing when no run was interrupted", async () => {
    await run("completed", "2026-10-26T07:00:00Z");
    expect(await markInterruptedMatchingRuns(t.db, USER, new Date())).toBe(0);
  });
});
