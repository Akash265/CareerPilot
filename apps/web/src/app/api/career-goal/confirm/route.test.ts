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

async function insertGoal(
  rawText: string,
  version: number,
  parseStatus: "pending" | "parsed" | "failed"
): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status)
    VALUES (${TEST_USER_ID}, ${rawText}, ${version}, ${parseStatus})
    RETURNING id
  `;
  return row.id;
}

const insertPendingGoal = (rawText: string, version: number) => insertGoal(rawText, version, "parsed");

async function constraintsCount(goalId: string): Promise<number> {
  const [{ count }] = await adminSql`
    SELECT count(*)::int AS count FROM career_goal_constraints WHERE career_goal_id = ${goalId}
  `;
  return count;
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

  it("deactivates the previously active goal when a new one is confirmed, and preserves the old constraints row (D23)", async () => {
    const firstGoalId = await insertPendingGoal("First goal", 10);
    await POST(
      makeRequest({
        goalId: firstGoalId,
        constraints: { ...validConstraints, targetRoles: ["First Role"] },
      })
    );

    const secondGoalId = await insertPendingGoal("Second goal", 11);
    await POST(
      makeRequest({
        goalId: secondGoalId,
        constraints: { ...validConstraints, targetRoles: ["Second Role"] },
      })
    );

    const [firstRow] = await adminSql`SELECT is_active FROM career_goals WHERE id = ${firstGoalId}`;
    const [secondRow] = await adminSql`SELECT is_active FROM career_goals WHERE id = ${secondGoalId}`;
    expect(firstRow.is_active).toBe(false);
    expect(secondRow.is_active).toBe(true);

    // D23: confirm always INSERTs a new career_goal_constraints row rather
    // than updating an existing one, so the first goal's row must survive
    // untouched (both by content and by row count) after the second confirm.
    const [{ count }] = await adminSql`
      SELECT count(*)::int AS count FROM career_goal_constraints
      WHERE career_goal_id IN (${firstGoalId}, ${secondGoalId})
    `;
    expect(count).toBe(2);

    const [firstConstraintsRow] = await adminSql`
      SELECT target_roles FROM career_goal_constraints WHERE career_goal_id = ${firstGoalId}
    `;
    expect(firstConstraintsRow.target_roles).toEqual(["First Role"]);

    const [secondConstraintsRow] = await adminSql`
      SELECT target_roles FROM career_goal_constraints WHERE career_goal_id = ${secondGoalId}
    `;
    expect(secondConstraintsRow.target_roles).toEqual(["Second Role"]);
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

  it("rejects a request body that is not valid JSON with 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/career-goal/confirm", { method: "POST", body: "{not json" })
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/valid JSON/i);
  });

  it("rejects an empty request body with 400", async () => {
    const res = await POST(new Request("http://localhost/api/career-goal/confirm", { method: "POST" }));
    expect(res.status).toBe(400);
  });

  describe("goal state checks", () => {
    it.each(["failed", "pending"] as const)(
      "rejects a goal whose parse status is %s with 409 and changes nothing",
      async (parseStatus) => {
        const activeGoalId = await insertGoal("Currently active goal", 30, "parsed");
        await POST(makeRequest({ goalId: activeGoalId, constraints: validConstraints }));
        const goalId = await insertGoal("Unusable goal", 31, parseStatus);

        const res = await POST(makeRequest({ goalId, constraints: validConstraints }));
        const body = await res.json();

        expect(res.status).toBe(409);
        expect(body.error).toMatch(/not parsed successfully/i);

        const [goalRow] = await adminSql`SELECT confirmation_status, is_active FROM career_goals WHERE id = ${goalId}`;
        expect(goalRow.confirmation_status).toBe("draft");
        expect(goalRow.is_active).toBe(false);
        expect(await constraintsCount(goalId)).toBe(0);

        const [activeRow] = await adminSql`SELECT is_active FROM career_goals WHERE id = ${activeGoalId}`;
        expect(activeRow.is_active).toBe(true);
      }
    );

    it("rejects re-confirming an already-confirmed goal with 409 and leaves it untouched", async () => {
      const goalId = await insertPendingGoal("Confirm me once", 40);
      const first = await POST(
        makeRequest({ goalId, constraints: { ...validConstraints, targetRoles: ["Original Role"] } })
      );
      expect(first.status).toBe(200);

      const second = await POST(
        makeRequest({ goalId, constraints: { ...validConstraints, targetRoles: ["Overwrite Attempt"] } })
      );
      const body = await second.json();

      expect(second.status).toBe(409);
      expect(body.error).toMatch(/already confirmed/i);
      expect(await constraintsCount(goalId)).toBe(1);
      const [constraintsRow] = await adminSql`SELECT target_roles FROM career_goal_constraints WHERE career_goal_id = ${goalId}`;
      expect(constraintsRow.target_roles).toEqual(["Original Role"]);
      const [goalRow] = await adminSql`SELECT confirmation_status, is_active FROM career_goals WHERE id = ${goalId}`;
      expect(goalRow.confirmation_status).toBe("confirmed");
      expect(goalRow.is_active).toBe(true);
    });

    it("lets exactly one of two simultaneous confirms of the same goal succeed and answers the other with 409, never 500", async () => {
      const goalId = await insertPendingGoal("Double click", 50);

      const responses = await Promise.all([
        POST(makeRequest({ goalId, constraints: validConstraints })),
        POST(makeRequest({ goalId, constraints: validConstraints })),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await constraintsCount(goalId)).toBe(1);
    });
  });
});
