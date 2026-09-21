import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests call drizzle's migrate() against the shared
    // career_intel_test database; concurrent migrate() calls race on
    // `CREATE SCHEMA IF NOT EXISTS drizzle` (same reason as packages/db).
    fileParallelism: false,
  },
});
