import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { withUserContext } from "./rls";
import { createDbClient } from "./client";
import { workExperiences, workExperienceBullets, skills, profileFacts } from "./schema";
import { eq } from "drizzle-orm";

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

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";
// Same lock id as every other suite's migrate(): parallel migrate() on an empty DB races
// (packages/db/src/applicationPackageTables.rls.test.ts's beforeAll).
const MIGRATION_LOCK = 7420001;

beforeAll(async () => {
  const lock = await adminSql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(adminDb, { migrationsFolder: MIGRATIONS_FOLDER });
    await adminSql.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await adminSql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`
    );
  } finally {
    await lock`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    lock.release();
  }
  // Scoped to this file's own USER_A/USER_B (rather than a blanket DELETE)
  // because turbo/vitest run packages/db and apps/web's test suites
  // concurrently against the same shared local/CI test database -- an
  // unscoped DELETE here can race with and wipe rows that apps/web's own
  // profile route tests just inserted under their own fixed user id.
  // Same fix as careerGoalTables.rls.test.ts's beforeAll in this directory.
  await adminSql`DELETE FROM work_experience_bullets WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM work_experiences WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM skills WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM profile_facts WHERE user_id IN (${USER_A}, ${USER_B})`;
});

afterAll(async () => {
  await adminSql.end();
});

describe("candidate profile tables RLS isolation", () => {
  it("isolates work_experiences + work_experience_bullets by user_id", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      const [exp] = await tx
        .insert(workExperiences)
        .values({ company: "Acme", title: "Engineer" })
        .returning({ id: workExperiences.id });
      await tx.insert(workExperienceBullets).values({
        workExperienceId: exp.id,
        text: "Built things",
        displayOrder: 0,
      });
    });
    await withUserContext(db, USER_B, async (tx) => {
      const rows = await tx.select().from(workExperiences);
      expect(rows).toHaveLength(0);
      const bulletRows = await tx.select().from(workExperienceBullets);
      expect(bulletRows).toHaveLength(0);
    });
    await withUserContext(db, USER_A, async (tx) => {
      const rows = await tx.select().from(workExperiences);
      expect(rows).toHaveLength(1);
    });
  });

  it("isolates skills by user_id", async () => {
    await withUserContext(db, USER_A, (tx) =>
      tx.insert(skills).values({ name: "SQL", category: "language" })
    );
    await withUserContext(db, USER_B, async (tx) => {
      const rows = await tx.select().from(skills);
      expect(rows).toHaveLength(0);
    });
  });

  it("round-trips a profile_facts embedding and isolates it by user_id", async () => {
    const embedding = new Array(1024).fill(0).map((_, i) => i / 1024);
    await withUserContext(db, USER_A, (tx) =>
      tx.insert(profileFacts).values({
        sourceType: "skill",
        sourceId: "00000000-0000-0000-0000-0000000000aa",
        factText: "SQL",
        embedding,
        embeddingModel: "voyage-3.5",
        contentHash: "hash-a",
      })
    );
    await withUserContext(db, USER_B, async (tx) => {
      const rows = await tx.select().from(profileFacts);
      expect(rows).toHaveLength(0);
    });
    await withUserContext(db, USER_A, async (tx) => {
      const [row] = await tx
        .select()
        .from(profileFacts)
        .where(eq(profileFacts.contentHash, "hash-a"));
      expect(row.embedding).toHaveLength(1024);
    });
  });
});
