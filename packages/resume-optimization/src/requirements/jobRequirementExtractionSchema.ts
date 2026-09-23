import { z } from "zod";

export const RequirementTermTypeEnum = z.enum(["skill", "tool", "certification", "other"]);
export const RequirementLevelEnum = z.enum(["required", "preferred"]);

export const ExtractedRequirementSchema = z.object({
  termText: z.string(),
  termType: RequirementTermTypeEnum,
  requirementLevel: RequirementLevelEnum,
  evidenceQuote: z.string().nullable(),
});

export const JobRequirementExtractionSchema = z.object({
  requirements: z.array(ExtractedRequirementSchema),
});

export type ExtractedRequirement = z.infer<typeof ExtractedRequirementSchema>;
export type JobRequirementExtractionDraft = z.infer<typeof JobRequirementExtractionSchema>;
