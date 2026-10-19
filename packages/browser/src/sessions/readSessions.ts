import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { getAutofillSupport, type AutofillSupport } from "./support";
import type { SessionRow } from "./createSession";

const { jobs, automationSessions, generatedDocuments, applications } = schema;

export interface JobAutofillOverview {
  support: AutofillSupport;
  resumeAvailable: boolean;
  applicationId: string | null;
  sessions: SessionRow[];
}

export async function getSession(db: DbClient, userId: string, sessionId: string): Promise<SessionRow | null> {
  return withUserContext(db, userId, async (tx) => {
    const [row] = await tx.select().from(automationSessions).where(eq(automationSessions.id, sessionId));
    return row ?? null;
  });
}

/** Everything AutofillPanel needs in one request; null when the job does not exist (or is another user's). */
export async function getJobAutofillOverview(db: DbClient, userId: string, jobId: string): Promise<JobAutofillOverview | null> {
  return withUserContext(db, userId, async (tx) => {
    const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId));
    if (!job) return null;
    const support = await getAutofillSupport(tx, jobId);
    const [resume] = await tx
      .select({ id: generatedDocuments.id })
      .from(generatedDocuments)
      .where(and(eq(generatedDocuments.jobId, jobId), inArray(generatedDocuments.kind, ["resume", "tailored_resume"]), eq(generatedDocuments.format, "pdf")))
      .limit(1);
    const [application] = await tx.select({ id: applications.id }).from(applications).where(eq(applications.jobId, jobId)).limit(1);
    const sessions = await tx
      .select()
      .from(automationSessions)
      .where(eq(automationSessions.jobId, jobId))
      .orderBy(desc(automationSessions.createdAt))
      .limit(10);
    return { support, resumeAvailable: Boolean(resume), applicationId: application?.id ?? null, sessions };
  });
}
