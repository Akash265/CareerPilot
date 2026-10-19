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

// Phase 13a test users (…0d06/…0d07); verify unused with grep before relying on them.
const USER_A = "00000000-0000-0000-0000-000000000d06";
const USER_B = "00000000-0000-0000-0000-000000000d07";
const MIGRATION_LOCK = 7420001;

const wipe = async () => {
  await adminSql`DELETE FROM search_runs WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM discovered_boards WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM discovery_settings WHERE user_id IN (${USER_A}, ${USER_B})`;
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

describe("search_runs (Phase 13a)", () => {
  it("isolates runs by user and defaults new rows to queued with empty progress", async () => {
    for (const user of [USER_A, USER_B]) {
      await withUserContext(db, user, (tx) => tx.insert(schema.searchRuns).values({}));
    }
    const rows = await withUserContext(db, USER_A, (tx) => tx.select().from(schema.searchRuns));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: USER_A, status: "queued", sources: [], seeding: {}, errorCode: null });
  });

  it("allows only one non-terminal run per user", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      await tx.insert(schema.searchRuns).values({ status: "completed" });
      await tx.insert(schema.searchRuns).values({ status: "running" });
      await expect(tx.transaction((sp) => sp.insert(schema.searchRuns).values({ status: "queued" })))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
    });
  });

  it("records how a board was found, and the web-search stamp", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      const [probe] = await tx.insert(schema.discoveredBoards)
        .values({ kind: "lever", slug: "acme", foundVia: "name_probe", expectedCompany: "Acme" }).returning();
      expect(probe).toMatchObject({ foundVia: "name_probe", expectedCompany: "Acme", rejectReason: null });
      const [plain] = await tx.insert(schema.discoveredBoards).values({ kind: "lever", slug: "other" }).returning();
      expect(plain.foundVia).toBe("posting_link");
      const [s] = await tx.insert(schema.discoverySettings).values({ lastWebSearchAt: new Date(0), lastWebSearchGoalId: USER_B }).returning();
      expect(s).toMatchObject({ lastWebSearchGoalId: USER_B });
    });
  });
});
