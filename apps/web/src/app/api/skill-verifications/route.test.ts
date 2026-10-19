import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData } from "../../../test/jobsDb";

const USER = "00000000-0000-0000-0000-000000000d17";
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000d17",
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

const { PUT } = await import("./route");
const put = (body: unknown) => PUT(new Request("http://x/api/skill-verifications", {
  method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
}));
const rows = () => admin`SELECT term_key, term_display, status, evidence, alias_skill_name FROM skill_verifications WHERE user_id = ${USER} ORDER BY term_key`;

describe("PUT /api/skill-verifications (Phase 13b)", () => {
  it("stores answers for punctuated terms under their normalized key", async () => {
    expect((await put({ status: "have", termDisplay: "CI/CD", evidence: "Set up GitHub Actions." })).status).toBe(200);
    expect((await put({ status: "dont_have", termDisplay: "C#" })).status).toBe(200);
    expect(await rows()).toEqual([
      { term_key: "c#", term_display: "C#", status: "dont_have", evidence: null, alias_skill_name: null },
      { term_key: "ci/cd", term_display: "CI/CD", status: "have", evidence: "Set up GitHub Actions.", alias_skill_name: null },
    ]);
  });

  it("replaces an earlier answer for the same term (last write wins)", async () => {
    await put({ status: "dont_have", termDisplay: "Kubernetes" });
    const res = await put({ status: "have", termDisplay: "kubernetes", evidence: "Ran staging." });
    expect(await res.json()).toMatchObject({ verification: { termKey: "kubernetes", status: "have", evidence: "Ran staging." } });
    expect(await rows()).toHaveLength(1);
  });

  it("stores an alias with the profile's spelling, and refuses a skill not in the profile", async () => {
    await admin`INSERT INTO skills (user_id, name) VALUES (${USER}, 'Postgres')`;
    expect((await put({ status: "alias", termDisplay: "PostgreSQL", aliasSkillName: "postgres" })).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ alias_skill_name: "Postgres" });
    expect((await put({ status: "alias", termDisplay: "MySQL", aliasSkillName: "MariaDB" })).status).toBe(422);
  });

  it("answers 400 for invalid JSON or an invalid body", async () => {
    expect((await put("{nope")).status).toBe(400);
    expect((await put({ status: "have", termDisplay: "K8s" })).status).toBe(400);
  });
});
