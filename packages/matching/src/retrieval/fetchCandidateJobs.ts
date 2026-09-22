import { eq, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import type { Sponsorship, WorkMode } from "../types";
import { toVectorLiteral } from "../embeddings/vectorLiteral";

const { jobs } = schema;

export interface CandidateJobRow {
  id: string;
  companyName: string;
  title: string;
  locationRaw: string | null;
  countryCode: string | null;
  workMode: WorkMode;
  descriptionText: string;
  descriptionHash: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryIsParsed: boolean;
  minExperienceYears: number | null;
  sponsorship: Sponsorship;
  postedAt: Date | null;
  firstSeenAt: Date;
  /** 1 - cosine distance against the goal's embedding; null when either embedding is missing. */
  semanticSimilarity: number | null;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * Every open job, scored deterministically downstream (Task 8) -- this is not a top-K filter, only
 * the semantic-similarity computation (best done in Postgres via pgvector's `<=>`, not by pulling
 * 1024-dim vectors into Node) plus the plain fields every scoring factor needs.
 */
export async function fetchCandidateJobs(tx: DbClient, goalEmbedding: number[] | null): Promise<CandidateJobRow[]> {
  const similarityExpr = goalEmbedding
    ? sql<string | null>`CASE WHEN ${jobs.embedding} IS NULL THEN NULL ELSE 1 - (${jobs.embedding} <=> ${toVectorLiteral(goalEmbedding)}::vector) END`
    : sql<string | null>`NULL`;

  const rows = await tx
    .select({
      id: jobs.id,
      companyName: jobs.companyName,
      title: jobs.title,
      locationRaw: jobs.locationRaw,
      countryCode: jobs.countryCode,
      workMode: jobs.workMode,
      descriptionText: jobs.descriptionText,
      descriptionHash: jobs.descriptionHash,
      salaryMin: jobs.salaryMin,
      salaryMax: jobs.salaryMax,
      salaryCurrency: jobs.salaryCurrency,
      salaryIsParsed: jobs.salaryIsParsed,
      minExperienceYears: jobs.minExperienceYears,
      sponsorship: jobs.sponsorship,
      postedAt: jobs.postedAt,
      firstSeenAt: jobs.firstSeenAt,
      semanticSimilarity: similarityExpr,
    })
    .from(jobs)
    .where(eq(jobs.status, "open"));

  return rows.map((row) => ({
    ...row,
    salaryMin: num(row.salaryMin),
    salaryMax: num(row.salaryMax),
    semanticSimilarity: row.semanticSimilarity === null ? null : Number(row.semanticSimilarity),
  }));
}
