import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeJobData, insertSource } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b2",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000b2";
const OTHER_USER = "00000000-0000-0000-0000-0000000000c2";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeJobData(admin, USER);
  await wipeJobData(admin, OTHER_USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await wipeJobData(admin, OTHER_USER);
  await admin.end();
});

const { PATCH } = await import("./route");
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://localhost/api/job-sources/${id}`, { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
const row = async (id: string) => (await admin`SELECT enabled, consent_confirmed_at FROM job_sources WHERE id = ${id}`)[0];

describe("PATCH /api/job-sources/[id]", () => {
  it("refuses to enable a source until the Terms-of-Service confirmation is given (D3), and changes nothing", async () => {
    const id = await insertSource(admin, USER);
    for (const body of [{ enabled: true }, { enabled: true, consentConfirmed: false }]) {
      const res = await patch(id, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Terms of Service/);
    }
    expect(await row(id)).toMatchObject({ enabled: false, consent_confirmed_at: null });
  });

  it("enables with the confirmation and records when it was given", async () => {
    const id = await insertSource(admin, USER);
    const res = await patch(id, { enabled: true, consentConfirmed: true });
    expect(res.status).toBe(200);
    expect((await res.json()).source).toMatchObject({ id, enabled: true });
    const after = await row(id);
    expect(after.enabled).toBe(true);
    expect(after.consent_confirmed_at).not.toBeNull();
  });

  it("keeps the confirmation when disabling, and re-enabling does not ask again", async () => {
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    const before = (await row(id)).consent_confirmed_at;

    expect((await patch(id, { enabled: false })).status).toBe(200);
    expect(await row(id)).toMatchObject({ enabled: false });
    expect((await row(id)).consent_confirmed_at).toEqual(before);

    expect((await patch(id, { enabled: true })).status).toBe(200);
    expect(await row(id)).toMatchObject({ enabled: true });
  });

  it("does not change the recorded confirmation when re-enabling with consentConfirmed again", async () => {
    const id = await insertSource(admin, USER, { enabled: false, consent: true });
    const before = (await row(id)).consent_confirmed_at;
    expect((await patch(id, { enabled: true, consentConfirmed: true })).status).toBe(200);
    const after = await row(id);
    expect(after.enabled).toBe(true);
    expect(after.consent_confirmed_at).toEqual(before);
  });

  it("answers 404 for a source owned by another user, and leaves it untouched", async () => {
    const foreign = await insertSource(admin, OTHER_USER);
    expect((await patch(foreign, { enabled: true, consentConfirmed: true })).status).toBe(404);
    expect(await row(foreign)).toMatchObject({ enabled: false, consent_confirmed_at: null });
  });

  it("answers 404 for an unknown or malformed id, and 400 for a bad body", async () => {
    expect((await patch("00000000-0000-0000-0000-00000000ffff", { enabled: false })).status).toBe(404);
    expect((await patch("not-a-uuid", { enabled: false })).status).toBe(404);
    const id = await insertSource(admin, USER);
    expect((await patch(id, { enabled: "yes" })).status).toBe(400);
    expect((await patch(id, "{oops")).status).toBe(400);
  });
});
