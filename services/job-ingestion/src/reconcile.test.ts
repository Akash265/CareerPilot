import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { insertSource, openTestDb, wipeUser, type TestDb } from "@ai-career/ingestion/testing";
import type { IngestJobData } from "@ai-career/ingestion";
import { reconcileSchedules } from "./reconcile";

const USER = "00000000-0000-0000-0000-0000000000a5";
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };

let t: TestDb;
let queue: Queue<IngestJobData>;

beforeAll(async () => {
  t = await openTestDb();
  queue = new Queue<IngestJobData>(`job-ingestion-test-${randomUUID()}`, { connection });
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
  for (const s of await queue.getJobSchedulers()) await queue.removeJobScheduler((s.id ?? s.key) as string);
});
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const reconcile = (refresh = false) =>
  reconcileSchedules({ db: t.db, userId: USER, queue, everyMs: 3_600_000, refresh });
const schedulerIds = async () => (await queue.getJobSchedulers()).map((s) => s.id ?? s.key).sort();

describe("reconcileSchedules", () => {
  it("schedules only enabled, consented, non-upload sources", async () => {
    const eligible = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    await insertSource(t.adminSql, USER, { kind: "lever", consent: false });
    await insertSource(t.adminSql, USER, { kind: "greenhouse", enabled: false });
    await insertSource(t.adminSql, USER, { kind: "upload" });

    await reconcile(true);
    expect(await schedulerIds()).toEqual([`schedule-${eligible}`]);
  });

  it("removes a scheduler when its source is disabled, and a second pass changes nothing", async () => {
    const source = await insertSource(t.adminSql, USER, { kind: "lever" });
    await reconcile();
    expect(await schedulerIds()).toEqual([`schedule-${source}`]);

    expect(await reconcile()).toEqual({ upsert: [], remove: [] }); // idempotent: the timer is not reset

    await t.adminSql`UPDATE job_sources SET enabled = false WHERE id = ${source}`;
    expect(await reconcile()).toEqual({ upsert: [], remove: [`schedule-${source}`] });
    expect(await schedulerIds()).toEqual([]);
  });

  it("gives each scheduled job the source id as its payload", async () => {
    const source = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    await reconcile();
    const [scheduler] = await queue.getJobSchedulers();
    expect(scheduler.every).toBe(3_600_000);
    expect(scheduler.template?.data).toEqual({ sourceId: source });
  });
});
