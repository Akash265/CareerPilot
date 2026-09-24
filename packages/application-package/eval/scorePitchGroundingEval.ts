/**
 * Manual pitch-grounding scorer. Checks what fake-client unit tests cannot: that a real model, given
 * genuine evidence, (1) cites ids the guard accepts for every bullet of every fixture, and (2) does not
 * put numbers in a bullet that appear in none of that bullet's cited evidence (a reported heuristic for
 * invented metrics, not an assertion). Run when ANTHROPIC_MODEL_FAST or generatePitch's prompt/schema changes.
 *
 * Usage (from packages/application-package, real ANTHROPIC_API_KEY in the repo root .env): `pnpm eval:pitch`
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@ai-career/config";
import { createAnthropicClient } from "@ai-career/ai";
import { generatePitch, type GeneratePitchInput } from "../src/pitch/generatePitch";
import { applyPitchGuard } from "../src/pitch/applyPitchGuard";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "pitch-fixtures");

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);
  let supported = 0;
  let total = 0;
  let flaggedNumbers = 0;

  for (const name of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"))) {
    const fixture: GeneratePitchInput = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf-8"));
    try {
      const draft = await generatePitch(client, env, fixture);
      const result = applyPitchGuard(fixture.evidence, draft);
      console.log(`\n${name} (requiresReview=${result.requiresReview}):`);
      for (const b of result.bullets) {
        total += 1;
        if (b.supported) supported += 1;
        const cited = b.evidence.map((e) => e.text).join(" ");
        const numbers = b.text.match(/\d+(?:[.,]\d+)?%?/g) ?? [];
        const uncited = numbers.filter((n) => !cited.includes(n));
        flaggedNumbers += uncited.length;
        console.log(`  [${b.kind}] supported=${b.supported}${b.unsupportedReason ? ` (${b.unsupportedReason})` : ""}`);
        console.log(`    ${b.text}`);
        if (uncited.length > 0) console.log(`    NUMBERS NOT IN CITED EVIDENCE (investigate): ${uncited.join(", ")}`);
      }
    } catch (error) {
      console.log(`\n${name}: GENERATION FAILED -- ${(error as Error).message}`);
    }
  }

  console.log(`\nSupported bullets: ${supported}/${total} (every fixture id is genuine, so anything below ${total}/${total} is a prompt regression).`);
  console.log(`Numbers not found in cited evidence: ${flaggedNumbers} (should be 0).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
