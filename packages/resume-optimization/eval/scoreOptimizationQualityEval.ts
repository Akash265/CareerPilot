/**
 * Manual optimization-quality scorer. Checks two things a real model run can regress that fake-
 * client unit tests (Tasks 5-6) cannot catch: (1) the guard rejects zero LEGITIMATE citations (every
 * sourceFactId the model cites really is in the fixture's catalog), and (2) keyword coverage on the
 * optimized text improves versus the raw, unoptimized catalog text. Run manually whenever
 * ANTHROPIC_MODEL_FAST or optimizeResume.ts's prompt/schema changes.
 *
 * Usage (from packages/resume-optimization, with a real ANTHROPIC_API_KEY in the repo root .env):
 * `pnpm eval:optimization`
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@ai-career/config";
import { createAnthropicClient } from "@ai-career/ai";
import { optimizeResume, type OptimizeResumeInput } from "../src/optimization/optimizeResume";
import { applyDeterministicGuard } from "../src/optimization/applyDeterministicGuard";
import { scoreKeywordCoverage } from "../src/evaluation/scoreKeywordCoverage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "optimization-quality-fixtures");

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);

  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

  for (const fixtureName of fixtureNames) {
    const fixture: OptimizeResumeInput = JSON.parse(readFileSync(path.join(FIXTURES_DIR, fixtureName), "utf-8"));

    try {
      const draft = await optimizeResume(client, env, fixture);
      const guardResult = applyDeterministicGuard(fixture.catalog, draft);

      const baselineText = fixture.catalog.map((e) => e.text).join("\n");
      const optimizedText = guardResult.appliedBullets.map((b) => b.optimizedText).join("\n");
      const baselineCoverage = scoreKeywordCoverage(fixture.requirements, baselineText);
      const optimizedCoverage = scoreKeywordCoverage(fixture.requirements, optimizedText);

      console.log(`\n${fixtureName}:`);
      console.log(`  legitimate citations rejected by the guard: ${guardResult.rejectedClaims.length} (should be 0)`);
      console.log(`  required coverage: ${(baselineCoverage.requiredKeywordCoverage * 100).toFixed(0)}% -> ${(optimizedCoverage.requiredKeywordCoverage * 100).toFixed(0)}%`);
      console.log(`  preferred coverage: ${(baselineCoverage.preferredKeywordCoverage * 100).toFixed(0)}% -> ${(optimizedCoverage.preferredKeywordCoverage * 100).toFixed(0)}%`);
      if (guardResult.rejectedClaims.length > 0) {
        console.log(`  REJECTED (investigate -- these ids came from the model but aren't in the fixture's own catalog): ${JSON.stringify(guardResult.rejectedClaims)}`);
      }
    } catch (error) {
      console.log(`\n${fixtureName}: OPTIMIZATION FAILED -- ${(error as Error).message}`);
    }
  }

  console.log("\nA non-zero rejected-citation count here (unlike a real run, where a rejection can be a legitimate catch) always indicates a prompt regression, since every id in these fixtures' catalogs is genuine.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
