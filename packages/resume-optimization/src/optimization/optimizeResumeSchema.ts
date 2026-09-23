import { z } from "zod";

export const SelectedBulletChangeTypeEnum = z.enum(["unchanged", "reordered", "reworded"]);

export const SelectedBulletSchema = z.object({
  sourceFactId: z.string(),
  optimizedText: z.string(),
  changeType: SelectedBulletChangeTypeEnum,
  justification: z.string(),
});

export const OptimizeResumeSchema = z.object({
  selectedBullets: z.array(SelectedBulletSchema),
  addedTerms: z.array(z.string()),
  unsupportedClaimsDetected: z.array(z.string()),
  requiresReview: z.boolean(),
});

export type SelectedBulletDraft = z.infer<typeof SelectedBulletSchema>;
export type OptimizeResumeDraft = z.infer<typeof OptimizeResumeSchema>;
