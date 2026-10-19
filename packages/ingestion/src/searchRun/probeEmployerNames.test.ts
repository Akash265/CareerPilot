import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { withUserContext } from "@ai-career/db";
import { probeEmployerNames } from "./probeEmployerNames";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";

// Phase 13a test user (…0d08); verified unused with grep first.
const USER = "00000000-0000-0000-0000-000000000d08";
const NOW = new Date("2026-10-19T12:00:00Z");
let t: TestDb;

beforeAll(async () => { t = await openTestDb(); });
const wipe = async () => {
  await t.adminSql`DELETE FROM discovered_boards WHERE user_id = ${USER}`;
  await t.adminSql`DELETE FROM discovery_settings WHERE user_id = ${USER}`;
  await wipeUser(t.adminSql, USER);
};
beforeEach(async () => {
  await wipe();
  await t.adminSql`INSERT INTO discovery_settings (user_id, auto_discover, consented_at) VALUES (${USER}, true, now())`;
});
afterAll(async () => { await wipe(); await t.close(); });

/** A job from `sourceId` whose company is `name`, first seen `daysAgo` days before NOW. */
async function job(sourceId: string, name: string, daysAgo = 1) {
  const seen = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
  const [row] = await t.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
    VALUES (${USER}, ${name}, ${name.toLowerCase()}, 'Data Engineer', 'data engineer', ${name}, ${seen}::timestamptz, ${seen}::timestamptz)
    RETURNING id`;
  await t.adminSql`INSERT INTO job_postings (user_id, job_id, source_id, external_id, fingerprint, content_hash, normalized, first_seen_at, last_seen_at)
                   VALUES (${USER}, ${row.id}, ${sourceId}, ${name}, ${name}, ${name}, '{}'::jsonb, ${seen}::timestamptz, ${seen}::timestamptz)`;
}
const probe = (maxNames = 30) => withUserContext(t.db, USER, (tx) => probeEmployerNames(tx, { now: NOW, maxNames }));
const boards = () => t.adminSql`SELECT kind, slug, found_via, expected_company FROM discovered_boards WHERE user_id = ${USER} ORDER BY kind, slug`;

describe("probeEmployerNames (Phase 13a)", () => {
  it("queues slug guesses on every board kind for employers seen in search results", async () => {
    const remotive = await insertSource(t.adminSql, USER, { kind: "remotive", label: "Remotive" });
    await job(remotive, "Acme Robotics");
    expect(await probe()).toEqual({ names: 1, boardsQueued: 12 });
    const rows = await boards();
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.kind === "lever").map((r) => r.slug)).toEqual(["acme-robotics", "acmerobotics"]);
    expect(rows.every((r) => r.found_via === "name_probe" && r.expected_company === "Acme Robotics")).toBe(true);
  });

  it("never probes a name twice, and skips companies from board sources, old jobs, and over the cap", async () => {
    const remotive = await insertSource(t.adminSql, USER, { kind: "remotive", label: "Remotive" });
    const board = await insertSource(t.adminSql, USER, { kind: "greenhouse", slug: "boardco", label: "Board Co" });
    await job(remotive, "Acme");
    await job(remotive, "Old Co", 20);
    await job(board, "Board Co");
    await job(remotive, "Second Co");
    expect((await probe(1)).names).toBe(1);
    expect((await probe(30)).names).toBe(1); // only the one not yet probed
    expect((await probe(30)).names).toBe(0);
    const companies = new Set((await boards()).map((r) => r.expected_company));
    expect([...companies].sort()).toEqual(["Acme", "Second Co"]);
  });

  it("does nothing without consent and auto-discovery", async () => {
    await t.adminSql`UPDATE discovery_settings SET auto_discover = false WHERE user_id = ${USER}`;
    const remotive = await insertSource(t.adminSql, USER, { kind: "remotive", label: "Remotive" });
    await job(remotive, "Acme");
    expect(await probe()).toEqual({ names: 0, boardsQueued: 0 });
  });
});
