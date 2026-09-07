import { describe, it, expect } from "vitest";
import { extractProfileFromResume, ExtractionValidationError } from "./extractProfile";

const validDraftInput = {
  contact: { fullName: "Ada Lovelace", email: "ada@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  education: [],
  workExperiences: [],
  skills: [{ name: "Analytical Engines", category: null }],
  projects: [],
  certifications: [],
  achievements: [],
};

function fakeAnthropicClient(toolUseInput: unknown, hasToolUse = true) {
  return {
    messages: {
      create: async () => ({
        content: hasToolUse
          ? [{ type: "tool_use", id: "t1", name: "record_resume_extraction", input: toolUseInput }]
          : [{ type: "text", text: "no tool use" }],
      }),
    },
  } as any;
}

describe("extractProfileFromResume", () => {
  it("returns the validated draft when the model returns a well-formed tool_use block", async () => {
    const client = fakeAnthropicClient(validDraftInput);
    const draft = await extractProfileFromResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, "resume text");
    expect(draft.contact.fullName).toBe("Ada Lovelace");
  });

  it("throws ExtractionValidationError when there is no tool_use block", async () => {
    const client = fakeAnthropicClient(validDraftInput, false);
    await expect(
      extractProfileFromResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, "resume text")
    ).rejects.toThrow(ExtractionValidationError);
  });

  it("throws ExtractionValidationError when the tool_use input fails schema validation", async () => {
    const client = fakeAnthropicClient({ contact: { fullName: 123 } });
    await expect(
      extractProfileFromResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, "resume text")
    ).rejects.toThrow(ExtractionValidationError);
  });
});
