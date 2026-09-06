import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sql as dsql } from "drizzle-orm";
import { withUserContext } from "./rls";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "./client";

// Runs against the dedicated test database created by infra/postgres/init.sql.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://career_intel:career_intel@localhost:5432/career_intel_test";

// IMPORTANT: `career_intel` (the docker-compose POSTGRES_USER, see
// infra/docker-compose.yml) is a Postgres superuser and therefore carries
// BYPASSRLS. Per Postgres semantics, superusers (and any BYPASSRLS role)
// silently bypass every RLS policy, no matter how the policy or
// FORCE ROW LEVEL SECURITY is configured. Running the isolation assertions
// through that role would prove nothing — it would pass even if the policy
// or withUserContext were completely broken. To genuinely exercise RLS, all
// application-shaped queries below run through a dedicated, least-privilege,
// non-superuser/non-BYPASSRLS role created idempotently in beforeAll. Only
// schema setup (DDL) uses the superuser connection, matching how a real
// migration user vs. a real app runtime user would be split.
const APP_ROLE = "career_intel_app";
const APP_ROLE_PASSWORD = "career_intel_app";
const APP_DATABASE_URL =
  process.env.TEST_APP_DATABASE_URL ??
  `postgres://${APP_ROLE}:${APP_ROLE_PASSWORD}@localhost:5432/career_intel_test`;

const sql = postgres(TEST_DATABASE_URL);
const appSql = postgres(APP_DATABASE_URL);
const db = drizzle(appSql, { schema });

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";

beforeAll(async () => {
  await sql`DROP TABLE IF EXISTS users`;
  await sql`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL DEFAULT current_setting('app.current_user_id')::uuid,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE users ENABLE ROW LEVEL SECURITY`;
  await sql`
    CREATE POLICY user_isolation ON users
    USING (user_id = current_setting('app.current_user_id')::uuid)
  `;

  // Idempotently provision the non-superuser role used to actually prove
  // isolation (see note above). Safe to re-run across test invocations.
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_ROLE_PASSWORD}';
      END IF;
    END
    $$;
  `);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON users TO ${APP_ROLE}`);

  await withUserContext(db, USER_A, async (tx) => {
    await tx.execute(
      dsql`INSERT INTO users (full_name, email) VALUES ('Alice', 'alice@example.com')`
    );
  });
  await withUserContext(db, USER_B, async (tx) => {
    await tx.execute(
      dsql`INSERT INTO users (full_name, email) VALUES ('Bob', 'bob@example.com')`
    );
  });
});

afterAll(async () => {
  await sql.end();
  await appSql.end();
});

describe("withUserContext RLS isolation", () => {
  it("only returns rows for the active user_id", async () => {
    const rowsForA = await withUserContext(db, USER_A, async (tx) =>
      tx.execute(dsql`SELECT full_name FROM users`)
    );
    expect(rowsForA.map((r: any) => r.full_name)).toEqual(["Alice"]);

    const rowsForB = await withUserContext(db, USER_B, async (tx) =>
      tx.execute(dsql`SELECT full_name FROM users`)
    );
    expect(rowsForB.map((r: any) => r.full_name)).toEqual(["Bob"]);
  });

  it("rejects a non-UUID user id before touching the database", async () => {
    await expect(
      withUserContext(db, "not-a-uuid", async (tx) =>
        tx.execute(dsql`SELECT 1`)
      )
    ).rejects.toThrow(/user id/i);
  });
});
