/**
 * Manual career-goal-extraction accuracy scorer -- same rationale as
 * eval/scoreAccuracy.ts (Phase 2's resume-extraction scorer): the automated
 * eval test only proves the extraction *pipeline* round-trips correctly, it
 * never calls the real (paid, billed) Anthropic API. Run manually whenever
 * ANTHROPIC_MODEL_FAST or extractCareerGoal.ts's prompt/schema changes.
 *
 * Usage (from packages/ai, with a real ANTHROPIC_API_KEY in the repo root
 * .env): `pnpm eval:career-goal-accuracy`
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@ai-career/config";
import { createAnthropicClient, extractCareerGoal, type CareerGoalExtractionDraft } from "../src";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "career-goal-fixtures");
const EXPECTED_DIR = path.join(__dirname, "career-goal-expected");

function normalize(value: string | null | undefined): string {
  return (value ?? "").toString().trim().toLowerCase();
}

function recall(expected: string[], actual: string[]): number {
  if (expected.length === 0) return 1;
  const actualNormalized = actual.map(normalize);
  const matched = expected.filter((item) => {
    const e = normalize(item);
    return actualNormalized.some((a) => a.includes(e) || e.includes(a));
  });
  return matched.length / expected.length;
}

function scoreScalars(expected: CareerGoalExtractionDraft, actual: CareerGoalExtractionDraft): number {
  const fields: (keyof CareerGoalExtractionDraft)[] = [
    "seniority", "workMode", "minExperienceYears", "employmentType",
    "salaryFloorRaw", "visaSponsorshipRequired",
  ];
  const matches = fields.filter((field) => normalize(String(expected[field])) === normalize(String(actual[field])));
  return matches.length / fields.length;
}

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);

  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".txt"));
  const scores: number[] = [];

  for (const fixtureName of fixtureNames) {
    const rawText = readFileSync(path.join(FIXTURES_DIR, fixtureName), "utf-8");
    const expected: CareerGoalExtractionDraft = JSON.parse(
      readFileSync(path.join(EXPECTED_DIR, fixtureName.replace(".txt", ".json")), "utf-8")
    );

    let actual: CareerGoalExtractionDraft;
    try {
      actual = await extractCareerGoal(client, env, rawText);
    } catch (error) {
      console.log(`\n${fixtureName}: EXTRACTION FAILED -- ${(error as Error).message}`);
      scores.push(0);
      continue;
    }

    const sectionScores = {
      targetRoles: recall(expected.targetRoles, actual.targetRoles),
      locations: recall(expected.locations, actual.locations),
      skills: recall(expected.skills, actual.skills),
      preferredIndustries: recall(expected.preferredIndustries, actual.preferredIndustries),
      excludedIndustries: recall(expected.excludedIndustries, actual.excludedIndustries),
      preferredCompanies: recall(expected.preferredCompanies, actual.preferredCompanies),
      excludedCompanies: recall(expected.excludedCompanies, actual.excludedCompanies),
      hardConstraints: recall(expected.hardConstraints, actual.hardConstraints),
      scalars: scoreScalars(expected, actual),
    };
    const overall =
      Object.values(sectionScores).reduce((sum, s) => sum + s, 0) / Object.keys(sectionScores).length;
    scores.push(overall);

    console.log(`\n${fixtureName}: ${(overall * 100).toFixed(0)}%`);
    for (const [section, score] of Object.entries(sectionScores)) {
      console.log(`  ${section}: ${(score * 100).toFixed(0)}%`);
    }
  }

  const average = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  console.log(`\n--- Average across ${scores.length} fixtures: ${(average * 100).toFixed(0)}% ---`);
  console.log(
    "This is a rough recall-style signal (does the model roughly find what's expected), not a strict\n" +
      "correctness proof -- read the per-fixture breakdown above before trusting a single number."
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
