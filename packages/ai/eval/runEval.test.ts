import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractProfileFromResume } from "../src/extractProfile";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const EXPECTED_DIR = path.join(__dirname, "expected");

// A fake client that "extracts" by looking up the pre-recorded expected
// output for the given resume text, simulating a perfect model response so
// this eval exercises the schema/pipeline plumbing deterministically without
// a real (paid) Anthropic call. Field-level accuracy against imperfect real
// model output is evaluated manually when ANTHROPIC_MODEL_FAST changes —
// this automated check guards the pipeline shape, not model quality.
function fakeClientReturning(input: unknown) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "tool_use", id: "t1", name: "record_resume_extraction", input }],
      }),
    },
  } as any;
}

describe("resume extraction eval fixtures", () => {
  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".txt"));

  it("has a matching expected JSON file for every fixture", () => {
    for (const fixtureName of fixtureNames) {
      const expectedPath = path.join(EXPECTED_DIR, fixtureName.replace(".txt", ".json"));
      expect(() => readFileSync(expectedPath, "utf-8")).not.toThrow();
    }
  });

  it.each(fixtureNames)("round-trips the expected extraction for %s through schema validation", async (fixtureName) => {
    const resumeText = readFileSync(path.join(FIXTURES_DIR, fixtureName), "utf-8");
    const expected = JSON.parse(
      readFileSync(path.join(EXPECTED_DIR, fixtureName.replace(".txt", ".json")), "utf-8")
    );
    const client = fakeClientReturning(expected);
    const draft = await extractProfileFromResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, resumeText);
    expect(draft).toEqual(expected);
  });
});
