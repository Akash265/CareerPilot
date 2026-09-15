import { eq } from "drizzle-orm";
import { createDbClient, closeDbClient, withUserContext, schema } from "@ai-career/db";
import type { Env } from "@ai-career/config";
import type { CareerGoalConstraintsInput } from "./careerGoalConstraintsSchema";

export class CareerGoalNotFoundError extends Error {}

/**
 * Confirming a career goal never edits an existing career_goal_constraints
 * row (D23) -- it writes a brand-new one for the pending `career_goals` row
 * created at parse time (D24), then activates that goal and deactivates
 * whichever one was previously active. Older confirmed rows are left
 * untouched, preserving full version history.
 */
export async function confirmCareerGoal(
  env: Env,
  goalId: string,
  constraints: CareerGoalConstraintsInput
): Promise<void> {
  const db = createDbClient(env);
  try {
    await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      const [goal] = await tx
        .select({ id: schema.careerGoals.id })
        .from(schema.careerGoals)
        .where(eq(schema.careerGoals.id, goalId));
      if (!goal) {
        throw new CareerGoalNotFoundError(`No career_goals row with id ${goalId}`);
      }

      await tx
        .update(schema.careerGoals)
        .set({ isActive: false })
        .where(eq(schema.careerGoals.isActive, true));

      await tx.insert(schema.careerGoalConstraints).values({
        careerGoalId: goalId,
        targetRoles: constraints.targetRoles,
        seniority: constraints.seniority,
        locations: constraints.locations,
        workMode: constraints.workMode,
        minExperienceYears: constraints.minExperienceYears,
        employmentType: constraints.employmentType,
        salaryFloorRaw: constraints.salaryFloorRaw,
        salaryFloorNormalized:
          constraints.salaryFloorNormalized === null ? null : String(constraints.salaryFloorNormalized),
        salaryCurrency: constraints.salaryCurrency,
        salaryIsParsed: constraints.salaryIsParsed,
        visaSponsorshipRequired: constraints.visaSponsorshipRequired,
        skills: constraints.skills,
        preferredIndustries: constraints.preferredIndustries,
        excludedIndustries: constraints.excludedIndustries,
        preferredCompanies: constraints.preferredCompanies,
        excludedCompanies: constraints.excludedCompanies,
        hardConstraints: constraints.hardConstraints,
      });

      await tx
        .update(schema.careerGoals)
        .set({ confirmationStatus: "confirmed", isActive: true, confirmedAt: new Date() })
        .where(eq(schema.careerGoals.id, goalId));
    });
  } finally {
    await closeDbClient(db);
  }
}
