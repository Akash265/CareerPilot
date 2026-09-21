import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { INGEST_JOB_NAME, ingestJobId } from "@ai-career/ingestion";
import { enqueueIngestion } from "./enqueue";

const env = { REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379" };
const queueName = `job-ingestion-test-${randomUUID()}`;
const redisUrl = new URL(env.REDIS_URL);
const cleanup = new Queue(queueName, { connection: { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) } });

afterAll(async () => {
  await cleanup.obliterate({ force: true });
  await cleanup.close();
});

describe("enqueueIngestion", () => {
  it("enqueues once, then reports already_queued while the first is still waiting", async () => {
    const sourceId = randomUUID();
    expect(await enqueueIngestion(env, sourceId, queueName)).toBe("enqueued");
    expect(await enqueueIngestion(env, sourceId, queueName)).toBe("already_queued");

    const job = await cleanup.getJob(ingestJobId(sourceId));
    expect(job?.name).toBe(INGEST_JOB_NAME);
    expect(job?.data).toEqual({ sourceId });
    expect(job?.opts.attempts).toBe(3);
  });

  it("treats different sources independently", async () => {
    expect(await enqueueIngestion(env, randomUUID(), queueName)).toBe("enqueued");
    expect(await enqueueIngestion(env, randomUUID(), queueName)).toBe("enqueued");
  });
});
