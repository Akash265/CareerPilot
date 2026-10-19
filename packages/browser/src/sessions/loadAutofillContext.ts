import { and, desc, eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { AutomationError } from "../errors";
import type { AutofillInput } from "../values/buildAutofillValues";
import type { SessionRow } from "./createSession";

const { automationSessions, candidateProfiles, careerGoals, careerGoalConstraints, generatedDocuments } = schema;

export interface StoredDocumentRef {
  id: string;
  objectKey: string;
}

export interface AutofillContext {
  session: SessionRow;
  profile: AutofillInput["profile"];
  goal: AutofillInput["goal"];
  resumeDocument: StoredDocumentRef | null;
  coverLetterDocument: StoredDocumentRef | null;
}

/** Everything the worker needs, read in one transaction. The newest PDF export of each kind for the job is attached. */
export async function loadAutofillContext(db: DbClient, userId: string, sessionId: string): Promise<AutofillContext> {
  return withUserContext(db, userId, async (tx) => {
    const [session] = await tx.select().from(automationSessions).where(eq(automationSessions.id, sessionId));
    if (!session) throw new AutomationError("not_found");
    const [profile] = await tx
      .select({
        fullName: candidateProfiles.fullName, email: candidateProfiles.email, phoneNumber: candidateProfiles.phoneNumber,
        linkedinUrl: candidateProfiles.linkedinUrl, addressLine1: candidateProfiles.addressLine1,
      })
      .from(candidateProfiles)
      .limit(1);
    if (!profile) throw new AutomationError("profile_missing");
    const [goal] = await tx
      .select({
        visaSponsorshipRequired: careerGoalConstraints.visaSponsorshipRequired,
        salaryTargetNormalized: careerGoalConstraints.salaryTargetNormalized,
        salaryTargetCurrency: careerGoalConstraints.salaryTargetCurrency,
        salaryTargetIsParsed: careerGoalConstraints.salaryTargetIsParsed,
      })
      .from(careerGoalConstraints)
      .innerJoin(careerGoals, eq(careerGoals.id, careerGoalConstraints.careerGoalId))
      .where(eq(careerGoals.isActive, true))
      .limit(1);
    const newestPdf = async (kind: "resume" | "tailored_resume" | "cover_letter") => {
      const [doc] = await tx
        .select({ id: generatedDocuments.id, objectKey: generatedDocuments.objectKey })
        .from(generatedDocuments)
        .where(and(eq(generatedDocuments.jobId, session.jobId), eq(generatedDocuments.kind, kind), eq(generatedDocuments.format, "pdf")))
        .orderBy(desc(generatedDocuments.createdAt))
        .limit(1);
      return doc ?? null;
    };
    return {
      session,
      profile,
      goal: goal ?? null,
      // Phase 13c (D212): the job-tailored LaTeX resume when one was exported, else the full-profile resume.
      resumeDocument: (await newestPdf("tailored_resume")) ?? (await newestPdf("resume")),
      coverLetterDocument: await newestPdf("cover_letter"),
    };
  });
}
