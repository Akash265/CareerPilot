import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { extractCareerGoal } from "../src/extractCareerGoal";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "career-goal-fixtures");
const EXPECTED_DIR = path.join(__dirname, "career-goal-expected");

function fakeClientReturning(input: unknown): Pick<Anthropic, "messages"> {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "tool_use", id: "t1", name: "record_career_goal_extraction", input }],
      }),
    } as unknown as Anthropic["messages"],
  };
}

describe("career goal extraction eval fixtures", () => {
  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".txt"));

  it("has a matching expected JSON file for every fixture", () => {
    for (const fixtureName of fixtureNames) {
      const expectedPath = path.join(EXPECTED_DIR, fixtureName.replace(".txt", ".json"));
      expect(() => readFileSync(expectedPath, "utf-8")).not.toThrow();
    }
  });

  it.each(fixtureNames)(
    "round-trips the expected extraction for %s through schema validation",
    async (fixtureName) => {
      const rawText = readFileSync(path.join(FIXTURES_DIR, fixtureName), "utf-8");
      const expected = JSON.parse(
        readFileSync(path.join(EXPECTED_DIR, fixtureName.replace(".txt", ".json")), "utf-8")
      );
      const client = fakeClientReturning(expected);
      const draft = await extractCareerGoal(client, { ANTHROPIC_MODEL_FAST: "test-model" }, rawText);
      expect(draft).toEqual(expected);
    }
  );
});
