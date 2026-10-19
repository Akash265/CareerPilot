import { and, asc, eq, sql } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { AiBudgetExceededError, type AnthropicFor } from "@ai-career/ai";
import { ensureJobRequirements, type JobForRequirements } from "../requirements/ensureJobRequirements";

const { jobMatches, jobs } = schema;

export interface TopMatchJob extends JobForRequirements {
  companyName: string;
}

/** Phase 13b: the jobs /skills lists gaps for -- open, eligible matches, highest score first (ties by job id). */
export async function selectTopMatchJobs(tx: DbClient, limit: number): Promise<TopMatchJob[]> {
  return tx
    .select({
      id: jobs.id, title: jobs.title, companyName: jobs.companyName,
      descriptionText: jobs.descriptionText, descriptionHash: jobs.descriptionHash,
    })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobMatches.jobId, jobs.id))
    .where(and(eq(jobMatches.eligible, true), eq(jobs.status, "open")))
    .orderBy(sql`${jobMatches.overallScore} DESC NULLS LAST`, asc(jobs.id))
    .limit(limit);
}

export interface TopMatchRequirementsResult {
  jobs: number;
  failed: number;
  budgetStopped: boolean;
}

/**
 * Phase 13b design §6.1 (R3: called after the matching job completes, never inside it). One transaction per job, as
 * runResumeOptimization does, so a request that dies mid-write never leaves job_requirements half-replaced (D58).
 * ensureJobRequirements is a no-op for a job whose requirements match its description hash. A job's failure is
 * reported and skipped; the AI budget stops the remaining jobs.
 */
export async function ensureTopMatchRequirements(
  db: DbClient,
  opts: {
    userId: string;
    env: { ANTHROPIC_MODEL_FAST: string; SKILL_GAP_TOP_N: number };
    anthropicFor: AnthropicFor;
    onJobError?: (jobId: string, error: unknown) => void;
  }
): Promise<TopMatchRequirementsResult> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, opts.userId, fn);
  const top = await inUserContext((tx) => selectTopMatchJobs(tx, opts.env.SKILL_GAP_TOP_N));
  let failed = 0;
  for (const job of top) {
    try {
      await inUserContext((tx) => ensureJobRequirements(tx, opts.env, opts.anthropicFor("job_requirements_extraction"), job));
    } catch (error) {
      if (error instanceof AiBudgetExceededError) return { jobs: top.length, failed, budgetStopped: true };
      failed++;
      opts.onJobError?.(job.id, error);
    }
  }
  return { jobs: top.length, failed, budgetStopped: false };
}
