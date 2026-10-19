import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { MATCHING_JOB_NAME, matchingJobId, type MatchingJobData } from "./queue";
import { flagRematchIfRunning, pushMatching, REMATCH_FLAG_TTL_SECONDS, rematchFlagKey, requestRematch, takeRematchFlag } from "./enqueue";

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

describe("pushMatching promote race", () => {
  it("reports running when the job became active between the state read and promote", async () => {
    const job = {
      getState: vi.fn().mockResolvedValueOnce("delayed").mockResolvedValueOnce("active"),
      promote: vi.fn().mockRejectedValue(new Error("Job is not in the delayed state")),
    };
    const fakeQueue = { getJob: vi.fn(async () => job) };
    expect(await pushMatching(fakeQueue as never, USER, { promoteDelayed: true })).toBe("running");
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

describe("flagRematchIfRunning (Phase 13a review)", () => {
  const fakeRedis = () => {
    const store = new Map<string, string>();
    return {
      store,
      set: vi.fn(async (key: string, value: string) => { store.set(key, value); return "OK" as const; }),
      del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    };
  };

  it("passes a non-running result through without a flag", async () => {
    const r = fakeRedis();
    const fakeQueue = { getJob: vi.fn(), add: vi.fn() };
    expect(await flagRematchIfRunning({ redis: r as never, queue: fakeQueue as never }, USER, "enqueued")).toBe("enqueued");
    expect(r.set).not.toHaveBeenCalled();
    expect(fakeQueue.getJob).not.toHaveBeenCalled();
  });

  it("sets the flag for an hour and keeps it while the run is still there", async () => {
    const r = fakeRedis();
    const fakeQueue = { getJob: vi.fn(async () => ({ id: matchingJobId(USER) })), add: vi.fn() };
    expect(await flagRematchIfRunning({ redis: r as never, queue: fakeQueue as never }, USER, "running")).toBe("running");
    expect(r.set).toHaveBeenCalledWith(rematchFlagKey(USER), "1", "EX", REMATCH_FLAG_TTL_SECONDS);
    expect(REMATCH_FLAG_TTL_SECONDS).toBe(3600);
    expect(r.store.has(rematchFlagKey(USER))).toBe(true);
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it("closes the window: a run that finished before the flag was set is followed by a new run now", async () => {
    const r = fakeRedis();
    // The running job finished (and was removed) between pushMatching's state read and the flag write.
    const fakeQueue = { getJob: vi.fn(async () => null), add: vi.fn(async () => ({})) };
    expect(await flagRematchIfRunning({ redis: r as never, queue: fakeQueue as never }, USER, "running")).toBe("enqueued");
    expect(r.store.has(rematchFlagKey(USER))).toBe(false);
    expect(fakeQueue.add).toHaveBeenCalledTimes(1);
    expect(fakeQueue.add).toHaveBeenCalledWith(MATCHING_JOB_NAME, { userId: USER }, expect.objectContaining({ jobId: matchingJobId(USER) }));
  });

  it("does not queue twice when the worker's follow-up already took the flag", async () => {
    const r = fakeRedis();
    r.del.mockResolvedValueOnce(0);
    const fakeQueue = { getJob: vi.fn(async () => null), add: vi.fn(async () => ({})) };
    expect(await flagRematchIfRunning({ redis: r as never, queue: fakeQueue as never }, USER, "running")).toBe("running");
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });
});
