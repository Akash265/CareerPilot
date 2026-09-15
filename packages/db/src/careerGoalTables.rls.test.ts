import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { withUserContext } from "./rls";
import { createDbClient } from "./client";
import { careerGoals, careerGoalConstraints } from "./schema";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");

const TEST_MIGRATIONS_DATABASE_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ??
  "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_ROLE = "career_intel_app";
const APP_ROLE_PASSWORD = "career_intel_app";
const APP_DATABASE_URL =
  process.env.TEST_APP_DATABASE_URL ??
  `postgres://${APP_ROLE}:${APP_ROLE_PASSWORD}@localhost:5432/career_intel_test`;

const adminSql = postgres(TEST_MIGRATIONS_DATABASE_URL);
const adminDb = drizzle(adminSql);
const db = createDbClient({ DATABASE_URL: APP_DATABASE_URL });

const USER_A = "00000000-0000-0000-0000-00000000000d";
const USER_B = "00000000-0000-0000-0000-00000000000e";

beforeAll(async () => {
  await migrate(adminDb, { migrationsFolder: MIGRATIONS_FOLDER });
  await adminSql.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await adminSql.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`
  );
  await adminSql`DELETE FROM career_goal_constraints`;
  await adminSql`DELETE FROM career_goals`;
});

afterAll(async () => {
  await adminSql.end();
});

describe("career goal tables RLS isolation", () => {
  it("isolates career_goals + career_goal_constraints by user_id", async () => {
    const goalId = await withUserContext(db, USER_A, async (tx) => {
      const [goal] = await tx
        .insert(careerGoals)
        .values({
          rawText: "Data jobs in Germany",
          version: 1,
          parseStatus: "parsed",
          confirmationStatus: "confirmed",
          isActive: true,
        })
        .returning({ id: careerGoals.id });
      await tx.insert(careerGoalConstraints).values({
        careerGoalId: goal.id as string,
        targetRoles: ["Data Engineer"],
      });
      return goal.id as string;
    });

    await withUserContext(db, USER_B, async (tx) => {
      expect(await tx.select().from(careerGoals)).toHaveLength(0);
      expect(await tx.select().from(careerGoalConstraints)).toHaveLength(0);
    });

    await withUserContext(db, USER_A, async (tx) => {
      const [goalRow] = await tx.select().from(careerGoals).where(eq(careerGoals.id, goalId));
      expect(goalRow.rawText).toBe("Data jobs in Germany");
      const [constraintRow] = await tx
        .select()
        .from(careerGoalConstraints)
        .where(eq(careerGoalConstraints.careerGoalId, goalId));
      expect(constraintRow.targetRoles).toEqual(["Data Engineer"]);
    });
  });

  it("confirms the retired candidate_profiles preference columns and company_preferences table are gone", async () => {
    const columnCheck = await adminSql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'candidate_profiles'
        AND column_name IN (
          'work_mode_preference', 'salary_expectation_min', 'salary_expectation_max',
          'salary_currency', 'visa_sponsorship_required', 'preferred_role_titles',
          'preferred_industries', 'excluded_industries'
        )
    `;
    expect(columnCheck).toHaveLength(0);

    const tableCheck = await adminSql`SELECT to_regclass('public.company_preferences') AS reg`;
    expect(tableCheck[0].reg).toBeNull();
  });
});
