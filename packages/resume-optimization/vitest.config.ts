import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests (Task 3+) migrate the shared test database, same reason as packages/matching.
    fileParallelism: false,
  },
});
