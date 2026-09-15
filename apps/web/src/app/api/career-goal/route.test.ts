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

beforeAll(async () => {
  await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
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
});
