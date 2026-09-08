/**
 * Manual resume-extraction accuracy scorer.
 *
 * `runEval.test.ts` (part of `pnpm test`) only proves the extraction
 * *pipeline* round-trips a known-good tool_use response through schema
 * validation correctly -- it never calls the real Anthropic API, per this
 * project's rule that no automated test may make a real, paid API call.
 * That means nothing in CI ever measures whether the model actually
 * extracts resumes *accurately*, which is what CLAUDE.md §10 asks for.
 *
 * This script does that measurement, deliberately kept OUTSIDE `pnpm test`:
 * it makes real, billed Anthropic calls against the fixtures in
 * `eval/fixtures/` and scores the result against the hand-written
 * `eval/expected/` JSON. Run it manually whenever ANTHROPIC_MODEL_FAST
 * changes, or when extractProfile.ts's prompt/schema changes, to check for
 * regressions a schema-shape test can't see.
 *
 * Usage (from packages/ai, with a real ANTHROPIC_API_KEY in the repo root
 * .env): `pnpm eval:accuracy`
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@ai-career/config";
import { createAnthropicClient, extractProfileFromResume, type ResumeExtractionDraft } from "../src";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const EXPECTED_DIR = path.join(__dirname, "expected");

function normalize(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

/** Fraction of `expected` entries that have some matching entry in `actual`, by `key`. */
function recall<T>(expected: T[], actual: T[], key: (item: T) => string): number {
  if (expected.length === 0) return 1;
  const actualKeys = actual.map((item) => normalize(key(item)));
  const matched = expected.filter((item) => {
    const expectedKey = normalize(key(item));
    return actualKeys.some((k) => k.includes(expectedKey) || expectedKey.includes(k));
  });
  return matched.length / expected.length;
}

function scoreContact(expected: ResumeExtractionDraft["contact"], actual: ResumeExtractionDraft["contact"]): number {
  const fields: (keyof ResumeExtractionDraft["contact"])[] = [
    "fullName",
    "email",
    "phoneNumber",
    "linkedinUrl",
    "addressLine1",
  ];
  const matches = fields.filter((field) => normalize(expected[field]) === normalize(actual[field]));
  return matches.length / fields.length;
}

async function main() {
  const env = loadEnv();
  const client = createAnthropicClient(env);

  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".txt"));
  const scores: number[] = [];

  for (const fixtureName of fixtureNames) {
    const resumeText = readFileSync(path.join(FIXTURES_DIR, fixtureName), "utf-8");
    const expected: ResumeExtractionDraft = JSON.parse(
      readFileSync(path.join(EXPECTED_DIR, fixtureName.replace(".txt", ".json")), "utf-8")
    );

    let actual: ResumeExtractionDraft;
    try {
      actual = await extractProfileFromResume(client, env, resumeText);
    } catch (error) {
      console.log(`\n${fixtureName}: EXTRACTION FAILED -- ${(error as Error).message}`);
      scores.push(0);
      continue;
    }

    const sectionScores = {
      contact: scoreContact(expected.contact, actual.contact),
      education: recall(expected.education, actual.education, (e) => e.institution),
      workExperiences: recall(expected.workExperiences, actual.workExperiences, (e) => e.company),
      skills: recall(expected.skills, actual.skills, (s) => s.name),
      projects: recall(expected.projects, actual.projects, (p) => p.name),
      certifications: recall(expected.certifications, actual.certifications, (c) => c.name),
      achievements: recall(
        expected.achievements.map((a) => ({ a })),
        actual.achievements.map((a) => ({ a })),
        (item) => item.a
      ),
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
