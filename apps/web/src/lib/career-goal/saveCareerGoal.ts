import { eq } from "drizzle-orm";
import { createDbClient, closeDbClient, withUserContext, schema } from "@ai-career/db";
import type { Env } from "@ai-career/config";
import type { CareerGoalConstraintsInput } from "./careerGoalConstraintsSchema";
import { lockUserCareerGoals } from "./lockUserCareerGoals";

export class CareerGoalNotFoundError extends Error {}

export type CareerGoalStateProblem = "not-parsed" | "already-confirmed";

const STATE_PROBLEM_MESSAGES: Record<CareerGoalStateProblem, string> = {
  "not-parsed": "Career goal was not parsed successfully and cannot be confirmed",
  "already-confirmed": "Career goal is already confirmed; submit a new goal statement to create a new version",
};

export class CareerGoalStateError extends Error {
  constructor(readonly problem: CareerGoalStateProblem) {
    super(STATE_PROBLEM_MESSAGES[problem]);
  }
}

/**
 * Confirming a career goal never edits an existing career_goal_constraints
 * row (D23) -- it writes a brand-new one for the pending `career_goals` row
 * created at parse time (D24), then activates that goal and deactivates
 * whichever one was previously active. Older confirmed rows are left
 * untouched, preserving full version history.
 *
 * Only a goal that parsed successfully and is not yet confirmed can be
 * confirmed. The user's goals are locked for the whole transaction
 * (lockUserCareerGoals) so simultaneous confirms serialize: two different goals
 * cannot both end up active, and the second confirm of the same goal sees it
 * already confirmed and gets a CareerGoalStateError rather than tripping the
 * unique constraint on career_goal_constraints.career_goal_id.
 */
export async function confirmCareerGoal(
  env: Env,
  goalId: string,
  constraints: CareerGoalConstraintsInput
): Promise<void> {
  const db = createDbClient(env);
  try {
    await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      await lockUserCareerGoals(tx, env.DEFAULT_USER_ID);
      const [goal] = await tx
        .select({
          parseStatus: schema.careerGoals.parseStatus,
          confirmationStatus: schema.careerGoals.confirmationStatus,
        })
        .from(schema.careerGoals)
        .where(eq(schema.careerGoals.id, goalId))
        .for("update");
      if (!goal) {
        throw new CareerGoalNotFoundError(`No career_goals row with id ${goalId}`);
      }
      if (goal.confirmationStatus === "confirmed") {
        throw new CareerGoalStateError("already-confirmed");
      }
      if (goal.parseStatus !== "parsed") {
        throw new CareerGoalStateError("not-parsed");
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
        salaryTargetRaw: constraints.salaryTargetRaw,
        salaryTargetNormalized:
          constraints.salaryTargetNormalized === null ? null : String(constraints.salaryTargetNormalized),
        salaryTargetCurrency: constraints.salaryTargetCurrency,
        salaryTargetIsParsed: constraints.salaryTargetIsParsed,
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
