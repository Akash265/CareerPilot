import { z } from "zod";

export const CareerGoalConstraintsSchema = z.object({
  targetRoles: z.array(z.string()),
  seniority: z.string().nullable(),
  locations: z.array(z.string()),
  workMode: z.enum(["remote", "hybrid", "onsite", "any"]),
  minExperienceYears: z.number().int().nonnegative().nullable(),
  employmentType: z.string().nullable(),
  salaryFloorRaw: z.string().nullable(),
  salaryFloorNormalized: z.number().nonnegative().nullable(),
  salaryCurrency: z.string().nullable(),
  salaryIsParsed: z.boolean(),
  visaSponsorshipRequired: z.boolean().nullable(),
  skills: z.array(z.string()),
  preferredIndustries: z.array(z.string()),
  excludedIndustries: z.array(z.string()),
  preferredCompanies: z.array(z.string()),
  excludedCompanies: z.array(z.string()),
  hardConstraints: z.array(z.string()),
});

export type CareerGoalConstraintsInput = z.infer<typeof CareerGoalConstraintsSchema>;

export const ConfirmCareerGoalSchema = z.object({
  goalId: z.string().uuid(),
  constraints: CareerGoalConstraintsSchema,
});
