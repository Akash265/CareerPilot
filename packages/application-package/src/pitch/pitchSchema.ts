import { z } from "zod";
import { MAX_BULLET_CHARS, PITCH_BULLET_KINDS } from "../types";

export const PitchDraftBulletSchema = z.object({
  kind: z.enum(PITCH_BULLET_KINDS),
  text: z.string().trim().min(1).max(MAX_BULLET_CHARS),
  evidenceIds: z.array(z.string()),
});

export const PitchDraftSchema = z.object({
  bullets: z
    .array(PitchDraftBulletSchema)
    .length(3)
    .refine((b) => b.length === 3 && b[0]?.kind === "company" && b[1]?.kind === "role" && b[2]?.kind === "candidate", {
      message: "bullets must be ordered company, role, candidate",
    }),
  requiresReview: z.boolean(),
});

export type PitchDraft = z.infer<typeof PitchDraftSchema>;
export type PitchDraftBullet = z.infer<typeof PitchDraftBulletSchema>;
