import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateMatchExplanation, MatchExplanationValidationError, type MatchExplanationInput } from "./generateMatchExplanation";

type FakeClient = Pick<Anthropic, "messages">;

const validInput: MatchExplanationInput = {
  jobTitle: "Data Engineer",
  companyName: "Acme",
  overallScore: 82,
  skillMatches: [{ skill: "SQL", found: true }, { skill: "Tableau", found: false }],
  experience: { requiredYears: 3, candidateYears: 5 },
  workMode: { job: "remote", goal: "remote" },
  sponsorship: { required: true, job: "offered" },
  salary: { comparable: true, withinRange: true },
  freshnessDays: 2,
};

const validDraft = {
  strongMatches: ["Strong SQL alignment", "Remote work mode matches"],
  partialMatches: ["3 years required, you have 5"],
  gaps: ["Tableau requested; not found in your listed skills"],
  summary: "A strong overall match with one notable skill gap.",
};

function fakeClient(toolUseInput: unknown, hasToolUse = true): FakeClient {
  return {
    messages: {
      create: async () => ({
        content: hasToolUse
          ? [{ type: "tool_use", id: "t1", name: "record_match_explanation", input: toolUseInput }]
          : [{ type: "text", text: "no tool use" }],
      }),
    } as unknown as Anthropic["messages"],
  };
}

describe("generateMatchExplanation", () => {
  it("returns the validated draft on a well-formed tool_use response", async () => {
    const draft = await generateMatchExplanation(fakeClient(validDraft), { ANTHROPIC_MODEL_FAST: "test-model" }, validInput);
    expect(draft.summary).toBe(validDraft.summary);
    expect(draft.gaps).toContain("Tableau requested; not found in your listed skills");
  });

  it("throws MatchExplanationValidationError when there is no tool_use block", async () => {
    await expect(
      generateMatchExplanation(fakeClient(validDraft, false), { ANTHROPIC_MODEL_FAST: "test-model" }, validInput)
    ).rejects.toThrow(MatchExplanationValidationError);
  });

  it("throws MatchExplanationValidationError when the tool_use input fails schema validation", async () => {
    await expect(
      generateMatchExplanation(fakeClient({ strongMatches: "not-an-array" }), { ANTHROPIC_MODEL_FAST: "test-model" }, validInput)
    ).rejects.toThrow(MatchExplanationValidationError);
  });

  it("never puts raw job description text in the prompt -- only the structured input fields", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "record_match_explanation", input: validDraft }],
    });
    const client: FakeClient = { messages: { create } as unknown as Anthropic["messages"] };

    await generateMatchExplanation(client, { ANTHROPIC_MODEL_FAST: "test-model" }, validInput);

    const call = create.mock.calls[0][0];
    const serialized = JSON.stringify(call.messages);
    expect(serialized).not.toContain("descriptionText");
    expect(serialized).toContain("Data Engineer");
    expect(serialized).toContain("SQL");
  });
});
