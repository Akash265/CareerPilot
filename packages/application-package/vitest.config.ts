import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests (Task 7+) migrate the shared test database, same reason as packages/resume-optimization.
    fileParallelism: false,
  },
});
