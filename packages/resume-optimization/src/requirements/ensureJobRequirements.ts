import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { schema, type DbClient } from "@ai-career/db";
import type { Env } from "@ai-career/config";
import { extractJobRequirements } from "./extractJobRequirements";

const { jobRequirements } = schema;

export interface JobForRequirements {
  id: string;
  title: string;
  descriptionText: string;
  descriptionHash: string;
}

/**
 * Returns this job's job_requirements rows, extracting (and replacing any stale set) only when no
 * row's extractionSourceDescriptionHash matches the job's current descriptionHash -- including the
 * never-extracted case, where there are simply no rows yet. This table is a full replace-on-change
 * cache (D58), not an update-in-place row like jobs.embeddingContentHash.
 */
export async function ensureJobRequirements(
  tx: DbClient,
  env: Pick<Env, "ANTHROPIC_MODEL_FAST">,
  anthropicClient: Pick<Anthropic, "messages">,
  job: JobForRequirements
): Promise<(typeof jobRequirements.$inferSelect)[]> {
  const existing = await tx.select().from(jobRequirements).where(eq(jobRequirements.jobId, job.id));
  const isFresh = existing.length > 0 && existing.every((r) => r.extractionSourceDescriptionHash === job.descriptionHash);
  if (isFresh) return existing;

  const draft = await extractJobRequirements(anthropicClient, env, job.title, job.descriptionText);

  await tx.delete(jobRequirements).where(eq(jobRequirements.jobId, job.id));
  if (draft.requirements.length === 0) return [];

  return tx
    .insert(jobRequirements)
    .values(
      draft.requirements.map((r) => ({
        jobId: job.id,
        termText: r.termText,
        termType: r.termType,
        requirementLevel: r.requirementLevel,
        evidenceQuote: r.evidenceQuote,
        extractionModel: env.ANTHROPIC_MODEL_FAST,
        extractionSourceDescriptionHash: job.descriptionHash,
      }))
    )
    .returning();
}
