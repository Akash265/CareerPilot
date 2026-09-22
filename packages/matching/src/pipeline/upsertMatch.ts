import { schema, type DbClient } from "@ai-career/db";
import type { FactorScores } from "../types";

const { jobMatches } = schema;

export type ExistingMatchRow = typeof jobMatches.$inferSelect;

/** Drizzle's `numeric` columns are typed as strings (avoids float rounding on read/write). */
const numOrNull = (n: number | null | undefined): string | null => (n === null || n === undefined ? null : String(n));

export interface UpsertMatchRowInput {
  jobId: string;
  careerGoalId: string;
  eligible: boolean;
  ineligibleReason: string | null;
  factors: FactorScores | null;
  overallScore: number | null;
  computedAt: Date;
  /** The row from before this run touched it, if one exists -- Refinement #4 carries its userAction/explanation forward. */
  existing: ExistingMatchRow | undefined;
}

/** One row per (user, job), overwritten in place via the `job_matches_user_job_uniq` index. */
export async function upsertMatchRow(tx: DbClient, input: UpsertMatchRowInput): Promise<void> {
  const carriedForward = {
    userAction: input.existing?.userAction ?? ("none" as const),
    userActionAt: input.existing?.userActionAt ?? null,
    explanation: input.existing?.explanation ?? null,
    explanationModel: input.existing?.explanationModel ?? null,
    explanationDescriptionHash: input.existing?.explanationDescriptionHash ?? null,
    explanationGeneratedAt: input.existing?.explanationGeneratedAt ?? null,
  };
  const values = {
    jobId: input.jobId,
    careerGoalId: input.careerGoalId,
    eligible: input.eligible,
    ineligibleReason: input.ineligibleReason,
    skillsScore: numOrNull(input.factors?.skillsScore),
    experienceScore: numOrNull(input.factors?.experienceScore),
    locationScore: numOrNull(input.factors?.locationScore),
    sponsorshipScore: numOrNull(input.factors?.sponsorshipScore),
    roleScore: numOrNull(input.factors?.roleScore),
    salaryScore: numOrNull(input.factors?.salaryScore),
    industryScore: numOrNull(input.factors?.industryScore),
    freshnessScore: numOrNull(input.factors?.freshnessScore),
    semanticScore: numOrNull(input.factors?.semanticScore),
    overallScore: numOrNull(input.overallScore),
    computedAt: input.computedAt,
    ...carriedForward,
  };
  await tx
    .insert(jobMatches)
    .values(values)
    .onConflictDoUpdate({ target: [jobMatches.userId, jobMatches.jobId], set: values });
}
