import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeJobData, insertSource } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b3",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379",
  }),
}));
vi.mock("../../../../../lib/job-ingestion/enqueue", () => ({ enqueueIngestion: vi.fn() }));

import { enqueueIngestion } from "../../../../../lib/job-ingestion/enqueue";

const USER = "00000000-0000-0000-0000-0000000000b3";
const OTHER_USER = "00000000-0000-0000-0000-0000000000c3";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  vi.mocked(enqueueIngestion).mockReset().mockResolvedValue("enqueued");
  await wipeJobData(admin, USER);
  await wipeJobData(admin, OTHER_USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await wipeJobData(admin, OTHER_USER);
  await admin.end();
});

const { POST } = await import("./route");
const run = (id: string) => POST(new Request(`http://localhost/api/job-sources/${id}/run`, { method: "POST" }), { params: Promise.resolve({ id }) });

describe("POST /api/job-sources/[id]/run", () => {
  it("queues an enabled, consented source and answers 202", async () => {
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    const res = await run(id);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(enqueueIngestion).toHaveBeenCalledWith(expect.objectContaining({ REDIS_URL: "redis://localhost:6379" }), id);
  });

  it("answers 409 without queueing when the source is disabled or has no consent", async () => {
    const disabled = await insertSource(admin, USER, { enabled: false, consent: true });
    const noConsent = await insertSource(admin, USER, { enabled: true, consent: false });
    expect((await run(disabled)).status).toBe(409);
    expect((await run(noConsent)).status).toBe(409);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });

  it("answers 409 when a run is already queued or active", async () => {
    vi.mocked(enqueueIngestion).mockResolvedValue("already_queued");
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    const res = await run(id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already queued or running/);
  });

  it("answers 404 for an unknown or malformed id, without queueing", async () => {
    expect((await run("00000000-0000-0000-0000-00000000ffff")).status).toBe(404);
    expect((await run("nope")).status).toBe(404);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });

  it("answers 404 for a source owned by another user, without queueing", async () => {
    const foreign = await insertSource(admin, OTHER_USER, { enabled: true, consent: true });
    expect((await run(foreign)).status).toBe(404);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });

  it("answers 503 with a fixed message when the queue is unavailable, never echoing the error", async () => {
    vi.mocked(enqueueIngestion).mockRejectedValue(new Error("ECONNREFUSED secret-host:6379"));
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    const res = await run(id);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "The job queue is unavailable. Is Redis running?" });
    expect(text).not.toContain("secret-host");
  });

  it("allows re-running an upload source (it reprocesses the stored records)", async () => {
    const id = await insertSource(admin, USER, { kind: "upload", enabled: true, consent: true });
    expect((await run(id)).status).toBe(202);
  });
});
