import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { optimizeResume, OptimizeResumeValidationError, type OptimizeResumeInput } from "./optimizeResume";

type FakeAnthropicClient = Pick<Anthropic, "messages">;

const validDraftInput = {
  selectedBullets: [
    { sourceFactId: "b1", optimizedText: "Built a SQL data pipeline serving 10 teams", changeType: "reworded", justification: "Emphasizes SQL, a required term" },
  ],
  addedTerms: ["SQL"],
  unsupportedClaimsDetected: [],
  requiresReview: false,
};

const baseInput: OptimizeResumeInput = {
  jobTitle: "Data Engineer",
  companyName: "Acme",
  requirements: [{ termText: "SQL", requirementLevel: "required" }],
  catalog: [{ sourceFactId: "b1", sourceType: "work_experience_bullet", text: "Built a data pipeline", context: "Acme — Engineer" }],
};

function fakeAnthropicClient(toolUseInput: unknown, hasToolUse = true): FakeAnthropicClient {
  return {
    messages: {
      create: async () => ({
        content: hasToolUse
          ? [{ type: "tool_use", id: "t1", name: "record_resume_optimization", input: toolUseInput }]
          : [{ type: "text", text: "no tool use" }],
      }),
    } as unknown as Anthropic["messages"],
  };
}

describe("optimizeResume", () => {
  it("returns the validated draft when the model returns a well-formed tool_use block", async () => {
    const client = fakeAnthropicClient(validDraftInput);
    const draft = await optimizeResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, baseInput);
    expect(draft.selectedBullets[0].sourceFactId).toBe("b1");
    expect(draft.addedTerms).toEqual(["SQL"]);
  });

  it("throws OptimizeResumeValidationError when there is no tool_use block", async () => {
    const client = fakeAnthropicClient(validDraftInput, false);
    await expect(optimizeResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, baseInput)).rejects.toThrow(OptimizeResumeValidationError);
  });

  it("throws OptimizeResumeValidationError when the tool_use input fails schema validation", async () => {
    const client = fakeAnthropicClient({ selectedBullets: "not-an-array" });
    await expect(optimizeResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, baseInput)).rejects.toThrow(OptimizeResumeValidationError);
  });

  it("frames both the job context and the evidence catalog as untrusted data, each with its own delimiter", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "record_resume_optimization", input: validDraftInput }],
    });
    const client: FakeAnthropicClient = { messages: { create } as unknown as Anthropic["messages"] };

    await optimizeResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, baseInput);

    const call = create.mock.calls[0][0];
    expect(call.system.toLowerCase()).toContain("untrusted");
    const userContent = call.messages[0].content as string;
    expect(userContent).toMatch(/<job_context_[0-9a-f]+>/);
    expect(userContent).toMatch(/<evidence_catalog_[0-9a-f]+>/);
    expect(userContent).toContain("b1");
  });

  it("instructs the model it may only select bullets present in the catalog and must never invent facts", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "record_resume_optimization", input: validDraftInput }],
    });
    const client: FakeAnthropicClient = { messages: { create } as unknown as Anthropic["messages"] };

    await optimizeResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, baseInput);

    const system = create.mock.calls[0][0].system as string;
    expect(system.toLowerCase()).toContain("never invent");
    expect(system).toContain("catalog");
  });
});
