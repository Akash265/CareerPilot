import Anthropic from "@anthropic-ai/sdk";
import { ResumeExtractionSchema, type ResumeExtractionDraft } from "./extractionSchema";
import type { Env } from "@ai-career/config";

const EXTRACTION_TOOL_NAME = "record_resume_extraction";

const nullableString = { type: ["string", "null"] } as const;

const EXTRACTION_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    contact: {
      type: "object",
      properties: {
        fullName: { type: "string" },
        email: { type: "string" },
        phoneNumber: nullableString,
        linkedinUrl: nullableString,
        addressLine1: nullableString,
      },
      required: ["fullName", "email", "phoneNumber", "linkedinUrl", "addressLine1"],
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          institution: { type: "string" },
          degree: { type: "string" },
          fieldOfStudy: nullableString,
          startDate: nullableString,
          endDate: nullableString,
          gpa: nullableString,
        },
        required: ["institution", "degree", "fieldOfStudy", "startDate", "endDate", "gpa"],
      },
    },
    workExperiences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          location: nullableString,
          employmentType: nullableString,
          startDate: nullableString,
          endDate: nullableString,
          bullets: { type: "array", items: { type: "string" } },
        },
        required: ["company", "title", "location", "employmentType", "startDate", "endDate", "bullets"],
      },
    },
    skills: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, category: nullableString },
        required: ["name", "category"],
      },
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, description: { type: "string" }, url: nullableString },
        required: ["name", "description", "url"],
      },
    },
    certifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          issuer: { type: "string" },
          issueDate: nullableString,
          expiryDate: nullableString,
        },
        required: ["name", "issuer", "issueDate", "expiryDate"],
      },
    },
    achievements: { type: "array", items: { type: "string" } },
  },
  required: ["contact", "education", "workExperiences", "skills", "projects", "certifications", "achievements"],
} as const;

export class ExtractionValidationError extends Error {}

export async function extractProfileFromResume(
  client: Pick<Anthropic, "messages">,
  env: Pick<Env, "ANTHROPIC_MODEL_FAST">,
  resumeText: string
): Promise<ResumeExtractionDraft> {
  const message = await client.messages.create({
    model: env.ANTHROPIC_MODEL_FAST,
    max_tokens: 4096,
    tools: [
      {
        name: EXTRACTION_TOOL_NAME,
        description: "Record the structured candidate profile extracted from a resume.",
        input_schema: EXTRACTION_TOOL_INPUT_SCHEMA as any,
      },
    ],
    tool_choice: { type: "tool", name: EXTRACTION_TOOL_NAME },
    messages: [
      {
        role: "user",
        content:
          "Extract every factual field present in this resume. Do not invent information " +
          `that is not present in the text below. Use null for any field not present.\n\n---\n${resumeText}`,
      },
    ],
  } as any);

  const toolUse = (message.content as any[]).find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new ExtractionValidationError("Anthropic response did not include the expected tool_use block");
  }

  const result = ResumeExtractionSchema.safeParse(toolUse.input);
  if (!result.success) {
    throw new ExtractionValidationError(`Extraction output failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

export function createAnthropicClient(env: Pick<Env, "ANTHROPIC_API_KEY">): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}
