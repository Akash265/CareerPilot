import { and, eq, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { mergePostings } from "../identity/merge";
import { serializeNormalized } from "../identity/serialize";
import { computeFingerprint } from "../normalize/keys";
import type { NormalizedJob, SourceKind } from "../types";
import { mergedToJobRow, recomputeJob } from "./recomputeJob";

const { jobs, jobPostings, jobDuplicateCandidates } = schema;

/** pg_trgm similarity of "company_key title_key" at or above which two same-location jobs are flagged. */
export const FUZZY_DUPLICATE_THRESHOLD = 0.8;
// Bounds the scan output and the flags per job; candidates are only ever flagged, never merged.
const MAX_FUZZY_CANDIDATES = 20;

export type PersistOutcome = "created" | "linked" | "updated" | "unchanged";

export interface PersistInput {
  sourceId: string;
  sourceKind: SourceKind;
  normalized: NormalizedJob;
  /** Hash of the raw payload; an unchanged hash skips re-normalizing downstream work. */
  contentHash: string;
  now: Date;
}

/**
 * Identity, in order:
 *  1. exact key    -- the same (source, external id) is the same posting;
 *  2. fingerprint  -- the same company/title/location/description on another posting links to that job;
 *  3. fuzzy        -- a near-match at the same location is FLAGGED (job_duplicate_candidates), never merged.
 * Call inside `withUserContext`.
 */
export async function persistPosting(
  tx: DbClient,
  input: PersistInput
): Promise<{ jobId: string; outcome: PersistOutcome }> {
  const { sourceId, sourceKind, normalized, contentHash, now } = input;

  const [existing] = await tx
    .select()
    .from(jobPostings)
    .where(and(eq(jobPostings.sourceId, sourceId), eq(jobPostings.externalId, normalized.externalId)))
    .limit(1);

  if (existing && existing.contentHash === contentHash) {
    await tx.update(jobPostings).set({ lastSeenAt: now, status: "open" }).where(eq(jobPostings.id, existing.id));
    if (existing.status === "closed") await recomputeJob(tx, existing.jobId, now);
    else await tx.update(jobs).set({ lastVerifiedAt: now }).where(eq(jobs.id, existing.jobId));
    return { jobId: existing.jobId, outcome: "unchanged" };
  }

  const fingerprint = computeFingerprint(normalized);
  let jobId = existing?.jobId;
  let outcome: PersistOutcome = existing ? "updated" : "linked";

  if (!jobId) {
    const [match] = await tx
      .select({ jobId: jobPostings.jobId })
      .from(jobPostings)
      .where(eq(jobPostings.fingerprint, fingerprint))
      .limit(1);
    jobId = match?.jobId;
  }

  if (!jobId) {
    const merged = mergePostings([
      { id: "pending", sourceKind, status: "open", firstSeenAt: now, lastSeenAt: now, normalized },
    ]);
    const [created] = await tx.insert(jobs).values(mergedToJobRow(merged, now)).returning({ id: jobs.id });
    jobId = created.id;
    outcome = "created";
  }

  await tx
    .insert(jobPostings)
    .values({
      jobId,
      sourceId,
      externalId: normalized.externalId,
      url: normalized.url,
      fingerprint,
      contentHash,
      normalized: serializeNormalized(normalized),
      status: "open",
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [jobPostings.sourceId, jobPostings.externalId],
      set: {
        url: normalized.url,
        fingerprint,
        contentHash,
        normalized: serializeNormalized(normalized),
        status: "open",
        lastSeenAt: now,
      },
    });

  await recomputeJob(tx, jobId, now);
  if (outcome === "created") await flagFuzzyDuplicates(tx, jobId);
  return { jobId, outcome };
}

async function flagFuzzyDuplicates(tx: DbClient, jobId: string): Promise<void> {
  const rows = (await tx.execute(sql`
    SELECT b.id AS other_id,
           similarity(a.company_key || ' ' || a.title_key, b.company_key || ' ' || b.title_key) AS sim
    FROM jobs a
    JOIN jobs b ON b.location_key = a.location_key AND b.id <> a.id
    WHERE a.id = ${jobId}
      AND similarity(a.company_key || ' ' || a.title_key, b.company_key || ' ' || b.title_key) >= ${FUZZY_DUPLICATE_THRESHOLD}
    ORDER BY sim DESC, b.id
    LIMIT ${MAX_FUZZY_CANDIDATES}
  `)) as unknown as { other_id: string; sim: number }[];

  for (const row of rows) {
    const [jobIdA, jobIdB] = jobId < row.other_id ? [jobId, row.other_id] : [row.other_id, jobId];
    await tx
      .insert(jobDuplicateCandidates)
      .values({ jobIdA, jobIdB, similarity: Number(row.sim) })
      .onConflictDoNothing();
  }
}
