import { and, eq, max, sql } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { embedTexts } from "@ai-career/ai";
import { ensureJobRequirements } from "../requirements/ensureJobRequirements";
import { JobRequirementExtractionValidationError } from "../requirements/extractJobRequirements";
import { buildResumeSnapshot } from "../optimization/buildResumeSnapshot";
import { optimizeResume, OptimizeResumeValidationError, type RequirementForPrompt } from "../optimization/optimizeResume";
import { applyDeterministicGuard } from "../optimization/applyDeterministicGuard";
import { scoreKeywordCoverage } from "../evaluation/scoreKeywordCoverage";
import { scoreSemanticSimilarity } from "../evaluation/scoreSemanticSimilarity";
import { scoreFactualConsistency } from "../evaluation/scoreFactualConsistency";
import { scoreActionVerbsAndReadability } from "../evaluation/scoreActionVerbsAndReadability";
import { computeOverallScore } from "../evaluation/computeOverallScore";
import { EVALUATOR_VERSION } from "../types";

const { jobs, jobMatches, careerGoals, resumeOptimizations, atsEvaluations } = schema;

export type ResumeOptimizationErrorClass = "no_match" | "not_eligible" | "no_active_goal" | "unknown";

export class ResumeOptimizationError extends Error {
  readonly errorClass: ResumeOptimizationErrorClass;
  constructor(errorClass: ResumeOptimizationErrorClass) {
    super(errorClass);
    this.name = "ResumeOptimizationError";
    this.errorClass = errorClass;
  }
}

export interface RunResumeOptimizationEnv {
  ANTHROPIC_MODEL_FAST: string;
  EMBEDDING_PROVIDER: "voyage" | "self-hosted";
  VOYAGE_API_KEY?: string;
  VOYAGE_EMBEDDING_MODEL: string;
}

export interface RunResumeOptimizationOptions {
  userId: string;
  jobId: string;
  anthropicClient: Pick<Anthropic, "messages">;
  env: RunResumeOptimizationEnv;
}

export interface RunResumeOptimizationResult {
  optimization: typeof resumeOptimizations.$inferSelect;
  evaluation: typeof atsEvaluations.$inferSelect;
}

const num = (n: number): string => String(n);
const numOrNull = (n: number | null): string | null => (n === null ? null : String(n));

/**
 * ensureJobRequirements/optimizeResume errors (JobRequirementExtractionValidationError,
 * OptimizeResumeValidationError, Anthropic.APIError) are deliberately NOT swallowed here, unlike
 * runMatching's "skip this job's explanation, keep going" rule -- this is a single user-triggered
 * action on one job, not a batch run scoring many jobs, so there is nothing else to "keep going" to.
 * They are instead mapped to ResumeOptimizationError("unknown") (D57's lesson, same distinction
 * runMatching.ts's outer catch makes) so the caller (Task 12's API route) can tell "this call needs
 * to surface a 502 and let the user retry" apart from a genuine bug, which is rethrown unchanged.
 */
