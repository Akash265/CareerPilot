import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every *.rls.test.ts file calls drizzle-orm's migrate() against the
    // same shared career_intel_test database in its own beforeAll. Vitest
    // runs test files in parallel by default; two concurrent migrate()
    // calls race on `CREATE SCHEMA IF NOT EXISTS drizzle` (IF NOT EXISTS is
    // not atomic across concurrent transactions), which fails with
    // "duplicate key value violates unique constraint
    // pg_namespace_nspname_index". Running files serially avoids the race.
    fileParallelism: false,
  },
});
