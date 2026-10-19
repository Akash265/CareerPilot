import { z } from "zod";

const termDisplay = z.string().trim().min(1).max(200);

/** Phase 13b: one answer. The server derives term_key from termDisplay (normalizeTermKey) -- the client never sends a key. */
export const SkillVerificationBodySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("have"), termDisplay, evidence: z.string().trim().min(1).max(300) }).strict(),
  z.object({ status: z.literal("dont_have"), termDisplay }).strict(),
  z.object({ status: z.literal("alias"), termDisplay, aliasSkillName: z.string().trim().min(1).max(200) }).strict(),
]);
export type SkillVerificationBody = z.infer<typeof SkillVerificationBodySchema>;
