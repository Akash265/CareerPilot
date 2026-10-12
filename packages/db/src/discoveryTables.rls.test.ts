import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { withUserContext } from "./rls";
import { createDbClient, closeDbClient } from "./client";
import { schema } from "./index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const adminSql = postgres(ADMIN_URL, { onnotice: () => undefined });
const db = createDbClient({ DATABASE_URL: APP_URL });

// Phase 12 test users (…0d01/…0d02), verified unused repo-wide on 2026-10-12.
const USER_A = "00000000-0000-0000-0000-000000000d01";
const USER_B = "00000000-0000-0000-0000-000000000d02";
const MIGRATION_LOCK = 7420001;

const wipe = async () => {
  await adminSql`DELETE FROM discovered_boards WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM discovery_settings WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM job_sources WHERE user_id IN (${USER_A}, ${USER_B})`;
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

describe("discovery tables — RLS and constraints (Phase 12)", () => {
  it("isolates discovered_boards and discovery_settings by user", async () => {
    for (const user of [USER_A, USER_B]) {
      await withUserContext(db, user, async (tx) => {
        await tx.insert(schema.discoverySettings).values({ userId: user, autoDiscover: true, consentedAt: new Date() });
        await tx.insert(schema.discoveredBoards).values({ kind: "ashby", slug: `acme-${user.slice(-1)}` });
      });
    }
    const seen = await withUserContext(db, USER_A, async (tx) => ({
      boards: await tx.select().from(schema.discoveredBoards),
      settings: await tx.select().from(schema.discoverySettings),
    }));
    expect(seen.boards.map((b) => b.slug)).toEqual(["acme-1"]);
    expect(seen.settings.map((s) => s.userId)).toEqual([USER_A]);
    const updated = await withUserContext(db, USER_A, (tx) =>
      tx.update(schema.discoveredBoards).set({ status: "gone" }).where(eq(schema.discoveredBoards.slug, "acme-2")).returning());
    expect(updated).toHaveLength(0);
  });

  it("records each board once per user (case-insensitive slug) and defaults new rows sensibly", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      const [row] = await tx.insert(schema.discoveredBoards).values({ kind: "workable", slug: "HuggingFace" }).returning();
      expect(row.status).toBe("pending");
      await expect(tx.transaction((sp) => sp.insert(schema.discoveredBoards).values({ kind: "workable", slug: "huggingface" })))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
    });
  });

  it("allows one search source per provider, and new sources default to origin manual", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      const [manual] = await tx.insert(schema.jobSources).values({ kind: "ashby", label: "acme", config: { slug: "acme" } }).returning();
      expect(manual.origin).toBe("manual");
      await tx.insert(schema.jobSources).values({ kind: "remotive", label: "Remotive", origin: "search" });
      await expect(tx.transaction((sp) => sp.insert(schema.jobSources).values({ kind: "remotive", label: "Remotive 2", origin: "search" })))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
    });
  });
});
