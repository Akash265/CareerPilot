import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData } from "../../../../test/jobsDb";

const USER = "00000000-0000-0000-0000-000000000d18";
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000d18",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379", SKILL_GAP_TOP_N: 25, ANTHROPIC_MODEL_FAST: "fast",
    RATE_LIMIT_AI_PER_MINUTE: 0, RATE_LIMIT_JOBS_PER_MINUTE: 0,
  }),
}));

let admin: postgres.Sql;
const wipe = async () => { await wipeMatchingData(admin, USER); await admin`DELETE FROM skills WHERE user_id = ${USER}`; };
beforeAll(async () => { admin = await openAdminDb(); });
beforeEach(wipe);
afterAll(async () => { await wipe(); await admin.end(); });

const { DELETE } = await import("./route");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("DELETE /api/skill-verifications/[id] (Phase 13b)", () => {
  it("removes an answer, then 404s", async () => {
    const [row] = await admin`
      INSERT INTO skill_verifications (user_id, term_key, term_display, status) VALUES (${USER}, 'dbt', 'dbt', 'dont_have') RETURNING id`;
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx(row.id))).status).toBe(204);
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx(row.id))).status).toBe(404);
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx("nope"))).status).toBe(404);
  });
});
