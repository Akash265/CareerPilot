import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { runCompanyResearch, type CompanyResearchEnv } from "./runCompanyResearch";
import { deriveInternalFacts } from "./deriveInternalFacts";
import { isHttpUrl } from "./text";

const { companyResearch, companyResearchFacts, jobs, jobPostings } = schema;

export type CompanyResearchRow = typeof companyResearch.$inferSelect;
export type CompanyResearchFactRow = typeof companyResearchFacts.$inferSelect;

export interface CompanyResearchWithFacts {
  research: CompanyResearchRow;
  facts: CompanyResearchFactRow[];
}

export interface JobForResearch {
  id: string;
  companyKey: string;
  companyName: string;
  title: string;
}

/** A refresh whose research call failed while good research already existed: nothing was written. */
export class CompanyResearchRefreshFailedError extends Error {
  constructor() {
    super("Company research refresh failed; the existing research was kept");
    this.name = "CompanyResearchRefreshFailedError";
  }
}

/** Call inside withUserContext (RLS scopes the lookup to the current user). */
export async function loadCompanyResearch(tx: DbClient, companyKey: string): Promise<CompanyResearchWithFacts | null> {
  const [research] = await tx.select().from(companyResearch).where(eq(companyResearch.companyKey, companyKey)).limit(1);
  if (!research) return null;
  const facts = await tx
    .select()
    .from(companyResearchFacts)
    .where(eq(companyResearchFacts.researchId, research.id))
    .orderBy(asc(companyResearchFacts.displayOrder));
  return { research, facts };
}

/**
 * Per-company research cache (design doc §4, D74).
 * - Reuse: an existing row is returned as-is unless forceRefresh, or its status is "failed" (a failed
 *   attempt is retried automatically; "no_results" is a genuine answer and is reused).
 * - The paid, slow research call runs OUTSIDE any transaction; only the write is transactional.
 * - Write: upsert on (user_id, company_key) + delete-and-reinsert facts, in one short transaction, so
 *   concurrent first-time calls end with exactly one row and one fact set (last writer wins).
 * - A forceRefresh that comes back "failed" while non-failed research exists writes nothing and throws
 *   CompanyResearchRefreshFailedError: a transient error must never replace good research.
 */
export async function ensureCompanyResearch(
  db: DbClient,
  userId: string,
  anthropicClient: Pick<Anthropic, "messages">,
  env: CompanyResearchEnv,
  job: JobForResearch,
  opts: { forceRefresh?: boolean } = {}
): Promise<CompanyResearchWithFacts> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, userId, fn);

  const existing = await inUserContext((tx) => loadCompanyResearch(tx, job.companyKey));
  if (existing && !opts.forceRefresh && existing.research.status !== "failed") return existing;

  const [posting] = await inUserContext((tx) =>
    tx
      .select({ url: jobPostings.url })
      .from(jobPostings)
      .where(and(eq(jobPostings.jobId, job.id), isNotNull(jobPostings.url)))
      .orderBy(asc(jobPostings.firstSeenAt))
      .limit(1)
  );
  const postingUrl = posting?.url && isHttpUrl(posting.url) ? posting.url : null;

  const companyJobs = await inUserContext((tx) =>
    tx
      .select({ title: jobs.title, locationRaw: jobs.locationRaw, workMode: jobs.workMode })
      .from(jobs)
      .where(and(eq(jobs.companyKey, job.companyKey), or(eq(jobs.status, "open"), eq(jobs.id, job.id))))
      .orderBy(asc(jobs.title), asc(jobs.id))
      .limit(50)
  );

  const result = await runCompanyResearch(anthropicClient, env, {
    companyName: job.companyName,
    jobTitle: job.title,
    postingUrl,
  });

  if (opts.forceRefresh && result.status === "failed" && existing && existing.research.status !== "failed") {
    throw new CompanyResearchRefreshFailedError();
  }

  const facts = [...result.webFacts, ...deriveInternalFacts(job.companyName, companyJobs)];
  const now = new Date();

  return inUserContext(async (tx) => {
    const fields = {
      companyName: job.companyName,
      status: result.status,
      errorCode: result.errorCode,
      researchModel: result.researchModel,
      searchCount: result.searchCount,
      researchedAt: now,
    };
    const [research] = await tx
      .insert(companyResearch)
      .values({ companyKey: job.companyKey, ...fields })
      .onConflictDoUpdate({ target: [companyResearch.userId, companyResearch.companyKey], set: { ...fields, updatedAt: now } })
      .returning();
    await tx.delete(companyResearchFacts).where(eq(companyResearchFacts.researchId, research.id));
    const factRows =
      facts.length === 0
        ? []
        : await tx
            .insert(companyResearchFacts)
            .values(facts.map((f, i) => ({ researchId: research.id, ...f, displayOrder: i })))
            .returning();
    return { research, facts: [...factRows].sort((a, b) => a.displayOrder - b.displayOrder) };
  });
}
