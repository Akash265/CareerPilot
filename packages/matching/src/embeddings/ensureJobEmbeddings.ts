import { eq, inArray, and, ne, isNull, or } from "drizzle-orm";
import { embedTexts } from "@ai-career/ai";
import { schema, type DbClient } from "@ai-career/db";
import type { Env } from "@ai-career/config";

const { jobs } = schema;

/**
 * Jobs per Voyage embeddings request. A realistically populated `jobs` table can have hundreds of
 * stale rows with multi-thousand-token descriptions each -- one unbounded request risks exceeding
 * Voyage's per-request token/array-size limits. Keeping batches fixed-size means staying under those
 * limits doesn't depend on assumptions about individual description lengths.
 */
export const EMBEDDING_BATCH_SIZE = 32;

export interface EnsureJobEmbeddingsResult {
  embedded: number;
  failed: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Generates and stores an embedding for every job in `jobIds` whose `embeddingContentHash` does not
 * match its current `descriptionHash` (including never-embedded jobs, where the hash is null).
 * Calls Voyage once per `EMBEDDING_BATCH_SIZE`-sized chunk, in sequence (not parallel, to stay polite
 * to the rate limit). A chunk's failure leaves only that chunk's jobs' embeddings untouched -- they
 * simply keep scoring with semanticScore's "unknown" default and are retried on the next run -- rather
 * than one oversized, all-or-nothing request taking out every job (same "degrade, never block the
 * run" rule as `ensureGoalEmbedding`).
 */
export async function ensureJobEmbeddings(
  tx: DbClient,
  env: Pick<Env, "EMBEDDING_PROVIDER" | "VOYAGE_API_KEY" | "VOYAGE_EMBEDDING_MODEL">,
  jobIds: string[]
): Promise<EnsureJobEmbeddingsResult> {
  if (jobIds.length === 0) return { embedded: 0, failed: 0 };

  const stale = await tx
    .select({ id: jobs.id, title: jobs.title, descriptionText: jobs.descriptionText, descriptionHash: jobs.descriptionHash })
    .from(jobs)
    .where(
      and(
        inArray(jobs.id, jobIds),
        or(isNull(jobs.embeddingContentHash), ne(jobs.embeddingContentHash, jobs.descriptionHash))
      )
    );
  if (stale.length === 0) return { embedded: 0, failed: 0 };

  let embedded = 0;
  let failed = 0;

  for (const batch of chunk(stale, EMBEDDING_BATCH_SIZE)) {
    let embeddings: number[][];
    try {
      embeddings = await embedTexts(
        env,
        batch.map((job) => `${job.title} ${job.descriptionText}`)
      );
    } catch {
      // Swallowed: job content must never be logged (CLAUDE.md §9), and a Voyage outage on one chunk
      // must not fail the whole matching run or take out other chunks -- these jobs simply keep
      // scoring with semanticScore's "unknown" default and are retried next run.
      failed += batch.length;
      continue;
    }

    for (const [index, job] of batch.entries()) {
      const embedding = embeddings[index];
      if (!embedding) continue;
      await tx
        .update(jobs)
        .set({ embedding, embeddingContentHash: job.descriptionHash, embeddingModel: env.VOYAGE_EMBEDDING_MODEL })
        .where(eq(jobs.id, job.id));
      embedded++;
    }
  }

  return { embedded, failed };
}
