/**
 * Manual requirement-extraction accuracy scorer -- same rationale as
 * packages/matching/eval/scoreExplanationEval.ts: proves the extraction *pipeline* round-trips
 * correctly (unit + integration tests already do that against a fake client), never that a real
 * model's classification is perfect. Run manually whenever ANTHROPIC_MODEL_FAST or
 * extractJobRequirements.ts's prompt/schema changes.
 *
 * Usage (from packages/resume-optimization, with a real ANTHROPIC_API_KEY in the repo root .env):
 * `pnpm eval:requirements`
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@ai-career/config";
import { createAnthropicClient } from "@ai-career/ai";
import { extractJobRequirements } from "../src/requirements/extractJobRequirements";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "requirement-extraction-fixtures");
const EXPECTED_DIR = path.join(__dirname, "requirement-extraction-expected");

interface Expected {
  expectedRequiredTerms: string[];
  expectedPreferredTerms: string[];
}

function normalize(value: string): string {
  return value.toLowerCase();
}

function recall(expected: string[], actualTerms: string[]): number {
  if (expected.length === 0) return 1;
  const haystack = actualTerms.map(normalize).join(" | ");
  const matched = expected.filter((term) => haystack.includes(normalize(term)));
  return matched.length / expected.length;
}

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);

  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".txt"));
  const scores: number[] = [];

  for (const fixtureName of fixtureNames) {
    const jobText = readFileSync(path.join(FIXTURES_DIR, fixtureName), "utf-8");
    const expected: Expected = JSON.parse(readFileSync(path.join(EXPECTED_DIR, fixtureName.replace(".txt", ".json")), "utf-8"));

    let requiredScore = 0;
    let preferredScore = 0;
    try {
      const draft = await extractJobRequirements(client, env, "Role", jobText);
      const requiredTerms = draft.requirements.filter((r) => r.requirementLevel === "required").map((r) => r.termText);
      const preferredTerms = draft.requirements.filter((r) => r.requirementLevel === "preferred").map((r) => r.termText);
      requiredScore = recall(expected.expectedRequiredTerms, requiredTerms);
      preferredScore = recall(expected.expectedPreferredTerms, preferredTerms);
    } catch (error) {
      console.log(`\n${fixtureName}: EXTRACTION FAILED -- ${(error as Error).message}`);
    }

    const overall = (requiredScore + preferredScore) / 2;
    scores.push(overall);
    console.log(
      `\n${fixtureName}: ${(overall * 100).toFixed(0)}% (required recall ${(requiredScore * 100).toFixed(0)}%, preferred recall ${(preferredScore * 100).toFixed(0)}%)`
    );
  }

  const average = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  console.log(`\n--- Average across ${scores.length} fixtures: ${(average * 100).toFixed(0)}% ---`);
  console.log("This is a rough recall-style signal, not a strict correctness proof -- read the per-fixture output above before trusting a single number.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
