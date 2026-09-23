import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { evaluateEligibility } from "../eligibility/evaluateEligibility";
import { scoreSkills } from "../scoring/scoreSkills";
import { scoreExperience } from "../scoring/scoreExperience";
import { scoreLocation } from "../scoring/scoreLocation";
import { scoreSponsorship } from "../scoring/scoreSponsorship";
import { scoreRole } from "../scoring/scoreRole";
import { scoreSalary } from "../scoring/scoreSalary";
import { scoreIndustry } from "../scoring/scoreIndustry";
import { scoreFreshness } from "../scoring/scoreFreshness";
import { scoreSemantic } from "../scoring/scoreSemantic";
import { computeOverallScore } from "../scoring/computeOverallScore";
import { ensureGoalEmbedding } from "../embeddings/ensureGoalEmbedding";
import { ensureJobEmbeddings } from "../embeddings/ensureJobEmbeddings";
import { fetchCandidateJobs, type CandidateJobRow } from "../retrieval/fetchCandidateJobs";
import { generateMatchExplanation, MatchExplanationValidationError } from "../explanation/generateMatchExplanation";
import { isExplanationStale } from "../explanation/explanationStaleness";
import { upsertMatchRow, type ExistingMatchRow } from "./upsertMatch";
import type { FactorScores } from "../types";

const { careerGoals, careerGoalConstraints, candidateProfiles, jobMatches, matchingRuns } = schema;
const MS_PER_DAY = 86_400_000;
const num = (value: string | null): number | null => (value === null ? null : Number(value));

export type MatchingErrorClass = "no_active_goal" | "unknown";

export class MatchingError extends Error {
  readonly errorClass: MatchingErrorClass;
  constructor(errorClass: MatchingErrorClass) {
    super(errorClass);
    this.name = "MatchingError";
    this.errorClass = errorClass;
  }
}

export interface RunMatchingEnv {
  ANTHROPIC_MODEL_FAST: string;
  EMBEDDING_PROVIDER: "voyage" | "self-hosted";
  VOYAGE_API_KEY?: string;
  VOYAGE_EMBEDDING_MODEL: string;
  MATCHING_EXPLAIN_TOP_N: number;
  MATCHING_EXPERIENCE_GRACE_YEARS: number;
  MATCHING_FRESHNESS_HALF_LIFE_HOURS: number;
  MATCHING_EXPLANATION_TTL_DAYS: number;
}

export interface RunMatchingOptions {
  userId: string;
  anthropicClient: Pick<Anthropic, "messages">;
  env: RunMatchingEnv;
  now?: () => Date;
}

export interface MatchingRunSummary {
  runId: string;
  status: "completed" | "failed";
  errorClass: MatchingErrorClass | null;
  jobsEvaluated: number;
  jobsEligible: number;
  jobsExplained: number;
  jobsEmbedded: number;
  jobsEmbeddingFailed: number;
}

interface ScoredJob {
  jobId: string;
  job: CandidateJobRow;
  factors: FactorScores;
  overallScore: number;
  skillMatches: { skill: string; found: boolean }[];
}

/**
 * One guard -> ensure embeddings -> eligibility+score every open job -> explain the top N -> finalize
 * cycle for a user's active career goal. Throws `MatchingError` (a class only) when the run fails,
 * after recording it -- same shape as packages/ingestion's `runIngestion`.
 */
