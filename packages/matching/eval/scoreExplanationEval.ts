/**
 * Manual match-explanation accuracy scorer -- same rationale as
 * packages/ai/eval/scoreCareerGoalAccuracy.ts: this proves the explanation *pipeline* round-trips
 * correctly (unit + integration tests already do that against a fake client), never that a real
 * model's prose actually mentions the right facts. Run manually whenever ANTHROPIC_MODEL_FAST or
 * generateMatchExplanation.ts's prompt/schema changes.
 *
 * Usage (from packages/matching, with a real ANTHROPIC_API_KEY in the repo root .env):
 * `pnpm eval:explanation`
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@ai-career/config";
import { createAnthropicClient } from "@ai-career/ai";
import { generateMatchExplanation, type MatchExplanationInput } from "../src/explanation/generateMatchExplanation";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "match-explanation-fixtures");

interface Fixture {
  input: MatchExplanationInput;
  expectedStrongMentions: string[];
  expectedGapMentions: string[];
}

function normalize(value: string): string {
  return value.toLowerCase();
}

function recall(expected: string[], actual: string[]): number {
  if (expected.length === 0) return 1;
  const haystack = actual.map(normalize).join(" | ");
  const matched = expected.filter((term) => haystack.includes(normalize(term)));
  return matched.length / expected.length;
}

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);

  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  const scores: number[] = [];

  for (const fixtureName of fixtureNames) {
    const fixture: Fixture = JSON.parse(readFileSync(path.join(FIXTURES_DIR, fixtureName), "utf-8"));

    let strongScore = 0;
    let gapScore = 0;
    try {
      const draft = await generateMatchExplanation(client, env, fixture.input);
      strongScore = recall(fixture.expectedStrongMentions, draft.strongMatches);
      gapScore = recall(fixture.expectedGapMentions, draft.gaps);
    } catch (error) {
      console.log(`\n${fixtureName}: EXPLANATION FAILED -- ${(error as Error).message}`);
    }

    const overall = (strongScore + gapScore) / 2;
    scores.push(overall);
    console.log(
      `\n${fixtureName}: ${(overall * 100).toFixed(0)}% (strongMatches recall ${(strongScore * 100).toFixed(0)}%, gaps recall ${(gapScore * 100).toFixed(0)}%)`
    );
  }

  const average = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  console.log(`\n--- Average across ${scores.length} fixtures: ${(average * 100).toFixed(0)}% ---`);
  console.log(
    "This is a rough recall-style signal (does the explanation mention the expected facts), not a\n" +
      "strict correctness proof -- read the per-fixture output above before trusting a single number."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
