import { z } from "zod";

const ConstraintsObjectSchema = z.object({
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
  salaryTargetRaw: z.string().nullable(),
  salaryTargetNormalized: z.number().nonnegative().nullable(),
  salaryTargetCurrency: z.string().nullable(),
  salaryTargetIsParsed: z.boolean(),
  visaSponsorshipRequired: z.boolean().nullable(),
  skills: z.array(z.string()),
  preferredIndustries: z.array(z.string()),
  excludedIndustries: z.array(z.string()),
  preferredCompanies: z.array(z.string()),
  excludedCompanies: z.array(z.string()),
  hardConstraints: z.array(z.string()),
});

// A preferred salary below the minimum is self-contradictory, so it can only be
// a mis-extraction or a typo the review step should catch. Amounts are only
// comparable when both are known and in the same currency.
export const CareerGoalConstraintsSchema = ConstraintsObjectSchema.superRefine((c, ctx) => {
  if (
    c.salaryFloorNormalized !== null &&
    c.salaryTargetNormalized !== null &&
    c.salaryCurrency !== null &&
    c.salaryCurrency === c.salaryTargetCurrency &&
    c.salaryTargetNormalized < c.salaryFloorNormalized
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["salaryTargetNormalized"],
      message: "Preferred salary cannot be lower than the minimum salary",
    });
  }
});

export type CareerGoalConstraintsInput = z.infer<typeof CareerGoalConstraintsSchema>;

export const ConfirmCareerGoalSchema = z.object({
  goalId: z.string().uuid(),
  constraints: CareerGoalConstraintsSchema,
});
