import { eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { AnthropicFor } from "@ai-career/ai";
import {
  buildResumeSnapshot, ensureJobRequirements, JobRequirementExtractionValidationError, type ResumeSnapshot,
} from "@ai-career/resume-optimization";
import { ensureCompanyResearch, type CompanyResearchWithFacts } from "../research/ensureCompanyResearch";
import { buildEvidenceIndex, type PitchEvidenceItem } from "../pitch/buildEvidenceIndex";
import { ApplicationGenerationError } from "./generationError";

const { jobs, jobMatches } = schema;

export type JobRow = typeof jobs.$inferSelect;
export type JobRequirementRow = (typeof schema.jobRequirements)["$inferSelect"];

export interface ApplicationContextEnv {
  ANTHROPIC_MODEL_FAST: string;
  ANTHROPIC_MODEL_RESEARCH: string;
  COMPANY_RESEARCH_MAX_SEARCHES: number;
}

export interface PrepareApplicationContextOptions {
  userId: string;
  jobId: string;
  /** One labelled, budget-checked Anthropic client per operation (Phase 11a). */
  anthropicFor: AnthropicFor;
  env: ApplicationContextEnv;
}

export interface ApplicationContext {
  job: JobRow;
  snapshot: ResumeSnapshot;
  research: CompanyResearchWithFacts;
  requirements: JobRequirementRow[];
  evidence: PitchEvidenceItem[];
}

/**
 * The generic half of every application-package generation (Phase 7c design §4.1, extracted from Phase
 * 7a's runPitchGeneration). Order matters: the cheap DB gates and the profile check run BEFORE
 * ensureCompanyResearch, so a user with no profile never triggers a paid web search. Research failures
 * never surface here (they are stored as a status). ensureJobRequirements' Anthropic.APIError and
 * validation error map to "unknown" (→ 502, D57); anything else is a bug and is rethrown -- including
 * AiBudgetExceededError (Phase 11a), which the routes answer with 429.
 */
export async function prepareApplicationContext(db: DbClient, opts: PrepareApplicationContextOptions): Promise<ApplicationContext> {
  const { userId, jobId, anthropicFor, env } = opts;
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, userId, fn);

  const [match] = await inUserContext((tx) => tx.select().from(jobMatches).where(eq(jobMatches.jobId, jobId)).limit(1));
  if (!match) throw new ApplicationGenerationError("no_match");
  if (!match.eligible) throw new ApplicationGenerationError("not_eligible");

  const [job] = await inUserContext((tx) => tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1));
  if (!job) throw new ApplicationGenerationError("no_match");

  const snapshot = await inUserContext((tx) => buildResumeSnapshot(tx));
  if (snapshot.catalog.length === 0) throw new ApplicationGenerationError("no_profile");

  const research = await ensureCompanyResearch(db, userId, anthropicFor("company_research"), env, {
    id: job.id, companyKey: job.companyKey, companyName: job.companyName, title: job.title,
  });

  let requirements: JobRequirementRow[];
  try {
    // Same accepted trade-off as runResumeOptimization: ensureJobRequirements may make an Anthropic
    // call inside this transaction, buying atomic replace-on-change of the job_requirements cache.
    requirements = await inUserContext((tx) =>
      ensureJobRequirements(tx, env, anthropicFor("job_requirements_extraction"), {
        id: job.id, title: job.title, descriptionText: job.descriptionText, descriptionHash: job.descriptionHash,
        requirementsExtractedHash: job.requirementsExtractedHash,
      })
    );
  } catch (error) {
    if (error instanceof Anthropic.APIError || error instanceof JobRequirementExtractionValidationError) {
      throw new ApplicationGenerationError("unknown");
    }
    throw error;
  }

  const evidence = buildEvidenceIndex(research.facts, requirements, snapshot.catalog);
  return { job, snapshot, research, requirements, evidence };
}
