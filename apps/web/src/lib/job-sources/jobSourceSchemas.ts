import { z } from "zod";
import { hasUnsafeText, SLUG_RE } from "@ai-career/ingestion";

export const CreateJobSourceSchema = z.object({
  kind: z.enum(["greenhouse", "lever"]),
  slug: z
    .string()
    .trim()
    .regex(SLUG_RE, "Board token may contain only letters, digits, hyphens and underscores (max 64 characters)"),
  companyName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^\u0000]*$/, "Company name may not contain null characters")
    // It is written into job_sources.config (jsonb), which rejects an unpaired surrogate outright:
    // reject it here as a 400 rather than letting the insert fail as an unhandled 500.
    .refine((s) => !hasUnsafeText(s), "Company name may not contain invalid Unicode characters")
    .optional(),
});

export const UpdateJobSourceSchema = z.object({
  enabled: z.boolean(),
  consentConfirmed: z.boolean().optional(),
});
