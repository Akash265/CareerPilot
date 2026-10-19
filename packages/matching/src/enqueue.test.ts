import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { MATCHING_JOB_NAME, matchingJobId, type MatchingJobData } from "./queue";
import { pushMatching, rematchFlagKey, requestRematch, takeRematchFlag } from "./enqueue";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
const USER = "00000000-0000-0000-0000-000000000d09";
let redis: IORedis;
let queue: Queue<MatchingJobData>;

beforeAll(async () => {
  redis = new IORedis(url, { maxRetriesPerRequest: null });
  queue = new Queue<MatchingJobData>(`matching-test-${randomUUID()}`, { connection: redis });
});
beforeEach(async () => {
  await queue.obliterate({ force: true });
  await redis.del(rematchFlagKey(USER));
});
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await redis.quit();
});

describe("pushMatching", () => {
  it("adds once, then reports already_queued", async () => {
    expect(await pushMatching(queue, USER)).toBe("enqueued");
    expect(await pushMatching(queue, USER)).toBe("already_queued");
  });
  it("adds a delayed job and promotes it when asked", async () => {
    expect(await pushMatching(queue, USER, { delayMs: 60_000 })).toBe("enqueued");
    expect(await (await queue.getJob(matchingJobId(USER)))!.getState()).toBe("delayed");
    expect(await pushMatching(queue, USER, { promoteDelayed: true })).toBe("enqueued");
    expect(await (await queue.getJob(matchingJobId(USER)))!.getState()).toBe("waiting");
  });
  it("reports running for an active job", async () => {
    await pushMatching(queue, USER);
    let release!: () => void;
    const worker = new Worker<MatchingJobData>(queue.name, () => new Promise<void>((r) => (release = r)), { connection: redis.duplicate() });
    await new Promise<void>((resolve) => worker.on("active", () => resolve()));
    expect(await pushMatching(queue, USER)).toBe("running");
    release();
    await worker.close();
  });
});

describe("requestRematch / takeRematchFlag", () => {
  it("queues a debounced run when idle, without a flag", async () => {
    expect(await requestRematch({ redis, queue }, USER, 120_000)).toBe("enqueued");
    expect(await redis.get(rematchFlagKey(USER))).toBeNull();
  });
  it("sets the flag while a run is active, and the flag is taken once", async () => {
    await queue.add(MATCHING_JOB_NAME, { userId: USER }, { jobId: matchingJobId(USER) });
    let release!: () => void;
    const worker = new Worker<MatchingJobData>(queue.name, () => new Promise<void>((r) => (release = r)), { connection: redis.duplicate() });
    await new Promise<void>((resolve) => worker.on("active", () => resolve()));
    expect(await requestRematch({ redis, queue }, USER, 120_000)).toBe("running");
    expect(await takeRematchFlag(redis, USER)).toBe(true);
    expect(await takeRematchFlag(redis, USER)).toBe(false);
    release();
    await worker.close();
  });
});
