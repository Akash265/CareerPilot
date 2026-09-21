import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { greenhouseJobFixture, insertSource, openTestDb, wipeUser, type TestDb } from "@ai-career/ingestion/testing";
import { INGEST_JOB_NAME, IngestError, ingestJobId, type IngestJobData, type RawRecord, type SourceAdapter } from "@ai-career/ingestion";
import { createIngestWorker } from "./worker";

const USER = "00000000-0000-0000-0000-0000000000a6";
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };
const queueName = `job-ingestion-test-${randomUUID()}`;

let t: TestDb;
let queue: Queue<IngestJobData>;
let events: QueueEvents;
let worker: Worker<IngestJobData>;
let adapter: SourceAdapter;

beforeAll(async () => {
  t = await openTestDb();
  queue = new Queue<IngestJobData>(queueName, { connection });
  events = new QueueEvents(queueName, { connection });
  await events.waitUntilReady();
  worker = createIngestWorker({ connection, db: t.db, userId: USER, adapterFor: () => adapter, queueName });
  await worker.waitUntilReady();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
});
afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const enqueue = (sourceId: string, opts: Record<string, unknown> = {}) =>
  queue.add(INGEST_JOB_NAME, { sourceId }, { jobId: ingestJobId(sourceId), ...opts });

describe("ingest worker", () => {
  it("runs an enqueued source end to end", async () => {
    const source = await insertSource(t.adminSql, USER);
    const record: RawRecord = { externalId: "1", payload: greenhouseJobFixture };
    adapter = { fetch: async function* () { yield record; } };

    await (await enqueue(source)).waitUntilFinished(events);

    const jobs = await t.adminSql`SELECT title, status FROM jobs WHERE user_id = ${USER}`;
    expect(jobs).toEqual([{ title: "AI Engineer", status: "open" }]);
  });

  it("does not retry a permanent failure (a source without consent)", async () => {
    const source = await insertSource(t.adminSql, USER, { consent: false });
    const fetch = vi.fn(async function* (): AsyncIterable<RawRecord> {});
    adapter = { fetch };

    const job = await enqueue(source, { attempts: 3, backoff: { type: "fixed", delay: 10 }, removeOnFail: false });
    await expect(job.waitUntilFinished(events)).rejects.toThrow("consent_missing");

    expect((await queue.getJob(ingestJobId(source)))?.attemptsMade).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect((await t.adminSql`SELECT count(*)::int AS n FROM ingestion_runs WHERE source_id = ${source}`)[0].n).toBe(1);
  });

  it("retries a transient failure up to the attempt limit, recording every attempt", async () => {
    const source = await insertSource(t.adminSql, USER);
    adapter = {
      fetch: async function* (): AsyncIterable<RawRecord> {
        throw new IngestError("server_error");
      },
    };

    const job = await enqueue(source, { attempts: 2, backoff: { type: "fixed", delay: 20 }, removeOnFail: false });
    await expect(job.waitUntilFinished(events)).rejects.toThrow("server_error");

    expect((await queue.getJob(ingestJobId(source)))?.attemptsMade).toBe(2);
    const runs = await t.adminSql`SELECT status, error_class FROM ingestion_runs WHERE source_id = ${source}`;
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "failed" && r.error_class === "server_error")).toBe(true);
  });
});
