import { eq } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { hasUnsafeText } from "@ai-career/ingestion/text";
import { buildResumeSnapshot, ensureJobRequirements, JobRequirementExtractionValidationError } from "@ai-career/resume-optimization";
import { ensureCompanyResearch, type CompanyResearchWithFacts } from "../research/ensureCompanyResearch";
import { buildEvidenceIndex } from "../pitch/buildEvidenceIndex";
import { generatePitch, PitchGenerationValidationError } from "../pitch/generatePitch";
import { applyPitchGuard, type PitchGuardResult } from "../pitch/applyPitchGuard";
import { insertPitchVersion, type ApplicationPitchRow } from "./insertPitchVersion";

const { jobs, jobMatches } = schema;

export type PitchGenerationErrorClass = "no_match" | "not_eligible" | "no_profile" | "unknown";

export class PitchGenerationError extends Error {
  readonly errorClass: PitchGenerationErrorClass;
  constructor(errorClass: PitchGenerationErrorClass) {
    super(errorClass);
    this.name = "PitchGenerationError";
    this.errorClass = errorClass;
  }
}

export interface RunPitchGenerationEnv {
  ANTHROPIC_MODEL_FAST: string;
  ANTHROPIC_MODEL_RESEARCH: string;
  COMPANY_RESEARCH_MAX_SEARCHES: number;
}

export interface RunPitchGenerationOptions {
  userId: string;
  jobId: string;
  anthropicClient: Pick<Anthropic, "messages">;
  env: RunPitchGenerationEnv;
}

export interface RunPitchGenerationResult {
  pitch: ApplicationPitchRow;
  research: CompanyResearchWithFacts;
}

/**
 * One user-triggered pitch generation (design doc §4). Order matters: the cheap DB gates and the
 * profile check run BEFORE ensureCompanyResearch, so a user with no profile never triggers a paid web
 * search. Research failures never reach here as exceptions (ensureCompanyResearch stores them as a
 * status). Anthropic.APIError and the two validation errors map to "unknown" (→ 502, D57); anything
 * else is a bug and is rethrown.
 */
export async function runPitchGeneration(db: DbClient, opts: RunPitchGenerationOptions): Promise<RunPitchGenerationResult> {
  const { userId, jobId, anthropicClient, env } = opts;
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, userId, fn);

  const [match] = await inUserContext((tx) => tx.select().from(jobMatches).where(eq(jobMatches.jobId, jobId)).limit(1));
  if (!match) throw new PitchGenerationError("no_match");
  if (!match.eligible) throw new PitchGenerationError("not_eligible");

  const [job] = await inUserContext((tx) => tx.select().from(jobs).where(eq(jobs.id, jobId)).limit(1));
  if (!job) throw new PitchGenerationError("no_match");

  const snapshot = await inUserContext((tx) => buildResumeSnapshot(tx));
  if (snapshot.catalog.length === 0) throw new PitchGenerationError("no_profile");

  const research = await ensureCompanyResearch(db, userId, anthropicClient, env, {
    id: job.id, companyKey: job.companyKey, companyName: job.companyName, title: job.title,
  });

  let guard: PitchGuardResult;
  try {
    // Same accepted trade-off as runResumeOptimization: ensureJobRequirements may make an Anthropic
    // call inside this transaction, buying atomic replace-on-change of the job_requirements cache.
    const requirements = await inUserContext((tx) =>
      ensureJobRequirements(tx, env, anthropicClient, {
        id: job.id, title: job.title, descriptionText: job.descriptionText, descriptionHash: job.descriptionHash,
      })
    );
    const evidence = buildEvidenceIndex(research.facts, requirements, snapshot.catalog);
    const draft = await generatePitch(anthropicClient, env, { jobTitle: job.title, companyName: job.companyName, evidence });
    guard = applyPitchGuard(evidence, draft);
  } catch (error) {
    if (
      error instanceof Anthropic.APIError ||
      error instanceof JobRequirementExtractionValidationError ||
      error instanceof PitchGenerationValidationError
    ) {
      throw new PitchGenerationError("unknown");
    }
    throw error;
  }

  // D44 choke point: model-written bullet text goes into jsonb.
  if (hasUnsafeText(guard.bullets)) throw new PitchGenerationError("unknown");

  const pitch = await inUserContext((tx) =>
    insertPitchVersion(tx, userId, jobId, {
      origin: "generated",
      parentPitchId: null,
      companyResearchId: research.research.id,
      researchStatusSnapshot: research.research.status,
      researchedAtSnapshot: research.research.researchedAt,
      bullets: guard.bullets,
      requiresReview: guard.requiresReview,
      sourceProfileContentHash: snapshot.contentHash,
      generationModel: env.ANTHROPIC_MODEL_FAST,
    })
  );
  return { pitch, research };
}
