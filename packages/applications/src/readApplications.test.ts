import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { openTestDb, wipeUser, seedJobWithDocuments, type TestDb } from "./testing";
import { createApplication } from "./createApplication";
import { getApplication, listApplications, getApplicationForJob, listDocumentOptions } from "./readApplications";

const USER = "00000000-0000-0000-0000-0000000009a3";
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});
beforeEach(() => wipeUser(t.adminSql, USER));

const external = (companyName: string, extra: Record<string, unknown> = {}) =>
  createApplication(t.db, USER, { external: { companyName, jobTitle: "Analyst" }, ...extra });

describe("read applications", () => {
  it("getApplication returns the row with events oldest-first, or null", async () => {
    const row = await external("Globex");
    // One minute after the creation event's own time, not Postgres now(): createApplication stamps that event with
    // Node's clock, and the Docker VM's clock can lag the host's by more than a minute (e.g. after sleep), which
    // flipped the order when the two clocks were compared.
    await t.adminSql`INSERT INTO application_events (user_id, application_id, type, occurred_at, detail)
                     SELECT ${USER}, ${row.id}, 'note', occurred_at + interval '1 minute', '{"text":"later"}'::jsonb
                     FROM application_events WHERE application_id = ${row.id} AND type = 'status_change'`;
    const got = await getApplication(t.db, USER, row.id);
    expect(got?.application.id).toBe(row.id);
    expect(got?.events.map((e) => e.type)).toEqual(["status_change", "note"]);
    expect(await getApplication(t.db, USER, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("listApplications orders by applied date, filters by status and counts due follow-ups on open applications only", async () => {
    const a = await external("A", { appliedAt: "2026-09-01", followUpAt: "2026-09-10" });
    await external("B", { appliedAt: "2026-09-20", followUpAt: "2026-12-01" });
    const c = await external("C", { appliedAt: "2026-09-10", followUpAt: "2026-09-05" });
    await t.adminSql`UPDATE applications SET status = 'rejected', terminal_at = now() WHERE id = ${c.id}`;

    const all = await listApplications(t.db, USER, { today: "2026-09-30" });
    expect(all.applications.map((r) => r.companyName)).toEqual(["B", "C", "A"]);
    expect(all.dueCount).toBe(1);

    const due = await listApplications(t.db, USER, { today: "2026-09-30", dueOnly: true });
    expect(due.applications.map((r) => r.id)).toEqual([a.id]);

    const rejected = await listApplications(t.db, USER, { today: "2026-09-30", status: "rejected" });
    expect(rejected.applications.map((r) => r.id)).toEqual([c.id]);
  });

  it("getApplicationForJob and listDocumentOptions serve the match page", async () => {
    const s = await seedJobWithDocuments(t.adminSql, USER);
    expect(await getApplicationForJob(t.db, USER, s.jobId)).toBeNull();
    await t.adminSql`INSERT INTO application_pitches (user_id, job_id, version, origin, research_status_snapshot, bullets, requires_review)
                     SELECT user_id, job_id, 2, 'user_edited', research_status_snapshot, bullets, false FROM application_pitches WHERE id = ${s.pitchId}`;

    const options = await listDocumentOptions(t.db, USER, s.jobId);
    expect(options.resumes).toEqual([{ id: s.resumeId, version: 1, origin: null }]);
    expect(options.pitches.map((p) => [p.version, p.origin])).toEqual([[2, "user_edited"], [1, "generated"]]);
    expect(options.coverLetters).toEqual([{ id: s.coverLetterId, version: 1, origin: "generated" }]);

    const row = await createApplication(t.db, USER, { jobId: s.jobId });
    expect((await getApplicationForJob(t.db, USER, s.jobId))?.id).toBe(row.id);
  });
});
