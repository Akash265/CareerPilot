import { desc, eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";

function toConstraintsPayload(row: typeof schema.careerGoalConstraints.$inferSelect) {
  return {
    targetRoles: row.targetRoles,
    seniority: row.seniority,
    locations: row.locations,
    workMode: row.workMode,
    minExperienceYears: row.minExperienceYears,
    employmentType: row.employmentType,
    salaryFloorRaw: row.salaryFloorRaw,
    // Postgres `numeric` round-trips as a string through postgres-js --
    // coerce explicitly, same as candidateProfiles.salaryExpectationMin did
    // in Phase 2's serializeProfile.ts before it was retired.
    salaryFloorNormalized: row.salaryFloorNormalized === null ? null : Number(row.salaryFloorNormalized),
    salaryCurrency: row.salaryCurrency,
    salaryIsParsed: row.salaryIsParsed,
    salaryTargetRaw: row.salaryTargetRaw,
    salaryTargetNormalized: row.salaryTargetNormalized === null ? null : Number(row.salaryTargetNormalized),
    salaryTargetCurrency: row.salaryTargetCurrency,
    salaryTargetIsParsed: row.salaryTargetIsParsed,
    visaSponsorshipRequired: row.visaSponsorshipRequired,
    skills: row.skills,
    preferredIndustries: row.preferredIndustries,
    excludedIndustries: row.excludedIndustries,
    preferredCompanies: row.preferredCompanies,
    excludedCompanies: row.excludedCompanies,
    hardConstraints: row.hardConstraints,
  };
}

export async function getCareerGoalState(tx: DbClient) {
  const goals = await tx
    .select()
    .from(schema.careerGoals)
    .where(eq(schema.careerGoals.confirmationStatus, "confirmed"))
    .orderBy(desc(schema.careerGoals.version));

  const activeGoalRow = goals.find((g) => g.isActive) ?? null;
  let activeGoal = null;
  if (activeGoalRow) {
    const [constraintsRow] = await tx
      .select()
      .from(schema.careerGoalConstraints)
      .where(eq(schema.careerGoalConstraints.careerGoalId, activeGoalRow.id));
    // confirmCareerGoal writes the constraints row and activates the goal in one
    // transaction, so this cannot happen short of manual tampering. Failing loudly
    // is deliberate: silently returning "no goal" would look like data loss.
    if (!constraintsRow) {
      throw new Error(`Active career goal ${activeGoalRow.id} has no constraints row`);
    }
    activeGoal = {
      id: activeGoalRow.id,
      version: activeGoalRow.version,
      rawText: activeGoalRow.rawText,
      confirmedAt: activeGoalRow.confirmedAt,
      constraints: toConstraintsPayload(constraintsRow),
    };
  }

  const history = goals.map((g) => ({
    id: g.id,
    version: g.version,
    rawText: g.rawText,
    confirmedAt: g.confirmedAt,
  }));

  return { activeGoal, history };
}
