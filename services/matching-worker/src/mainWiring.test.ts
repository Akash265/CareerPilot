import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** D219: see services/job-ingestion/src/mainWiring.test.ts. */
const main = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts"), "utf8");

describe("matching-worker startup", () => {
  it("marks interrupted matching runs before creating the worker", () => {
    const sweep = main.indexOf("await markInterruptedMatchingRuns(db, env.DEFAULT_USER_ID)");
    expect(sweep).toBeGreaterThan(0);
    expect(sweep).toBeLessThan(main.indexOf("createMatchingWorker({"));
  });
});
