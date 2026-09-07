import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// The project's vitest.config.ts intentionally omits `test.globals: true` (Tasks 6-8's
// Node-environment API route tests import test globals explicitly), so
// @testing-library/react's built-in auto-cleanup (which detects a global `afterEach`)
// never registers. Without this, DOM nodes from one test leak into the next jsdom test
// file's queries. This is a no-op for Node-environment test files since `cleanup()` only
// tears down containers created by `render()`, which never runs there.
afterEach(() => {
  cleanup();
});
