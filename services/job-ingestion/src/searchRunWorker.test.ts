import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents } from "bullmq";

vi.mock("@ai-career/ingestion", async (orig) => ({
  ...(await orig<typeof import("@ai-career/ingestion")>()),
  coordinateSearchRun: vi.fn(async () => "completed"),
}));
import { coordinateSearchRun, SEARCH_RUN_JOB_NAME, type SearchRunJobData } from "@ai-career/ingestion";
import { createSearchRunWorker } from "./searchRunWorker";

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };
const queueName = `search-runs-test-${randomUUID()}`;
const USER = "00000000-0000-0000-0000-000000000d0b";
let queue: Queue<SearchRunJobData>;
let events: QueueEvents;

beforeAll(async () => {
  queue = new Queue<SearchRunJobData>(queueName, { connection });
  events = new QueueEvents(queueName, { connection });
  await events.waitUntilReady();
});
afterAll(async () => {
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
});

describe("search-run worker", () => {
  it("hands the run id to the coordinator with the configured user", async () => {
    const worker = createSearchRunWorker({ connection, userId: USER, queueName, coordinatorDeps: { marker: true } as never });
    await worker.waitUntilReady();
    const job = await queue.add(SEARCH_RUN_JOB_NAME, { runId: "run-1" }, { jobId: "run-1" });
    await job.waitUntilFinished(events);
    expect(coordinateSearchRun).toHaveBeenCalledWith(expect.objectContaining({ marker: true, userId: USER }), "run-1");
    await worker.close();
  });
});
