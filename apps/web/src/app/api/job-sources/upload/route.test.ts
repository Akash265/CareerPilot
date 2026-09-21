import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeJobData } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b4",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379",
  }),
}));
vi.mock("../../../../lib/job-ingestion/enqueue", () => ({ enqueueIngestion: vi.fn() }));
// Real storeUpload by default; one test wraps it to fail AFTER it has written, to prove the transaction rolls back.
vi.mock("@ai-career/ingestion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-career/ingestion")>();
  return { ...actual, storeUpload: vi.fn(actual.storeUpload) };
});

import { storeUpload } from "@ai-career/ingestion";
import { enqueueIngestion } from "../../../../lib/job-ingestion/enqueue";

const USER = "00000000-0000-0000-0000-0000000000b4";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  vi.mocked(enqueueIngestion).mockReset().mockResolvedValue("enqueued");
  await wipeJobData(admin, USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");
const CSV = "title,company,location\nData Engineer,Acme,Berlin\nAnalyst,Beta,Paris";

function upload(opts: { content?: string | ArrayBuffer; name?: string; consent?: string | null; headers?: Record<string, string> } = {}) {
  const form = new FormData();
  if (opts.content !== null) {
    form.set("file", new File([opts.content ?? CSV], opts.name ?? "jobs.csv"));
  }
  if (opts.consent !== null) form.set("consentConfirmed", opts.consent ?? "true");
  return new Request("http://localhost/api/job-sources/upload", { method: "POST", body: form, headers: opts.headers });
}
const sourceCount = async () => (await admin`SELECT count(*)::int AS n FROM job_sources WHERE user_id = ${USER}`)[0].n;
const rawCount = async () => (await admin`SELECT count(*)::int AS n FROM raw_job_postings WHERE user_id = ${USER}`)[0].n;
const MAX_BYTES = 10 * 1024 * 1024;

describe("POST /api/job-sources/upload", () => {
  it("stores the file as an enabled, consented upload source and queues it", async () => {
    const res = await POST(upload());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ count: 2, queued: true });

    const [source] = await admin`SELECT kind, label, enabled, consent_confirmed_at FROM job_sources WHERE id = ${body.sourceId}`;
    expect(source).toMatchObject({ kind: "upload", label: "jobs.csv", enabled: true });
    expect(source.consent_confirmed_at).not.toBeNull();
    expect((await admin`SELECT count(*)::int AS n FROM raw_job_postings WHERE source_id = ${body.sourceId}`)[0].n).toBe(2);
    expect(enqueueIngestion).toHaveBeenCalledWith(expect.objectContaining({ REDIS_URL: "redis://localhost:6379" }), body.sourceId);
  });

  it("still succeeds, reporting queued: false, when the queue is unreachable", async () => {
    vi.mocked(enqueueIngestion).mockRejectedValue(new Error("redis down"));
    const res = await POST(upload());
    expect(res.status).toBe(201);
    expect((await res.json()).queued).toBe(false);
    expect(await sourceCount()).toBe(1);
  });

  it("requires the consent confirmation and stores nothing without it (D3)", async () => {
    for (const consent of [null, "false", "yes"]) {
      const res = await POST(upload({ consent }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/permitted to use/);
    }
    expect(await sourceCount()).toBe(0);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });

  it("answers 400 with the parser's user-safe message for an invalid file, and stores nothing", async () => {
    const noCompany = await POST(upload({ content: "title,company\nAnalyst,\n" }));
    expect(noCompany.status).toBe(400);
    expect((await noCompany.json()).error).toMatch(/each needs a title and a company/);
    expect((await POST(upload({ content: new Uint8Array([0x50, 0x4b, 0x00, 0x03]).buffer }))).status).toBe(400);
    expect((await POST(upload({ name: "jobs.txt" }))).status).toBe(400);
    expect(await sourceCount()).toBe(0);
  });

  it("answers 400 when no file is attached, or the body is not multipart", async () => {
    expect((await POST(upload({ content: null as unknown as string }))).status).toBe(400);
    const notForm = new Request("http://localhost/api/job-sources/upload", { method: "POST", body: "plain text" });
    expect((await POST(notForm)).status).toBe(400);
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const res = await POST(upload({ headers: { "content-length": String(11 * 1024 * 1024) } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/10MB/);
    expect(await sourceCount()).toBe(0);
  });

  it("reports queued: false for the queue's real fixed failure and never echoes it", async () => {
    vi.mocked(enqueueIngestion).mockRejectedValue(new Error("queue unavailable"));
    const res = await POST(upload());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ sourceId: expect.any(String), count: 2, queued: false });
    expect(await sourceCount()).toBe(1);
    expect(await rawCount()).toBe(2);
  });

  it("rejects a CSV with more than 5,000 rows, storing and queueing nothing", async () => {
    const rows = Array.from({ length: 5001 }, (_, i) => `Engineer ${i},Acme,Berlin`).join("\n");
    const res = await POST(upload({ content: `title,company,location\n${rows}` }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "File has more than 5,000 rows" });
    expect(await sourceCount()).toBe(0);
    expect(await rawCount()).toBe(0);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });

  it("accepts exactly 5,000 rows", async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => `Engineer ${i},Acme,Berlin`).join("\n");
    const res = await POST(upload({ content: `title,company,location\n${rows}` }));
    expect(res.status).toBe(201);
    expect((await res.json()).count).toBe(5000);
    expect(await rawCount()).toBe(5000);
  });

  it("rejects a file over 10MB by its real size even when Content-Length is not declared", async () => {
    const res = await POST(upload({ content: "a".repeat(MAX_BYTES + 1) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "File exceeds 10MB limit" });
    expect(await sourceCount()).toBe(0);
    expect(await rawCount()).toBe(0);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });

  it("does not queue a rejected upload", async () => {
    const res = await POST(upload({ content: "title,company\nAnalyst,\n" }));
    expect(res.status).toBe(400);
    expect(enqueueIngestion).not.toHaveBeenCalled();
    expect(await sourceCount()).toBe(0);
    expect(await rawCount()).toBe(0);
  });

  it("rolls back the source and raw rows, and does not queue, when storing fails after writing", async () => {
    vi.mocked(storeUpload).mockImplementationOnce(async (tx, input) => {
      await vi.importActual<typeof import("@ai-career/ingestion")>("@ai-career/ingestion").then((m) => m.storeUpload(tx, input));
      throw new Error("secret-internal-detail");
    });
    // The route lets the error propagate: Next.js turns that into a bare 500, so no response body exists to leak it.
    await expect(POST(upload())).rejects.toThrow("secret-internal-detail");
    expect(await sourceCount()).toBe(0);
    expect(await rawCount()).toBe(0);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });
});
