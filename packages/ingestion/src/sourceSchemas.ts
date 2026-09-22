import { z } from "zod";

// Shapes verified against live boards on 2026-09-21 (see plan "Refinements").
// Schemas are deliberately lenient (`passthrough`, optional fields): they pin
// only what normalization reads, so an upstream field addition never breaks a run.

export const GreenhouseBoardResponseSchema = z.object({
  jobs: z.array(z.unknown()),
});

export const GreenhouseJobSchema = z
  .object({
    id: z.number(),
    title: z.string().trim().min(1),
    absolute_url: z.string().nullable().optional(),
    company_name: z.string().nullable().optional(),
    location: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
    // HTML, entity-escaped ("&lt;div&gt;...") -- see normalize/text.ts.
    content: z.string().nullable().optional(),
    first_published: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
  })
  .passthrough();

export const LeverPostingsResponseSchema = z.array(z.unknown());

export const LeverPostingSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().trim().min(1),
    hostedUrl: z.string().nullable().optional(),
    // Epoch milliseconds.
    createdAt: z.number().nullable().optional(),
    // ISO-3166 alpha-2 when Lever knows it.
    country: z.string().nullable().optional(),
    // "remote" | "hybrid" | "onsite" | "unspecified"
    workplaceType: z.string().nullable().optional(),
    openingPlain: z.string().nullable().optional(),
    descriptionPlain: z.string().nullable().optional(),
    descriptionBodyPlain: z.string().nullable().optional(),
    additionalPlain: z.string().nullable().optional(),
    categories: z
      .object({
        commitment: z.string().nullable().optional(),
        location: z.string().nullable().optional(),
        allLocations: z.array(z.string()).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    lists: z
      .array(z.object({ text: z.string().nullable().optional(), content: z.string().nullable().optional() }))
      .nullable()
      .optional(),
  })
  .passthrough();

/** The canonical row the upload parser produces from any CSV/JSON header spelling. */
export const UploadRowSchema = z.object({
  title: z.string().trim().min(1).max(500).regex(/^[^\u0000]*$/, "Title may not contain null characters"),
  company: z.string().trim().min(1).max(500).regex(/^[^\u0000]*$/, "Company may not contain null characters"),
  location: z.string().trim().max(500).regex(/^[^\u0000]*$/, "Location may not contain null characters").nullable().optional(),
  // No cap: the 10 MB file cap bounds it, and it is never indexed.
  description: z.string().regex(/^[^\u0000]*$/, "Description may not contain null characters").nullable().optional(),
  url: z.string().trim().max(2000).regex(/^[^\u0000]*$/, "URL may not contain null characters").nullable().optional(),
  postedAt: z.string().trim().max(100).regex(/^[^\u0000]*$/, "Posted date may not contain null characters").nullable().optional(),
  employmentType: z.string().trim().max(100).regex(/^[^\u0000]*$/, "Employment type may not contain null characters").nullable().optional(),
  salary: z.string().trim().max(200).regex(/^[^\u0000]*$/, "Salary may not contain null characters").nullable().optional(),
});
export type UploadRow = z.infer<typeof UploadRowSchema>;