export async function runResumeOptimization(
  db: DbClient,
  opts: RunResumeOptimizationOptions
): Promise<RunResumeOptimizationResult> {
  const { userId, jobId, anthropicClient, env } = opts;
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, userId, fn);

  const [match] = await inUserContext((tx) => tx.select().from(jobMatches).where(eq(jobMatches.jobId, jobId)).limit(1));
  if (!match) throw new ResumeOptimizationError("no_match");
  if (!match.eligible) throw new ResumeOptimizationError("not_eligible");

  const [goal] = await inUserContext((tx) =>
    tx
      .select({ id: careerGoals.id })
      .from(careerGoals)
      .where(and(eq(careerGoals.isActive, true), eq(careerGoals.confirmationStatus, "confirmed")))
      .limit(1)
  );
  if (!goal) throw new ResumeOptimizationError("no_active_goal");

  const [job] = await inUserContext((tx) => tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1));
  if (!job) throw new ResumeOptimizationError("no_match");

  let requirementsForPrompt: RequirementForPrompt[];
  let snapshot: Awaited<ReturnType<typeof buildResumeSnapshot>>;
  let draft: Awaited<ReturnType<typeof optimizeResume>>;
  let guardResult: ReturnType<typeof applyDeterministicGuard>;
  try {
    // Deliberate trade-off: ensureJobRequirements' extractJobRequirements call (an Anthropic
    // round-trip, seconds not milliseconds) runs inside this withUserContext transaction, holding
    // the connection idle-in-transaction for the duration. Accepted because it buys atomicity for
    // the cache's delete-then-insert (D58's "replace on change" -- a request that dies mid-write
    // must never leave job_requirements half-replaced), and this is a single-job, user-triggered
    // action, not a hot path serving concurrent traffic on the same job.
    const requirements = await inUserContext((tx) =>
      ensureJobRequirements(tx, env, anthropicClient, {
        id: job.id, title: job.title, descriptionText: job.descriptionText, descriptionHash: job.descriptionHash,
      })
    );
    requirementsForPrompt = requirements.map((r) => ({
      termText: r.termText, requirementLevel: r.requirementLevel,
    }));

    snapshot = await inUserContext((tx) => buildResumeSnapshot(tx));

    draft = await optimizeResume(anthropicClient, env, {
      jobTitle: job.title, companyName: job.companyName, requirements: requirementsForPrompt, catalog: snapshot.catalog,
    });
    guardResult = applyDeterministicGuard(snapshot.catalog, draft);
  } catch (error) {
    if (
      error instanceof Anthropic.APIError ||
      error instanceof JobRequirementExtractionValidationError ||
      error instanceof OptimizeResumeValidationError
    ) {
      throw new ResumeOptimizationError("unknown");
    }
    throw error;
  }

  const combinedOptimizedText = guardResult.appliedBullets.map((b) => b.optimizedText).join("\n");
  const keywordCoverage = scoreKeywordCoverage(requirementsForPrompt, combinedOptimizedText);

  let semanticSimilarity: number | null = null;
  if (job.embedding !== null && combinedOptimizedText.trim().length > 0) {
    try {
      const [resumeEmbedding] = await embedTexts(env, [combinedOptimizedText]);
      semanticSimilarity = scoreSemanticSimilarity(job.embedding, resumeEmbedding ?? null);
    } catch {
      // Same "degrade, never block" rule as ensureJobEmbeddings: a Voyage outage leaves
      // semanticSimilarity null (computeOverallScore redistributes its weight) rather than failing
      // the whole optimization.
      semanticSimilarity = null;
    }
  }

  const factualConsistency = scoreFactualConsistency(guardResult.appliedBullets.length, guardResult.rejectedClaims.length);
  const { actionVerbScore, machineReadabilityScore } = scoreActionVerbsAndReadability(guardResult.appliedBullets);
  const overallScore = computeOverallScore({
    requiredKeywordCoverage: keywordCoverage.requiredKeywordCoverage,
    preferredKeywordCoverage: keywordCoverage.preferredKeywordCoverage,
    semanticSimilarity, factualConsistency, actionVerbScore, machineReadabilityScore,
  });

  return inUserContext(async (tx) => {
    // Serializes version allocation per (user, job) for this transaction's lifetime -- same
    // "two simultaneous requests read the same max(version)" race lockUserCareerGoals.ts solves for
    // career goals (D23/D24), reimplemented here scoped by user+job so unrelated jobs/users are
    // never serialized against each other.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('resume_optimizations'), hashtext(${userId} || ':' || ${jobId}))`);

    const [{ maxVersion }] = await tx
      .select({ maxVersion: max(resumeOptimizations.version) })
      .from(resumeOptimizations)
      .where(eq(resumeOptimizations.jobId, jobId));
    const nextVersion = (maxVersion ?? 0) + 1;

    const [optimization] = await tx
      .insert(resumeOptimizations)
      .values({
        jobId,
        careerGoalId: goal.id,
        version: nextVersion,
        sourceProfileContentHash: snapshot.contentHash,
        selectedBullets: guardResult.appliedBullets,
        addedTerms: draft.addedTerms,
        unsupportedClaimsDetected: draft.unsupportedClaimsDetected,
        // OR, never AND: the model's own self-report can only ADD caution here, never remove it --
        // the authoritative signals remain unsupportedClaimsDetected and the guard's own rejections
        // (D61/D63), but a model that sets requiresReview:true for a reason it didn't otherwise
        // report should still have that flag land on the persisted row rather than be discarded.
        requiresReview: draft.requiresReview || draft.unsupportedClaimsDetected.length > 0 || guardResult.rejectedClaims.length > 0,
        rejectedClaims: guardResult.rejectedClaims,
        generationModel: env.ANTHROPIC_MODEL_FAST,
      })
      .returning();

    const [evaluation] = await tx
      .insert(atsEvaluations)
      .values({
        resumeOptimizationId: optimization.id,
        requiredKeywordCoverage: num(keywordCoverage.requiredKeywordCoverage),
        preferredKeywordCoverage: num(keywordCoverage.preferredKeywordCoverage),
        semanticSimilarity: numOrNull(semanticSimilarity),
        factualConsistency: num(factualConsistency),
        actionVerbScore: num(actionVerbScore),
        machineReadabilityScore: num(machineReadabilityScore),
        overallScore: num(overallScore),
        evaluatorVersion: EVALUATOR_VERSION,
      })
      .returning();

    return { optimization, evaluation };
  });
}
