import { eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import type { Env } from "@ai-career/config";
import type { MessagesClient } from "@ai-career/ai";
import { extractJobRequirements } from "./extractJobRequirements";

const { jobRequirements, jobs } = schema;

export interface JobForRequirements {
  id: string;
  title: string;
  descriptionText: string;
  descriptionHash: string;
  /** jobs.requirements_extracted_hash: set after any successful extraction, even one with zero requirements (D205). */
  requirementsExtractedHash?: string | null;
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
  anthropicClient: MessagesClient,
  job: JobForRequirements
): Promise<(typeof jobRequirements.$inferSelect)[]> {
  const existing = await tx.select().from(jobRequirements).where(eq(jobRequirements.jobId, job.id));
  const rowsFresh = existing.length > 0 && existing.every((r) => r.extractionSourceDescriptionHash === job.descriptionHash);
  // D205: a zero-requirement extraction leaves no rows, so the job's own hash column records it.
  const markedFresh = job.requirementsExtractedHash != null && job.requirementsExtractedHash === job.descriptionHash;
  if (rowsFresh || (markedFresh && existing.length === 0)) return existing;

  const draft = await extractJobRequirements(anthropicClient, env, job.title, job.descriptionText);

  await tx.delete(jobRequirements).where(eq(jobRequirements.jobId, job.id));
  await tx.update(jobs).set({ requirementsExtractedHash: job.descriptionHash }).where(eq(jobs.id, job.id));
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
