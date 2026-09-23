import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests (Task 6+) migrate the shared test database, same reason as packages/ingestion.
    fileParallelism: false,
  },
});
