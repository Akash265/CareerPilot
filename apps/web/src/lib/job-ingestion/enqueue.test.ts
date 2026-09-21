import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import net from "node:net";
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

  it("rejects promptly with a fixed message when Redis is unreachable, never leaking the URL", async () => {
    const started = Date.now();
    const error = await enqueueIngestion({ REDIS_URL: "redis://127.0.0.1:1" }, randomUUID(), queueName).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("queue unavailable");
    expect(String(error?.stack)).not.toContain("127.0.0.1");
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15000);

  it("gives up after its overall guard when Redis accepts the connection but never answers", async () => {
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as net.AddressInfo;
    try {
      const started = Date.now();
      await expect(enqueueIngestion({ REDIS_URL: `redis://127.0.0.1:${port}` }, randomUUID(), queueName)).rejects.toThrow(
        /^queue unavailable$/
      );
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => silent.close(resolve));
    }
  }, 15000);
});
