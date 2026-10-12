import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeJobData, insertSource } from "../../../test/jobsDb";

// Phase 12 test user (…0d05), verified unused repo-wide on 2026-10-12.
const USER = "00000000-0000-0000-0000-000000000d05";
const keys = { ADZUNA_APP_ID: undefined as string | undefined, ADZUNA_APP_KEY: undefined as string | undefined };
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000d05",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    ...keys, JOOBLE_API_KEY: undefined, USAJOBS_API_KEY: "u", USAJOBS_USER_AGENT: "me@example.com",
    RATE_LIMIT_AI_PER_MINUTE: 0, RATE_LIMIT_JOBS_PER_MINUTE: 0,
  }),
}));

let admin: postgres.Sql;
const wipe = async () => {
  await admin`DELETE FROM discovered_boards WHERE user_id = ${USER}`;
  await admin`DELETE FROM discovery_settings WHERE user_id = ${USER}`;
  await wipeJobData(admin, USER);
};
beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipe();
  keys.ADZUNA_APP_ID = undefined;
  keys.ADZUNA_APP_KEY = undefined;
});
afterAll(async () => {
  await wipe();
  await admin.end();
});

const { GET } = await import("./route");
const { PUT: putSettings } = await import("./settings/route");
const { PUT: putProvider } = await import("./providers/[kind]/route");
const { POST: postBoards } = await import("./boards/route");
const json = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });
const view = async () => (await GET()).json();
const settings = (body: unknown) => putSettings(new Request("http://localhost/api/discovery/settings", json(body)));
const provider = (kind: string, enabled: boolean) =>
  putProvider(new Request(`http://localhost/api/discovery/providers/${kind}`, json({ enabled })), { params: Promise.resolve({ kind }) });
const paste = (text: string) => postBoards(new Request("http://localhost/api/discovery/boards", { method: "POST", body: JSON.stringify({ text }) }));
const consent = () => settings({ consent: true, autoDiscover: true });

describe("GET /api/discovery (Phase 12)", () => {
  it("starts without consent, lists every search provider with its key status, and no boards", async () => {
    const v = await view();
    expect(v.settings).toEqual({ consentedAt: null, autoDiscover: false });
    expect(v.providers.map((p: { kind: string }) => p.kind)).toEqual(["remotive", "remoteok", "arbeitnow", "themuse", "hn_hiring", "adzuna", "jooble", "usajobs"]);
    expect(v.providers.find((p: { kind: string }) => p.kind === "adzuna")).toMatchObject({ label: "Adzuna", keyRequired: true, keyConfigured: false, enabled: false });
    expect(v.providers.find((p: { kind: string }) => p.kind === "usajobs")).toMatchObject({ keyRequired: true, keyConfigured: true });
    expect(v.providers.find((p: { kind: string }) => p.kind === "remotive")).toMatchObject({ keyRequired: false, keyConfigured: true });
    expect(v.boards).toEqual({ counts: { pending: 0, enabled: 0, rejected: 0, gone: 0 }, recent: [] });
  });
});

