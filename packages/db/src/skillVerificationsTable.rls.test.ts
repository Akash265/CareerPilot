import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { withUserContext } from "./rls";
import { createDbClient, closeDbClient } from "./client";
import { schema } from "./index";

const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const adminSql = postgres(process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test", { onnotice: () => undefined });
const db = createDbClient({ DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test" });

// Phase 13b test users (…0d10/…0d11); verify unused with grep before relying on them.
const USER_A = "00000000-0000-0000-0000-000000000d10";
const USER_B = "00000000-0000-0000-0000-000000000d11";
const MIGRATION_LOCK = 7420001;

const wipe = async () => {
  await adminSql`DELETE FROM skill_verifications WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM skills WHERE user_id IN (${USER_A}, ${USER_B})`;
};

beforeAll(async () => {
  const lock = await adminSql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
    await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
    await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  } finally {
    await lock`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    lock.release();
  }
});
beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await adminSql.end();
  await closeDbClient(db);
});

const violates = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23514" }) });

describe("skill_verifications (Phase 13b)", () => {
  it("isolates answers by user", async () => {
    for (const user of [USER_A, USER_B]) {
      await withUserContext(db, user, (tx) =>
        tx.insert(schema.skillVerifications).values({ termKey: "kubernetes", termDisplay: "Kubernetes", status: "dont_have" }));
    }
    const rows = await withUserContext(db, USER_A, (tx) => tx.select().from(schema.skillVerifications));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: USER_A, status: "dont_have", evidence: null, aliasSkillName: null });
  });

  it("allows one answer per term per user", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      await tx.insert(schema.skillVerifications).values({ termKey: "dbt", termDisplay: "dbt", status: "dont_have" });
      await expect(tx.transaction((sp) => sp.insert(schema.skillVerifications).values({ termKey: "dbt", termDisplay: "DBT", status: "dont_have" })))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
    });
  });

  it("requires evidence exactly for 'have' and a skill name exactly for 'alias'", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      const ins = (v: Partial<typeof schema.skillVerifications.$inferInsert>) =>
        tx.transaction((sp) => sp.insert(schema.skillVerifications).values({ termKey: "k", termDisplay: "K", status: "have", ...v }));
      await violates(ins({ status: "have", evidence: null }));
      await violates(ins({ status: "have", evidence: "   " }));
      await violates(ins({ status: "have", evidence: "x".repeat(301) }));
      await violates(ins({ status: "have", evidence: "Used it", aliasSkillName: "Docker" }));
      await violates(ins({ status: "dont_have", evidence: "Used it" }));
      await violates(ins({ status: "alias", aliasSkillName: null }));
      await violates(ins({ status: "alias", aliasSkillName: "Docker", evidence: "x" }));
      await violates(ins({ termKey: "", status: "dont_have" }));
      await ins({ status: "have", evidence: "Ran our staging cluster for a year." });
    });
  });

  it("survives a profile save that deletes and re-inserts every skill", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      await tx.insert(schema.skills).values({ name: "Postgres" });
      await tx.insert(schema.skillVerifications).values({ termKey: "postgresql", termDisplay: "PostgreSQL", status: "alias", aliasSkillName: "Postgres" });
      await tx.delete(schema.skills);
      await tx.insert(schema.skills).values({ name: "Postgres" });
    });
    const rows = await withUserContext(db, USER_A, (tx) => tx.select().from(schema.skillVerifications));
    expect(rows).toEqual([expect.objectContaining({ termKey: "postgresql", aliasSkillName: "Postgres" })]);
  });
});
