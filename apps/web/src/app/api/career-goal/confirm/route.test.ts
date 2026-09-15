import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000010",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ??
      "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../../../../../../packages/db/migrations");
const adminSql = postgres(
  process.env.TEST_MIGRATIONS_DATABASE_URL ??
    "postgres://career_intel:career_intel@localhost:5432/career_intel_test"
);
// Must match the DEFAULT_USER_ID in the @ai-career/config mock above.
const TEST_USER_ID = "00000000-0000-0000-0000-000000000010";

beforeAll(async () => {
  await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
  // Same pattern as packages/db/src/profileTables.rls.test.ts's beforeAll --
  // this local Postgres container persists across runs (unlike CI's fresh
  // service container), so tests need a clean slate. Scoped to this file's
  // own TEST_USER_ID (rather than a blanket DELETE) because vitest runs
  // test files in parallel by default and parse/route.test.ts + route.test.ts
  // share these same two tables under different user ids -- an unscoped
  // DELETE here can race with and wipe rows those files' own tests just
  // inserted. Delete the FK-child table first.
  await adminSql`DELETE FROM career_goal_constraints WHERE user_id = ${TEST_USER_ID}`;
  await adminSql`DELETE FROM career_goals WHERE user_id = ${TEST_USER_ID}`;
});

afterAll(async () => {
  await adminSql.end();
});

const { POST } = await import("./route");

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/career-goal/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const validConstraints = {
  targetRoles: ["Data Engineer"],
  seniority: null,
  locations: ["Germany"],
  workMode: "remote",
  minExperienceYears: 3,
  employmentType: null,
  salaryFloorRaw: "minimum €60k",
  salaryFloorNormalized: 60000,
  salaryCurrency: "EUR",
  salaryIsParsed: true,
  visaSponsorshipRequired: true,
  skills: [],
  preferredIndustries: [],
  excludedIndustries: [],
  preferredCompanies: [],
  excludedCompanies: [],
  hardConstraints: [],
};

async function insertPendingGoal(rawText: string, version: number): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status)
    VALUES ('00000000-0000-0000-0000-000000000010', ${rawText}, ${version}, 'parsed')
    RETURNING id
  `;
  return row.id;
}

describe("POST /api/career-goal/confirm", () => {
  it("persists constraints, activates the goal, and returns confirmed", async () => {
    const goalId = await insertPendingGoal("Data jobs in Germany", 1);

    const res = await POST(makeRequest({ goalId, constraints: validConstraints }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("confirmed");

    const [goalRow] = await adminSql`SELECT confirmation_status, is_active FROM career_goals WHERE id = ${goalId}`;
    expect(goalRow.confirmation_status).toBe("confirmed");
    expect(goalRow.is_active).toBe(true);

    const [constraintsRow] = await adminSql`SELECT target_roles FROM career_goal_constraints WHERE career_goal_id = ${goalId}`;
    expect(constraintsRow.target_roles).toEqual(["Data Engineer"]);
  });

  it("deactivates the previously active goal when a new one is confirmed", async () => {
    const firstGoalId = await insertPendingGoal("First goal", 10);
    await POST(makeRequest({ goalId: firstGoalId, constraints: validConstraints }));

    const secondGoalId = await insertPendingGoal("Second goal", 11);
    await POST(makeRequest({ goalId: secondGoalId, constraints: validConstraints }));

    const [firstRow] = await adminSql`SELECT is_active FROM career_goals WHERE id = ${firstGoalId}`;
    const [secondRow] = await adminSql`SELECT is_active FROM career_goals WHERE id = ${secondGoalId}`;
    expect(firstRow.is_active).toBe(false);
    expect(secondRow.is_active).toBe(true);
  });

  it("rejects a malformed payload with 400 and a human-readable error", async () => {
    const res = await POST(makeRequest({ goalId: "not-a-uuid", constraints: {} }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).not.toMatch(/^\[/);
  });

  it("returns 404 when the goalId does not exist", async () => {
    const res = await POST(
      makeRequest({ goalId: "00000000-0000-0000-0000-000000000099", constraints: validConstraints })
    );
    expect(res.status).toBe(404);
  });
});
