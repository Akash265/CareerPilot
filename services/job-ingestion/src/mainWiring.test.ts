import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D219: runs left "running" by a previous process are marked interrupted before this worker takes any work, so a run
 * the new process starts is never mistaken for a stale one. main.ts starts real workers, so the order is pinned here.
 */
const main = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

describe("job-ingestion startup", () => {
  it("marks interrupted runs before creating the ingest and search-run workers", () => {
    const sweep = main.indexOf("await markInterruptedRuns(db, env.DEFAULT_USER_ID)");
    expect(sweep).toBeGreaterThan(0);
    expect(sweep).toBeLessThan(main.indexOf("createIngestWorker({"));
    expect(sweep).toBeLessThan(main.indexOf("createSearchRunWorker({"));
  });
});
