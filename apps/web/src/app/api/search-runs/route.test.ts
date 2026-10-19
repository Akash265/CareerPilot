import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData, insertCareerGoal } from "../../../test/jobsDb";

// Phase 13a test user (…0d0c); verify unused with grep first.
const USER = "00000000-0000-0000-0000-000000000d0c";
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000d0c",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379",
    RATE_LIMIT_AI_PER_MINUTE: 0, RATE_LIMIT_JOBS_PER_MINUTE: 0,
  }),
}));
vi.mock("../../../lib/searchRuns/enqueue", () => ({ enqueueSearchRun: vi.fn(async () => undefined) }));
import { enqueueSearchRun } from "../../../lib/searchRuns/enqueue";

let admin: postgres.Sql;
const consent = () => admin`INSERT INTO discovery_settings (user_id, auto_discover, consented_at) VALUES (${USER}, true, now())`;
const wipe = async () => {
  await admin`DELETE FROM discovery_settings WHERE user_id = ${USER}`;
  await wipeMatchingData(admin, USER);
};
beforeAll(async () => { admin = await openAdminDb(); });
beforeEach(async () => { vi.mocked(enqueueSearchRun).mockReset().mockResolvedValue(undefined); await wipe(); });
afterAll(async () => { await wipe(); await admin.end(); });

const { POST } = await import("./route");
const { GET } = await import("./latest/route");

describe("POST /api/search-runs (Phase 13a)", () => {
  it("asks for consent first", async () => {
    await insertCareerGoal(admin, USER);
    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "consent_required" });
    expect(enqueueSearchRun).not.toHaveBeenCalled();
  });

  it("asks for a confirmed goal", async () => {
    await consent();
    const res = await POST();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "no_active_goal" });
  });

  it("creates and queues a run, then returns the same run on a second click", async () => {
    await consent();
    await insertCareerGoal(admin, USER);
    const first = await POST();
    expect(first.status).toBe(202);
    const { run } = await first.json();
    expect(run).toMatchObject({ status: "queued", sources: [], seeding: {} });
    expect(enqueueSearchRun).toHaveBeenCalledWith(expect.anything(), run.id);
    const second = await POST();
    expect(second.status).toBe(200);
    expect((await second.json()).run.id).toBe(run.id);
    expect(enqueueSearchRun).toHaveBeenCalledTimes(1);
  });

  it("fails a stalled run and starts a fresh one", async () => {
    await consent();
    await insertCareerGoal(admin, USER);
    const [old] = await admin`INSERT INTO search_runs (user_id, status, created_at, heartbeat_at)
                              VALUES (${USER}, 'running', now() - interval '20 minutes', now() - interval '11 minutes') RETURNING id`;
    const res = await POST();
    expect(res.status).toBe(202);
    const [row] = await admin`SELECT status, error_code FROM search_runs WHERE id = ${old.id}`;
    expect(row).toEqual({ status: "failed", error_code: "stalled" });
  });

  it("answers 503 and fails the run when the queue is down", async () => {
    await consent();
    await insertCareerGoal(admin, USER);
    vi.mocked(enqueueSearchRun).mockRejectedValue(new Error("queue unavailable"));
    const res = await POST();
    expect(res.status).toBe(503);
    const rows = await admin`SELECT status, error_code FROM search_runs WHERE user_id = ${USER}`;
    expect(rows).toEqual([{ status: "failed", error_code: "queue_unavailable" }]);
  });
});

describe("GET /api/search-runs/latest", () => {
  it("returns null, then the newest run with stalled runs failed on read", async () => {
    expect(await (await GET()).json()).toEqual({ run: null });
    await admin`INSERT INTO search_runs (user_id, status, created_at) VALUES (${USER}, 'queued', now() - interval '11 minutes')`;
    const { run } = await (await GET()).json();
    expect(run).toMatchObject({ status: "failed", errorCode: "stalled" });
  });
});
