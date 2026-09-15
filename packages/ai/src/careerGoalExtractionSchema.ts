import { z } from "zod";

export const CareerGoalExtractionSchema = z.object({
  targetRoles: z.array(z.string()),
  seniority: z.string().nullable(),
  locations: z.array(z.string()),
  workMode: z.enum(["remote", "hybrid", "onsite", "any"]),
  minExperienceYears: z.number().int().nonnegative().nullable(),
  employmentType: z.string().nullable(),
  // Deliberately a raw phrase, never a number -- see parseSalaryFloor.ts (D22).
  salaryFloorRaw: z.string().nullable(),
  visaSponsorshipRequired: z.boolean().nullable(),
  skills: z.array(z.string()),
  preferredIndustries: z.array(z.string()),
  excludedIndustries: z.array(z.string()),
  preferredCompanies: z.array(z.string()),
  excludedCompanies: z.array(z.string()),
  hardConstraints: z.array(z.string()),
});

export type CareerGoalExtractionDraft = z.infer<typeof CareerGoalExtractionSchema>;
