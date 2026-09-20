import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000011",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ??
      "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../../../../../packages/db/migrations");
const adminSql = postgres(
  process.env.TEST_MIGRATIONS_DATABASE_URL ??
    "postgres://career_intel:career_intel@localhost:5432/career_intel_test"
);
// Must match the DEFAULT_USER_ID in the @ai-career/config mock above.
const TEST_USER_ID = "00000000-0000-0000-0000-000000000011";

beforeAll(async () => {
  await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
  // Same pattern as packages/db/src/profileTables.rls.test.ts's beforeAll --
  // this local Postgres container persists across runs (unlike CI's fresh
  // service container), so tests asserting empty state (activeGoal: null,
  // history: []) need a clean slate. Scoped to this file's own
  // TEST_USER_ID (rather than a blanket DELETE) because vitest runs test
  // files in parallel by default and parse/route.test.ts +
  // confirm/route.test.ts share these same two tables under different
  // user ids -- an unscoped DELETE here can race with and wipe rows those
  // files' own tests just inserted. Delete the FK-child table first.
  await adminSql`DELETE FROM career_goal_constraints WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM career_goals WHERE user_id = ${TEST_USER_ID}`;
});

afterAll(async () => {
  await adminSql.end();
});

const { GET } = await import("./route");

describe("GET /api/career-goal", () => {
  it("returns activeGoal: null and an empty history when nothing is confirmed yet", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.activeGoal).toBeNull();
    expect(body.history).toEqual([]);
  });

  it("returns the active goal's constraints and full version history once confirmed", async () => {
    const [goal] = await adminSql`
      INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active, confirmed_at)
      VALUES ('00000000-0000-0000-0000-000000000011', 'Data jobs in Germany', 1, 'parsed', 'confirmed', true, now())
      RETURNING id
    `;
    await adminSql`
      INSERT INTO career_goal_constraints (user_id, career_goal_id, target_roles)
      VALUES ('00000000-0000-0000-0000-000000000011', ${goal.id}, ARRAY['Data Engineer'])
    `;

    const res = await GET();
    const body = await res.json();

    expect(body.activeGoal.rawText).toBe("Data jobs in Germany");
    expect(body.activeGoal.constraints.targetRoles).toEqual(["Data Engineer"]);
    expect(body.history).toHaveLength(1);
  });

  it("returns the preferred salary alongside the minimum, coerced from numeric to number", async () => {
    await adminSql`
      UPDATE career_goal_constraints SET
        salary_floor_normalized = 60000, salary_currency = 'EUR', salary_is_parsed = true,
        salary_target_raw = 'ideally 80k EUR', salary_target_normalized = 80000,
        salary_target_currency = 'EUR', salary_target_is_parsed = true
      WHERE user_id = ${TEST_USER_ID}
    `;

    const body = await (await GET()).json();

    expect(body.activeGoal.constraints).toMatchObject({
      salaryFloorNormalized: 60000,
      salaryTargetRaw: "ideally 80k EUR",
      salaryTargetNormalized: 80000,
      salaryTargetCurrency: "EUR",
      salaryTargetIsParsed: true,
    });
  });

  it("fails loudly, rather than showing 'no goal', when the active goal has lost its constraints row", async () => {
    await adminSql`DELETE FROM career_goal_constraints WHERE user_id = ${TEST_USER_ID}`;

    await expect(GET()).rejects.toThrow(/has no constraints/i);
  });
});
