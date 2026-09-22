import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, type Worker } from "bullmq";
import type Anthropic from "@anthropic-ai/sdk";
import { openTestDb, wipeUser, type TestDb } from "@ai-career/matching/testing";
import { MATCHING_JOB_NAME, matchingJobId, type MatchingJobData, type RunMatchingEnv } from "@ai-career/matching";
import { createMatchingWorker } from "./worker";

const USER = "00000000-0000-0000-0000-0000000000a9";
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };
const queueName = `matching-test-${randomUUID()}`;

const ENV: RunMatchingEnv = {
  ANTHROPIC_MODEL_FAST: "test-model", EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "k", VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  MATCHING_EXPLAIN_TOP_N: 0, MATCHING_EXPERIENCE_GRACE_YEARS: 1, MATCHING_FRESHNESS_HALF_LIFE_HOURS: 168, MATCHING_EXPLANATION_TTL_DAYS: 7,
};
const anthropicClient: Pick<Anthropic, "messages"> = { messages: { create: vi.fn() } as unknown as Anthropic["messages"] };

let t: TestDb;
let queue: Queue<MatchingJobData>;
let events: QueueEvents;
let worker: Worker<MatchingJobData>;

beforeAll(async () => {
  t = await openTestDb();
  queue = new Queue<MatchingJobData>(queueName, { connection });
  events = new QueueEvents(queueName, { connection });
  await events.waitUntilReady();
  worker = createMatchingWorker({ connection, db: t.db, anthropicClient, env: ENV, queueName });
  await worker.waitUntilReady();
});
beforeEach(() => wipeUser(t.adminSql, USER));
afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const enqueue = (userId: string, opts: Record<string, unknown> = {}) =>
  queue.add(MATCHING_JOB_NAME, { userId }, { jobId: matchingJobId(userId), ...opts });

describe("matching worker", () => {
  it("runs an enqueued user's matching pass end to end", async () => {
    const [goal] = await t.adminSql`
      INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
      VALUES (${USER}, 'goal', 1, 'parsed', 'confirmed', true) RETURNING id`;
    await t.adminSql`INSERT INTO career_goal_constraints (user_id, career_goal_id) VALUES (${USER}, ${goal.id})`;
    await t.adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, status, first_seen_at, last_verified_at)
      VALUES (${USER}, 'Acme', 'acme', 'Engineer', 'engineer', 'dh', 'open', now(), now())`;

    // removeOnComplete: production enqueues with MATCHING_JOB_OPTIONS (which sets this), and without
    // it the completed job would keep occupying this deterministic jobId (keyed by userId only, see
    // queue.ts) and collide with the next test's enqueue of the same USER.
    await (await enqueue(USER, { removeOnComplete: true })).waitUntilFinished(events);

    const runs = await t.adminSql`SELECT status FROM matching_runs WHERE user_id = ${USER}`;
    expect(runs).toEqual([{ status: "completed" }]);
  });

  it("does not retry a permanent failure (no active career goal)", async () => {
    const job = await enqueue(USER, { attempts: 3, backoff: { type: "fixed", delay: 10 }, removeOnFail: false });
    await expect(job.waitUntilFinished(events)).rejects.toThrow("no_active_goal");
    expect(await job.getState()).toBe("failed");
    // The state/message alone would also pass after 3 exhausted retries with the same error, so
    // assert attemptsMade directly to prove UnrecoverableError actually skipped the retries.
    expect((await queue.getJob(matchingJobId(USER)))?.attemptsMade).toBe(1);
  });
});