describe("PUT /api/discovery/settings", () => {
  it("records the standing consent once, and switches auto-discovery", async () => {
    expect((await consent()).status).toBe(200);
    const first = (await view()).settings;
    expect(first.autoDiscover).toBe(true);
    expect(Date.parse(first.consentedAt)).toBeGreaterThan(Date.now() - 60_000);
    await settings({ consent: true, autoDiscover: true });
    expect((await view()).settings.consentedAt).toBe(first.consentedAt);
  });

  it("refuses auto-discovery without consent, and rejects a malformed body", async () => {
    expect((await settings({ consent: false, autoDiscover: true })).status).toBe(400);
    expect((await settings({ consent: "yes" })).status).toBe(400);
  });

  it("disables discovered sources when auto-discovery is switched off, and every discovery source when consent is withdrawn", async () => {
    await consent();
    const discovered = await insertSource(admin, USER, { enabled: true });
    await admin`UPDATE job_sources SET origin = 'discovered' WHERE id = ${discovered}`;
    const manual = await insertSource(admin, USER, { enabled: true, slug: "mine" });
    await provider("remotive", true);
    await settings({ consent: true, autoDiscover: false });
    const enabled = async () => Object.fromEntries((await admin`SELECT origin, enabled FROM job_sources WHERE user_id = ${USER}`).map((r) => [r.origin, r.enabled]));
    expect(await enabled()).toEqual({ discovered: false, manual: true, search: true });
    await settings({ consent: false, autoDiscover: false });
    expect(await enabled()).toEqual({ discovered: false, manual: true, search: false });
    expect((await view()).settings.consentedAt).toBeNull();
    void manual;
  });

  it("re-enables the boards it disabled when auto-discovery is switched back on, but not ones that are gone (review fix)", async () => {
    await consent();
    const live = await insertSource(admin, USER, { enabled: true, consent: true, slug: "live" });
    const gone = await insertSource(admin, USER, { enabled: false, consent: true, slug: "gone" });
    await admin`UPDATE job_sources SET origin = 'discovered' WHERE id IN (${live}, ${gone})`;
    await admin`INSERT INTO discovered_boards (user_id, kind, slug, status, source_id) VALUES
                (${USER}, 'greenhouse', 'live', 'enabled', ${live}), (${USER}, 'greenhouse', 'gone', 'gone', ${gone})`;
    await settings({ consent: true, autoDiscover: false });
    await settings({ consent: true, autoDiscover: true });
    const rows = Object.fromEntries((await admin`SELECT config->>'slug' AS slug, enabled FROM job_sources WHERE user_id = ${USER}`).map((r) => [r.slug, r.enabled]));
    expect(rows).toEqual({ live: true, gone: false });
  });
});

describe("PUT /api/discovery/providers/[kind]", () => {
  it("needs the standing consent first (409)", async () => {
    const res = await provider("remotive", true);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/permission/i);
  });

  it("creates one consented search source per provider, and toggles it", async () => {
    await consent();
    expect((await provider("remotive", true)).status).toBe(200);
    await provider("remotive", false);
    await provider("remotive", true);
    const rows = await admin`SELECT kind, origin, label, enabled, consent_confirmed_at IS NOT NULL AS consented FROM job_sources WHERE user_id = ${USER}`;
    expect(rows).toEqual([{ kind: "remotive", origin: "search", label: "Remotive", enabled: true, consented: true }]);
    expect((await view()).providers.find((p: { kind: string }) => p.kind === "remotive")).toMatchObject({ enabled: true });
  });

  it("refuses a provider whose key is not configured (400) and an unknown provider (404)", async () => {
    await consent();
    const res = await provider("adzuna", true);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ADZUNA_APP_ID/);
    expect((await provider("greenhouse", true)).status).toBe(404);
    expect((await provider("nope", true)).status).toBe(404);
  });

  it("lets a provider be switched off even after its key was removed", async () => {
    await consent();
    keys.ADZUNA_APP_ID = "id";
    keys.ADZUNA_APP_KEY = "key";
    await provider("adzuna", true);
    keys.ADZUNA_APP_ID = undefined;
    expect((await provider("adzuna", false)).status).toBe(200);
  });
});

describe("POST /api/discovery/boards", () => {
  it("needs consent (409), then records each new board once as pending, skipping ones already added", async () => {
    expect((await paste("https://jobs.ashbyhq.com/linear")).status).toBe(409);
    await consent();
    await insertSource(admin, USER, { slug: "gitlab" });
    const res = await paste("https://jobs.ashbyhq.com/linear\nhttps://boards.greenhouse.io/gitlab\nhttps://apply.workable.com/huggingface/ and https://jobs.ashbyhq.com/Linear\nnot a link");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recognized: 3, added: 2 });
    const boards = await admin`SELECT kind, slug, status, found_via_source_id FROM discovered_boards WHERE user_id = ${USER} ORDER BY slug`;
    expect(boards).toEqual([
      { kind: "workable", slug: "huggingface", status: "pending", found_via_source_id: null },
      { kind: "ashby", slug: "linear", status: "pending", found_via_source_id: null },
    ]);
    const v = await view();
    expect(v.boards.counts.pending).toBe(2);
    expect(v.boards.recent.map((b: { slug: string }) => b.slug).sort()).toEqual(["huggingface", "linear"]);
  });

  it("rejects an empty or oversized paste", async () => {
    await consent();
    expect((await paste("")).status).toBe(400);
    expect((await paste("x".repeat(100_001))).status).toBe(400);
  });
});
