import { eq, inArray, and, ne, isNull, or } from "drizzle-orm";
import { embedTexts } from "@ai-career/ai";
import { schema, type DbClient } from "@ai-career/db";
import type { Env } from "@ai-career/config";

const { jobs } = schema;

/**
 * Generates and stores an embedding for every job in `jobIds` whose `embeddingContentHash` does not
 * match its current `descriptionHash` (including never-embedded jobs, where the hash is null).
 * Batches all texts into one Voyage call; a batch failure leaves every affected job's embedding
 * untouched rather than throwing (same "degrade, never block the run" rule as `ensureGoalEmbedding`).
 */
export async function ensureJobEmbeddings(
  tx: DbClient,
  env: Pick<Env, "EMBEDDING_PROVIDER" | "VOYAGE_API_KEY" | "VOYAGE_EMBEDDING_MODEL">,
  jobIds: string[]
): Promise<void> {
  if (jobIds.length === 0) return;

  const stale = await tx
    .select({ id: jobs.id, title: jobs.title, descriptionText: jobs.descriptionText, descriptionHash: jobs.descriptionHash })
    .from(jobs)
    .where(
      and(
        inArray(jobs.id, jobIds),
        or(isNull(jobs.embeddingContentHash), ne(jobs.embeddingContentHash, jobs.descriptionHash))
      )
    );
  if (stale.length === 0) return;

  let embeddings: number[][];
  try {
    embeddings = await embedTexts(
      env,
      stale.map((job) => `${job.title} ${job.descriptionText}`)
    );
  } catch {
    // Swallowed: job content must never be logged (CLAUDE.md §9), and a Voyage outage must not fail
    // the whole matching run -- these jobs simply keep scoring with semanticScore's "unknown" default.
    return;
  }

  for (const [index, job] of stale.entries()) {
    const embedding = embeddings[index];
    if (!embedding) continue;
    await tx
      .update(jobs)
      .set({ embedding, embeddingContentHash: job.descriptionHash, embeddingModel: env.VOYAGE_EMBEDDING_MODEL })
      .where(eq(jobs.id, job.id));
  }
}