export async function runMatching(db: DbClient, opts: RunMatchingOptions): Promise<MatchingRunSummary> {
  const { userId, env, anthropicClient } = opts;
  const now = opts.now ?? (() => new Date());
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, userId, fn);

  const [goal] = await inUserContext((tx) =>
    tx
      .select({ id: careerGoals.id })
      .from(careerGoals)
      .where(and(eq(careerGoals.isActive, true), eq(careerGoals.confirmationStatus, "confirmed")))
      .limit(1)
  );
  if (!goal) throw new MatchingError("no_active_goal");

  const startedAt = now();
  const [run] = await inUserContext((tx) =>
    tx.insert(matchingRuns).values({ careerGoalId: goal.id, startedAt }).returning({ id: matchingRuns.id })
  );

  const counters = { evaluated: 0, eligible: 0, explained: 0, embedded: 0, embeddingFailed: 0 };
  const finish = (status: "completed" | "failed", errorClass: MatchingErrorClass | null) =>
    inUserContext((tx) =>
      tx
        .update(matchingRuns)
        .set({
          finishedAt: now(),
          status,
          errorClass,
          jobsEvaluated: counters.evaluated,
          jobsEligible: counters.eligible,
          jobsExplained: counters.explained,
          jobsEmbedded: counters.embedded,
          jobsEmbeddingFailed: counters.embeddingFailed,
        })
        .where(eq(matchingRuns.id, run.id))
    );

  try {
    const [constraints] = await inUserContext((tx) =>
      tx.select().from(careerGoalConstraints).where(eq(careerGoalConstraints.careerGoalId, goal.id)).limit(1)
    );
    if (!constraints) throw new MatchingError("no_active_goal");

    const [profile] = await inUserContext((tx) =>
      tx.select({ yearsOfExperience: candidateProfiles.yearsOfExperience }).from(candidateProfiles).limit(1)
    );
    const candidateYears = profile?.yearsOfExperience ?? null;

    const goalEmbedding = await inUserContext((tx) => ensureGoalEmbedding(tx, env, constraints.id));

    const initialRows = await inUserContext((tx) => fetchCandidateJobs(tx, goalEmbedding));
    const embeddingResult = await inUserContext((tx) => ensureJobEmbeddings(tx, env, initialRows.map((r) => r.id)));
    counters.embedded = embeddingResult.embedded;
    counters.embeddingFailed = embeddingResult.failed;
    // Re-fetch so a job embedded just now is reflected in this run's semantic similarity.
    const rows = goalEmbedding ? await inUserContext((tx) => fetchCandidateJobs(tx, goalEmbedding)) : initialRows;

    const existingRows = await inUserContext((tx) => tx.select().from(jobMatches));
    const existingByJobId = new Map<string, ExistingMatchRow>(existingRows.map((r) => [r.jobId, r]));

    const scored: ScoredJob[] = [];

    for (const job of rows) {
      counters.evaluated++;
      const existing = existingByJobId.get(job.id);
      const eligibility = evaluateEligibility({
        companyName: job.companyName,
        jobWorkMode: job.workMode,
        jobMinExperienceYears: job.minExperienceYears,
        jobSponsorship: job.sponsorship,
        excludedCompanies: constraints.excludedCompanies,
        excludedIndustries: constraints.excludedIndustries,
        constraintsWorkMode: constraints.workMode,
        visaSponsorshipRequired: constraints.visaSponsorshipRequired,
        candidateYearsOfExperience: candidateYears,
        experienceGraceYears: env.MATCHING_EXPERIENCE_GRACE_YEARS,
        previouslyDismissed: existing?.userAction === "dismissed",
      });

      if (!eligibility.eligible) {
        await inUserContext((tx) =>
          upsertMatchRow(tx, {
            jobId: job.id, careerGoalId: goal.id, eligible: false, ineligibleReason: eligibility.reason,
            factors: null, overallScore: null, computedAt: now(), existing,
          })
        );
        continue;
      }
      counters.eligible++;

      const skills = scoreSkills(constraints.skills, job.title, job.descriptionText, job.semanticSimilarity);
      const factors: FactorScores = {
        skillsScore: skills.score,
        experienceScore: scoreExperience(job.minExperienceYears, candidateYears, env.MATCHING_EXPERIENCE_GRACE_YEARS),
        locationScore: scoreLocation(job.workMode, constraints.workMode, job.locationRaw, job.countryCode, constraints.locations),
        sponsorshipScore: scoreSponsorship(constraints.visaSponsorshipRequired, job.sponsorship),
        roleScore: scoreRole(constraints.targetRoles, job.title),
        salaryScore: scoreSalary({
          jobMin: job.salaryMin, jobMax: job.salaryMax, jobCurrency: job.salaryCurrency, jobIsParsed: job.salaryIsParsed,
          floorNormalized: num(constraints.salaryFloorNormalized), floorCurrency: constraints.salaryCurrency, floorIsParsed: constraints.salaryIsParsed,
          targetNormalized: num(constraints.salaryTargetNormalized), targetCurrency: constraints.salaryTargetCurrency, targetIsParsed: constraints.salaryTargetIsParsed,
        }),
        industryScore: scoreIndustry(job.companyName, constraints.preferredIndustries),
        freshnessScore: scoreFreshness(job.postedAt, job.firstSeenAt, env.MATCHING_FRESHNESS_HALF_LIFE_HOURS, now()),
        semanticScore: scoreSemantic(job.semanticSimilarity),
      };
      const overallScore = computeOverallScore(factors);

      await inUserContext((tx) =>
        upsertMatchRow(tx, {
          jobId: job.id, careerGoalId: goal.id, eligible: true, ineligibleReason: null,
          factors, overallScore, computedAt: now(), existing,
        })
      );
      scored.push({ jobId: job.id, job, factors, overallScore, skillMatches: skills.matches });
    }

    scored.sort((a, b) => b.overallScore - a.overallScore);
    const stale = scored.filter((s) =>
      isExplanationStale({
        existing: existingByJobId.get(s.jobId),
        activeCareerGoalId: goal.id,
        currentDescriptionHash: s.job.descriptionHash,
        now: now(),
        ttlDays: env.MATCHING_EXPLANATION_TTL_DAYS,
      })
    );
    const toExplain = stale.slice(0, env.MATCHING_EXPLAIN_TOP_N);

    for (const item of toExplain) {
      try {
        const referenceDate = item.job.postedAt ?? item.job.firstSeenAt;
        const draft = await generateMatchExplanation(anthropicClient, env, {
          jobTitle: item.job.title,
          companyName: item.job.companyName,
          overallScore: item.overallScore,
          skillMatches: item.skillMatches,
          experience: { requiredYears: item.job.minExperienceYears, candidateYears },
          workMode: { job: item.job.workMode, goal: constraints.workMode },
          sponsorship: { required: constraints.visaSponsorshipRequired, job: item.job.sponsorship },
          salary: { comparable: item.factors.salaryScore !== null, withinRange: item.factors.salaryScore === null ? null : item.factors.salaryScore >= 0.6 },
          freshnessDays: Math.round((now().getTime() - referenceDate.getTime()) / MS_PER_DAY),
        });
        await inUserContext((tx) =>
          tx
            .update(jobMatches)
            .set({ explanation: draft, explanationModel: env.ANTHROPIC_MODEL_FAST, explanationDescriptionHash: item.job.descriptionHash, explanationGeneratedAt: now() })
            .where(eq(jobMatches.jobId, item.jobId))
        );
        counters.explained++;
      } catch (error) {
        // A malformed response leaves the row's deterministic scores intact -- never blocks the run.
        // Anything else (e.g. a network error) is unexpected and does fail the run, same as
        // runIngestion's "anything not IngestError is wrapped as unknown" rule.
        if (!(error instanceof MatchExplanationValidationError)) throw error;
      }
    }

    await finish("completed", null);
    return {
      runId: run.id,
      status: "completed",
      errorClass: null,
      jobsEvaluated: counters.evaluated,
      jobsEligible: counters.eligible,
      jobsExplained: counters.explained,
      jobsEmbedded: counters.embedded,
      jobsEmbeddingFailed: counters.embeddingFailed,
    };
  } catch (error) {
    const failure = error instanceof MatchingError ? error : new MatchingError("unknown");
    await finish("failed", failure.errorClass).catch(() => undefined);
    throw failure;
  }
}
