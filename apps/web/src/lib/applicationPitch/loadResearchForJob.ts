// apps/web/src/lib/applicationPitch/loadResearchForJob.ts
import { eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { loadCompanyResearch } from "@ai-career/application-package";
import { toResearchView, type ResearchView } from "./serializePitch";

const { jobs } = schema;

/** Call inside withUserContext. Research is per company, so it is found through the job's companyKey. */
export async function loadResearchForJob(tx: DbClient, jobId: string): Promise<ResearchView | null> {
  const [job] = await tx.select({ companyKey: jobs.companyKey }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return null;
  const research = await loadCompanyResearch(tx, job.companyKey);
  return research === null ? null : toResearchView(research);
}
