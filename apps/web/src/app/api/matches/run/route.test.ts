import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertCareerGoal } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000c1",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379",
  }),
}));
vi.mock("../../../../lib/matching/enqueue", () => ({ enqueueMatching: vi.fn() }));
import { enqueueMatching } from "../../../../lib/matching/enqueue";

const USER = "00000000-0000-0000-0000-0000000000c1";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  vi.mocked(enqueueMatching).mockReset().mockResolvedValue("enqueued");
  await wipeMatchingData(admin, USER);
});
afterAll(async () => {
  await wipeMatchingData(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");
const run = () => POST(new Request("http://localhost/api/matches/run", { method: "POST" }));

describe("POST /api/matches/run", () => {
  it("queues a run when a confirmed active career goal exists and answers 202", async () => {
    await insertCareerGoal(admin, USER);
    const res = await run();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(enqueueMatching).toHaveBeenCalledWith(expect.objectContaining({ REDIS_URL: "redis://localhost:6379" }), USER);
  });

  it("answers 409 without queueing when there is no confirmed active career goal", async () => {
    const res = await run();
    expect(res.status).toBe(409);
    expect(enqueueMatching).not.toHaveBeenCalled();
  });

  it("answers 409 without queueing when the only goal is a draft", async () => {
    await insertCareerGoal(admin, USER, { confirmationStatus: "draft", isActive: false });
    const res = await run();
    expect(res.status).toBe(409);
    expect(enqueueMatching).not.toHaveBeenCalled();
  });

  it("answers 409 when a run is already queued or active", async () => {
    vi.mocked(enqueueMatching).mockResolvedValue("already_queued");
    await insertCareerGoal(admin, USER);
    const res = await run();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already queued or running/);
  });

  it("answers 503 with a fixed message when the queue is unavailable, never echoing the error", async () => {
    vi.mocked(enqueueMatching).mockRejectedValue(new Error("ECONNREFUSED secret-host:6379"));
    await insertCareerGoal(admin, USER);
    const res = await run();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "The job queue is unavailable. Is Redis running?" });
    expect(text).not.toContain("secret-host");
  });
});
