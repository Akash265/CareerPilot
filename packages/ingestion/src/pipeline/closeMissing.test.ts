import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { withUserContext } from "@ai-career/db";
import { persistPosting } from "./persistPosting";
import { closeMissingPostings } from "./closeMissing";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";
import { makeNormalized } from "../testing/factories";
import type { NormalizedJob, SourceKind } from "../types";

const USER = "00000000-0000-0000-0000-0000000000a4";
const T0 = new Date("2026-09-21T10:00:00Z");
const RUN2_START = new Date("2026-09-21T16:00:00Z");
const T2 = new Date("2026-09-21T16:00:05Z");
const T3 = new Date("2026-09-21T22:00:00Z");
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const persist = (sourceId: string, kind: SourceKind, n: NormalizedJob, now: Date) =>
  withUserContext(t.db, USER, (tx) => persistPosting(tx, { sourceId, sourceKind: kind, normalized: n, contentHash: "h", now }));
const close = (sourceId: string) =>
  withUserContext(t.db, USER, (tx) => closeMissingPostings(tx, sourceId, RUN2_START, new Date("2026-09-21T16:01:00Z")));
const status = async (title: string) =>
  (await t.adminSql`SELECT status, closed_at FROM jobs WHERE user_id = ${USER} AND title = ${title}`)[0];

describe("closeMissingPostings", () => {
  it("closes only the postings not seen since the run started, and their jobs", async () => {
    const source = await insertSource(t.adminSql, USER);
    await persist(source, "greenhouse", makeNormalized({ externalId: "a", title: "Alpha Role", descriptionText: "a" }), T0);
    await persist(source, "greenhouse", makeNormalized({ externalId: "b", title: "Bravo Role", descriptionText: "b" }), T0);
    // Run 2 sees only "a".
    await persist(source, "greenhouse", makeNormalized({ externalId: "a", title: "Alpha Role", descriptionText: "a" }), T2);

    expect(await close(source)).toBe(1);
    expect((await status("Alpha Role")).status).toBe("open");
    const bravo = await status("Bravo Role");
    expect(bravo.status).toBe("closed");
    expect(bravo.closed_at).not.toBeNull();
  });

  it("reopens a closed job when its posting is seen again", async () => {
    const source = await insertSource(t.adminSql, USER);
    await persist(source, "greenhouse", makeNormalized({ externalId: "b", title: "Bravo Role" }), T0);
    await close(source);
    expect((await status("Bravo Role")).status).toBe("closed");

    const res = await persist(source, "greenhouse", makeNormalized({ externalId: "b", title: "Bravo Role" }), T3);
    expect(res.outcome).toBe("unchanged");
    const reopened = await status("Bravo Role");
    expect(reopened.status).toBe("open");
    expect(reopened.closed_at).toBeNull();
  });

  it("keeps a job open while any of its postings, from any source, is still open", async () => {
    const gh = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    const up = await insertSource(t.adminSql, USER, { kind: "upload" });
    await persist(gh, "greenhouse", makeNormalized({ externalId: "g1", title: "Shared Role" }), T0);
    await persist(up, "upload", makeNormalized({ externalId: "u1", title: "Shared Role" }), T0);

    await close(gh); // greenhouse posting unseen -> closed; the upload posting stays open
    expect((await status("Shared Role")).status).toBe("open");
    const postings = await t.adminSql`SELECT external_id, status FROM job_postings WHERE user_id = ${USER} ORDER BY external_id`;
    expect(postings.map((p) => [p.external_id, p.status])).toEqual([["g1", "closed"], ["u1", "open"]]);
  });
});
