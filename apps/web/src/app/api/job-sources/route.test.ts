import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeJobData, insertSource } from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b1",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000b1";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeJobData(admin, USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await admin.end();
});

const { GET, POST } = await import("./route");
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/job-sources", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("GET /api/job-sources", () => {
  it("returns an empty list when nothing is on the watch-list", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sources: [] });
  });

  it("lists sources newest first with each one's latest run", async () => {
    const older = await insertSource(admin, USER, { label: "Older", slug: "older" });
    const newer = await insertSource(admin, USER, { label: "Newer", slug: "newer", enabled: true, consent: true });
    await admin`INSERT INTO ingestion_runs (user_id, source_id, started_at, status, complete, fetched_count, new_count, closed_count)
                VALUES (${USER}, ${newer}, '2026-09-20T10:00:00Z', 'succeeded', true, 5, 4, 1)`;
    await admin`INSERT INTO ingestion_runs (user_id, source_id, started_at, status, complete, fetched_count, new_count)
                VALUES (${USER}, ${newer}, '2026-09-21T10:00:00Z', 'succeeded', true, 7, 2)`;
    await admin`UPDATE job_sources SET created_at = now() - interval '1 day' WHERE id = ${older}`;

    const { sources } = await (await GET()).json();
    expect(sources.map((s: { label: string }) => s.label)).toEqual(["Newer", "Older"]);
    expect(sources[0]).toMatchObject({ kind: "greenhouse", slug: "newer", enabled: true });
    expect(sources[0].consentConfirmedAt).not.toBeNull();
    expect(sources[0].lastRun).toEqual({ complete: true, fetched: 7, created: 2, updated: 0, unchanged: 0, closed: 0, failed: 0 });
    expect(sources[1].lastRun).toBeNull();
  });
});

describe("POST /api/job-sources", () => {
  it("creates a disabled, unconsented board, labelled by its company name when given", async () => {
    const res = await post({ kind: "greenhouse", slug: "gitlab", companyName: "GitLab" });
    expect(res.status).toBe(201);
    const { source } = await res.json();
    expect(source).toMatchObject({ kind: "greenhouse", label: "GitLab", slug: "gitlab", companyName: "GitLab", enabled: false, consentConfirmedAt: null });
    const [row] = await admin`SELECT enabled, consent_confirmed_at FROM job_sources WHERE id = ${source.id}`;
    expect(row).toMatchObject({ enabled: false, consent_confirmed_at: null });
  });

  it("labels a board by its slug when no company name is given", async () => {
    const { source } = await (await post({ kind: "lever", slug: "spotify" })).json();
    expect(source).toMatchObject({ label: "spotify", companyName: null });
  });

  it("answers 409 for the same board twice, case-insensitively", async () => {
    expect((await post({ kind: "lever", slug: "spotify" })).status).toBe(201);
    const res = await post({ kind: "lever", slug: "SPOTIFY" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already on your list/);
    expect((await post({ kind: "greenhouse", slug: "spotify" })).status).toBe(201); // a different kind is a different board
  });

  it("answers 400 for a bad kind, an unsafe slug, and malformed JSON", async () => {
    expect((await post({ kind: "upload", slug: "x" })).status).toBe(400);
    expect((await post({ kind: "lever", slug: "../etc/passwd" })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
  });
});
