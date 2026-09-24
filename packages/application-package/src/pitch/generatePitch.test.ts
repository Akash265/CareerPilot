import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generatePitch, PitchGenerationValidationError, type GeneratePitchInput } from "./generatePitch";

const ENV = { ANTHROPIC_MODEL_FAST: "fast-model" };
const INPUT: GeneratePitchInput = {
  jobTitle: "Data Engineer",
  companyName: "Acme",
  evidence: [
    { id: "r:f1", kind: "research", text: "Acme builds rockets.", sourceUrl: "https://acme.example" },
    { id: "q:q1", kind: "requirement", text: "[required] SQL", sourceUrl: null },
    { id: "p:b1", kind: "profile", text: "Built a SQL pipeline", sourceUrl: null },
  ],
};
const VALID = {
  bullets: [
    { kind: "company", text: "Acme's rocket work excites me.", evidenceIds: ["r:f1"] },
    { kind: "role", text: "The role centres on SQL.", evidenceIds: ["q:q1"] },
    { kind: "candidate", text: "I built a SQL pipeline.", evidenceIds: ["p:b1"] },
  ],
  requiresReview: false,
};

function clientWith(input: unknown, hasToolUse = true) {
  const create = vi.fn().mockResolvedValue({
    content: hasToolUse ? [{ type: "tool_use", id: "t1", name: "record_pitch", input }] : [{ type: "text", text: "no tool", citations: null }],
  });
  return { client: { messages: { create } as unknown as Anthropic["messages"] }, create };
}

describe("generatePitch", () => {
  it("returns the validated draft", async () => {
    const { client } = clientWith(VALID);
    const draft = await generatePitch(client, ENV, INPUT);
    expect(draft.bullets.map((b) => b.kind)).toEqual(["company", "role", "candidate"]);
    expect(draft.bullets[2].evidenceIds).toEqual(["p:b1"]);
  });

  it("uses the fast model with a forced record_pitch tool call", async () => {
    const { client, create } = clientWith(VALID);
    await generatePitch(client, ENV, INPUT);
    const call = create.mock.calls[0][0];
    expect(call.model).toBe("fast-model");
    expect(call.tool_choice).toEqual({ type: "tool", name: "record_pitch" });
    expect(call.tools[0].name).toBe("record_pitch");
  });

  it("frames job context and evidence as untrusted data in separate random delimiters", async () => {
    const { client, create } = clientWith(VALID);
    await generatePitch(client, ENV, INPUT);
    const call = create.mock.calls[0][0];
    expect(call.system.toLowerCase()).toContain("untrusted");
    const content = call.messages[0].content as string;
    expect(content).toMatch(/<pitch_job_[0-9a-f]{16}>/);
    expect(content).toMatch(/<pitch_evidence_[0-9a-f]{16}>/);
    expect(content).toContain("r:f1");
    expect(content).toContain("Acme builds rockets.");
  });

  it("states the per-bullet citation rule and the no-invention rule", async () => {
    const { client, create } = clientWith(VALID);
    await generatePitch(client, ENV, INPUT);
    const system = create.mock.calls[0][0].system as string;
    expect(system).toContain('"r:"');
    expect(system).toContain('"q:"');
    expect(system).toContain('"p:"');
    expect(system.toLowerCase()).toContain("never invent");
  });

  it("throws PitchGenerationValidationError when there is no tool_use block", async () => {
    const { client } = clientWith(VALID, false);
    await expect(generatePitch(client, ENV, INPUT)).rejects.toThrow(PitchGenerationValidationError);
  });

  it("throws PitchGenerationValidationError for two bullets, wrong order, empty or over-long text", async () => {
    const cases = [
      { ...VALID, bullets: VALID.bullets.slice(0, 2) },
      { ...VALID, bullets: [VALID.bullets[1], VALID.bullets[0], VALID.bullets[2]] },
      { ...VALID, bullets: [{ ...VALID.bullets[0], text: "   " }, VALID.bullets[1], VALID.bullets[2]] },
      { ...VALID, bullets: [{ ...VALID.bullets[0], text: "x".repeat(601) }, VALID.bullets[1], VALID.bullets[2]] },
    ];
    for (const input of cases) {
      const { client } = clientWith(input);
      await expect(generatePitch(client, ENV, INPUT)).rejects.toThrow(PitchGenerationValidationError);
    }
  });
});
