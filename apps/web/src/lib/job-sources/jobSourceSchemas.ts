import { z } from "zod";
import { SLUG_RE } from "@ai-career/ingestion";

export const CreateJobSourceSchema = z.object({
  kind: z.enum(["greenhouse", "lever"]),
  slug: z
    .string()
    .trim()
    .regex(SLUG_RE, "Board token may contain only letters, digits, hyphens and underscores (max 64 characters)"),
  companyName: z.string().trim().min(1).max(120).optional(),
});

export const UpdateJobSourceSchema = z.object({
  enabled: z.boolean(),
  consentConfirmed: z.boolean().optional(),
});
