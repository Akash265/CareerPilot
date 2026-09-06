import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { sql as dsql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { withUserContext } from "./rls";
import { createDbClient } from "./client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");

// Runs against the dedicated test database created by infra/postgres/init.sql.
// A superuser connection is used ONLY to apply the actual shipped migrations
// (packages/db/migrations/*.sql -- the same files `pnpm db:migrate` applies
// to the real `career_intel` database) and to provision/verify the
// least-privilege role below. It is never used for the isolation assertions
// themselves.
const TEST_MIGRATIONS_DATABASE_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ??
  "postgres://career_intel:career_intel@localhost:5432/career_intel_test";

// IMPORTANT: `career_intel` (the docker-compose POSTGRES_USER, see
// infra/docker-compose.yml) is a Postgres superuser and therefore carries
// BYPASSRLS. Per Postgres semantics, superusers (and any BYPASSRLS role)
// silently bypass every RLS policy, no matter how the policy or
// FORCE ROW LEVEL SECURITY is configured. Running the isolation assertions
// through that role would prove nothing -- it would pass even if the policy
// or withUserContext were completely broken. To genuinely exercise RLS, all
// application-shaped queries below run through a dedicated, least-privilege,
// non-superuser/non-BYPASSRLS role (matching infra/postgres/init.sql's
// `career_intel_app`, provisioned here too so this test is self-contained
// and doesn't silently pass-by-accident if infra/init.sql's role ever
// existed with different attributes -- see the guard-rail assertion below).
const APP_ROLE = "career_intel_app";
const APP_ROLE_PASSWORD = "career_intel_app";
const APP_DATABASE_URL =
  process.env.TEST_APP_DATABASE_URL ??
  `postgres://${APP_ROLE}:${APP_ROLE_PASSWORD}@localhost:5432/career_intel_test`;

const adminSql = postgres(TEST_MIGRATIONS_DATABASE_URL);
const adminDb = drizzle(adminSql);

// The real public entry point (createDbClient), not a hand-rolled
// drizzle(sql, { schema }) call, and the real `users` schema table --
// no synthetic parallel table.
const db = createDbClient({ DATABASE_URL: APP_DATABASE_URL });

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";

beforeAll(async () => {
  // Apply the actual shipped migrations to the test database. This is what
  // makes this test a genuine regression test for
  // packages/db/migrations/0001_users_rls.sql's real policy
  // (`id = current_setting('app.current_user_id')::uuid`) against the real
  // `users` table shape (packages/db/src/schema/users.ts) -- not a
  // hand-rolled table with a different column/policy shape that would prove
  // nothing about the artifact actually being shipped.
  await migrate(adminDb, { migrationsFolder: MIGRATIONS_FOLDER });

  // Idempotently (re-)provision the least-privilege role used to prove
  // isolation, explicit about every attribute (matching init.sql) so a
  // pre-existing role -- created by hand, or by a future infra change --
  // can never silently leave this role with elevated privileges.
  await adminSql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      ELSE
        ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      END IF;
    END
    $$;
  `);
  await adminSql.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await adminSql.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON users TO ${APP_ROLE}`
  );

  // Guard rail: fail loudly, before running any isolation assertion, if the
  // role this test depends on ever ends up with elevated privileges. If this
  // check were skipped and a `career_intel_app` role pre-existed as
  // superuser/BYPASSRLS (a hand-run command, a future infra edit), the
  // `IF NOT EXISTS` guard above would skip creation and every assertion
  // below would pass while proving nothing -- silently reintroducing the
  // exact bug DECISIONS.md D12 exists to close.
  const [roleAttrs] = await adminSql`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${APP_ROLE}
  `;
  if (!roleAttrs || roleAttrs.rolsuper || roleAttrs.rolbypassrls) {
    throw new Error(
      `${APP_ROLE} must be NOSUPERUSER and NOBYPASSRLS for this test to prove ` +
        `anything about RLS isolation; got ${JSON.stringify(roleAttrs)}`
    );
  }

  // Clean slate for the two fixture rows (the `users` table persists across
  // test runs since it now comes from real tracked migrations rather than
  // being dropped/recreated every time).
  await adminSql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;

  // Neither INSERT supplies `id`. This only succeeds if the schema's
  // self-referencing default (current_setting('app.current_user_id')::uuid)
  // is in effect -- with the old `defaultRandom()` default, the generated
  // random id would not equal the active session's user id, and the
  // `user_isolation` policy (USING doubling as WITH CHECK on INSERT since
  // there's no explicit WITH CHECK) would reject the row outright.
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
  await adminSql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
  await adminSql.end();
});

describe("withUserContext RLS isolation (real users table + shipped migration)", () => {
  it("only returns rows for the active user id", async () => {
    const rowsForA = await withUserContext(db, USER_A, async (tx) =>
      tx.execute(dsql`SELECT full_name FROM users`)
    );
    expect(rowsForA.map((r: any) => r.full_name)).toEqual(["Alice"]);

    const rowsForB = await withUserContext(db, USER_B, async (tx) =>
      tx.execute(dsql`SELECT full_name FROM users`)
    );
    expect(rowsForB.map((r: any) => r.full_name)).toEqual(["Bob"]);
  });

  it("defaults a plain INSERT's id to the active session's user, not a random UUID", async () => {
    const rows = await withUserContext(db, USER_A, async (tx) =>
      tx.execute(dsql`SELECT id FROM users`)
    );
    expect(rows.map((r: any) => r.id)).toEqual([USER_A]);
  });

  it("rejects a non-UUID user id before touching the database", async () => {
    await expect(
      withUserContext(db, "not-a-uuid", async (tx) =>
        tx.execute(dsql`SELECT 1`)
      )
    ).rejects.toThrow(/user id/i);
  });
});
