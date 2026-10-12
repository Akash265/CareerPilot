import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D191: Next.js 16.3 promotes rendered pages into .next/server/route-cache at runtime and `next build` does not
 * clear it, so after a rebuild `next start` kept serving pages cached from the previous build (found when the
 * merged Phase 12 showed the old /sources page). The build script clears that folder first.
 */
const pkg = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../package.json"), "utf8"));

describe("web build script", () => {
  it("clears the runtime route cache before building", () => {
    expect(pkg.scripts.build).toMatch(/rmSync\('\.next\/server\/route-cache', \{ recursive: true, force: true \}\).*&& .*next build/);
  });
});
