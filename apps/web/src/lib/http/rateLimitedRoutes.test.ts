import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 11c design §2.3 (D178): every route that spends AI money (Anthropic or Voyage) or starts background work is
 * rate limited, in the right bucket, inside withRouteErrors; no other route is.
 */
const LIMITED: Record<string, Record<string, "ai" | "jobs" | "unlock" | "health">> = {
  "/api/career-goal/parse": { POST: "ai" },
  "/api/career-goal/confirm": { POST: "ai" },
  "/api/profile/resume": { POST: "ai" },
  "/api/profile/confirm": { POST: "ai" },
  "/api/profile": { PATCH: "ai" },
  "/api/resume-optimizations/[jobId]/run": { POST: "ai" },
  "/api/cover-letters/[jobId]/run": { POST: "ai" },
  "/api/application-pitches/[jobId]/run": { POST: "ai" },
  "/api/application-pitches/[jobId]/research/refresh": { POST: "ai" },
  "/api/interview-preps/[jobId]/run": { POST: "ai" },
  "/api/matches/run": { POST: "jobs" },
  "/api/job-sources/[id]/run": { POST: "jobs" },
  "/api/job-sources/upload": { POST: "jobs" },
  "/api/automation-sessions": { POST: "jobs" },
  "/api/discovery/boards": { POST: "jobs" },
  "/api/search-runs": { POST: "jobs" },
  "/api/unlock": { POST: "unlock" },
  "/api/health": { GET: "health" },
};

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app/api");
function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === "route.ts" ? [full] : [];
  });
}
const patternOf = (file: string) => `/api/${path.relative(API_DIR, path.dirname(file)).split(path.sep).join("/")}`;
const files = new Map(routeFiles(API_DIR).map((f) => [patternOf(f), f]));

describe("rate-limited routes", () => {
  it.each(Object.entries(LIMITED))("%s", (pattern, methods) => {
    const file = files.get(pattern);
    expect(file, "route file exists").toBeDefined();
    const source = readFileSync(file!, "utf8");
    for (const [method, bucket] of Object.entries(methods)) {
      expect(source).toContain(`export const ${method} = withRouteErrors("${pattern}", withRateLimit("${bucket}", "${pattern}", handle${method}));`);
    }
  });

  it("no other route or method is rate limited", () => {
    for (const [pattern, file] of files) {
      const source = readFileSync(file, "utf8");
      const limited = [...source.matchAll(/^export const (\w+) = .*withRateLimit\(/gm)].map((m) => m[1]);
      expect(limited.sort(), pattern).toEqual(Object.keys(LIMITED[pattern] ?? {}).sort());
    }
  });
});
