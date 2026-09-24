import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "@ai-career/config";
import { MatchExplanationSchema, type MatchExplanationDraft } from "./matchExplanationSchema";

const EXPLANATION_TOOL_NAME = "record_match_explanation";

const stringArray = { type: "array", items: { type: "string" } } as const;

const EXPLANATION_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    strongMatches: stringArray,
    partialMatches: stringArray,
    gaps: stringArray,
    summary: { type: "string" },
  },
  required: ["strongMatches", "partialMatches", "gaps", "summary"] as string[],
} as const;

export class MatchExplanationValidationError extends Error {}

export interface MatchExplanationInput {
  jobTitle: string;
  companyName: string;
  overallScore: number;
  skillMatches: { skill: string; found: boolean }[];
  experience: { requiredYears: number | null; candidateYears: number | null };
  workMode: { job: string; goal: string };
  sponsorship: { required: boolean | null; job: string };
  salary: { comparable: boolean; withinRange: boolean | null };
  freshnessDays: number;
}

/**
 * Narrates already-computed factor scores into readable prose -- never re-derives or re-scores
 * anything (D6's "LLM explains, doesn't decide" boundary). The prompt carries only the structured
 * `input` fields, never raw job description or resume text, which bounds the prompt-injection
 * surface from untrusted job content without needing per-field nonce handling (design doc §9).
 */
export async function generateMatchExplanation(
  client: Pick<Anthropic, "messages">,
  env: Pick<Env, "ANTHROPIC_MODEL_FAST">,
  input: MatchExplanationInput
): Promise<MatchExplanationDraft> {
  const message = await client.messages.create({
    model: env.ANTHROPIC_MODEL_FAST,
    max_tokens: 1024,
    system:
      `You explain, in plain language, why a job was ranked the way it was for a candidate, using the ` +
      `${EXPLANATION_TOOL_NAME} tool. All facts you may use are already given to you in the input JSON -- ` +
      `never invent a skill, requirement, or number not present there. strongMatches lists what clearly ` +
      `favors this job (e.g. a found skill, a matching work mode). partialMatches lists softer or ` +
      `borderline fits (e.g. slightly under the stated experience). gaps lists what is missing or ` +
      `unfavorable (e.g. a skill marked not found). summary is one or two sentences. Every item must be ` +
      `traceable to a field in the input; if a category has nothing to report, return an empty array.`,
    tools: [
      {
        name: EXPLANATION_TOOL_NAME,
        description: "Record the structured explanation for why a job was ranked the way it was.",
        input_schema: EXPLANATION_TOOL_INPUT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: EXPLANATION_TOOL_NAME },
    messages: [{ role: "user", content: JSON.stringify(input) }],
  });

  const toolUse = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) {
    throw new MatchExplanationValidationError("Anthropic response did not include the expected tool_use block");
  }
  const result = MatchExplanationSchema.safeParse(toolUse.input);
  if (!result.success) {
    throw new MatchExplanationValidationError(`Explanation output failed schema validation: ${result.error.message}`);
  }
  return result.data;
}
