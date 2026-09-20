import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { extractCareerGoal } from "../src/extractCareerGoal";
import { parseSalaryFloor } from "../src/parseSalaryFloor";

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

// What the deterministic parser (D22/D25) must make of each fixture's expected
// salary phrases. Together with the round-trip above this checks the whole
// chain: hand-labelled extraction -> parseSalaryFloor -> the numbers that would
// reach the review form. A fixture absent from a table has no such phrase.
const EXPECTED_FLOOR: Record<string, { amount: number | null; currency: string | null; isParsed: boolean }> = {
  "goal-1-remote-multi-location": { amount: 60000, currency: "EUR", isParsed: true },
  "goal-3-hybrid-startup-excluded-companies": { amount: 140000, currency: "USD", isParsed: true },
  "goal-6-preferred-companies-salary-range": { amount: 45000, currency: "EUR", isParsed: true },
  "goal-7-ambiguous-monthly-salary": { amount: 3000, currency: null, isParsed: false },
  "goal-9-spec-example-6-2": { amount: 60000, currency: "EUR", isParsed: true },
  "goal-10-target-salary-and-exclusions": { amount: 60000, currency: "EUR", isParsed: true },
};
const EXPECTED_TARGET: Record<string, { amount: number | null; currency: string | null; isParsed: boolean }> = {
  "goal-10-target-salary-and-exclusions": { amount: 80000, currency: "EUR", isParsed: true },
};

describe("career goal eval fixtures: deterministic salary outcome", () => {
  const names = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.replace(".txt", ""));

  it.each(names)("%s: floor and target phrases parse to the golden values", (name) => {
    const expected = JSON.parse(readFileSync(path.join(EXPECTED_DIR, `${name}.json`), "utf-8"));
    const none = { amount: null, currency: null, isParsed: false };
    expect(parseSalaryFloor(expected.salaryFloorRaw)).toEqual(EXPECTED_FLOOR[name] ?? none);
    expect(parseSalaryFloor(expected.salaryTargetRaw)).toEqual(EXPECTED_TARGET[name] ?? none);
  });

  it("never labels the same phrase as both the minimum and the preferred salary", () => {
    for (const name of names) {
      const expected = JSON.parse(readFileSync(path.join(EXPECTED_DIR, `${name}.json`), "utf-8"));
      if (expected.salaryFloorRaw !== null) expect(expected.salaryTargetRaw, name).not.toBe(expected.salaryFloorRaw);
    }
  });

  it("covers the spec's own examples", () => {
    expect(names).toContain("goal-9-spec-example-6-2");
    expect(readFileSync(path.join(FIXTURES_DIR, "goal-10-target-salary-and-exclusions.txt"), "utf-8")).toContain(
      "Exclude: Accenture, Deloitte, Amazon"
    );
  });
});
