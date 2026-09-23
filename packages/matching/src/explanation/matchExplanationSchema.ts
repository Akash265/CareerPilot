import { z } from "zod";

/** design doc §7: strong/partial/missing, never a bare score (CLAUDE.md §6). */
export const MatchExplanationSchema = z.object({
  strongMatches: z.array(z.string()),
  partialMatches: z.array(z.string()),
  gaps: z.array(z.string()),
  summary: z.string(),
});

export type MatchExplanationDraft = z.infer<typeof MatchExplanationSchema>;
