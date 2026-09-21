import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests migrate the shared test database and share one Redis.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
