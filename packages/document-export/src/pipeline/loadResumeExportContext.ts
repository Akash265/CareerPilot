import { and, eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { buildResumeSnapshot } from "@ai-career/resume-optimization";
import { DocumentExportError } from "../errors";
import type { ResumeProfile } from "../model/resumeProfile";
import { loadResumeProfile } from "./loadResumeProfile";

const { jobs, resumeOptimizations } = schema;

export interface ResumeExportContext {
  job: { id: string; companyName: string };
  optimization: typeof resumeOptimizations.$inferSelect;
  profile: ResumeProfile;
}

/** The D84 checks shared by both resume exports: job 404, source_mismatch, profile_changed, no_profile. */
export async function loadResumeExportContext(
  db: DbClient,
  input: { userId: string; jobId: string; optimizationId: string }
): Promise<ResumeExportContext> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);

  const [job] = await inUserContext((tx) =>
    tx.select({ id: jobs.id, companyName: jobs.companyName }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1)
  );
  if (!job) throw new DocumentExportError("job_not_found");

  const [optimization] = await inUserContext((tx) =>
    tx
      .select()
      .from(resumeOptimizations)
      .where(and(eq(resumeOptimizations.id, input.optimizationId), eq(resumeOptimizations.jobId, input.jobId)))
      .limit(1)
  );
  if (!optimization) throw new DocumentExportError("source_mismatch");

  // repeatable read: buildResumeSnapshot and loadResumeProfile issue 7 and 8 SELECTs respectively.
  // Under the default read committed, a profile edit that commits between them could hash the old
  // rows but render the new ones (an old optimizedText overwriting a just-edited bullet, or a
  // deleted bullet surfacing as an unhandled 500). repeatable read gives both a single consistent
  // snapshot (D84 update; see packages/db/src/rls.ts's WithUserContextOptions).
  const { snapshot, profile } = await withUserContext(
    db,
    input.userId,
    async (tx) => ({
      snapshot: await buildResumeSnapshot(tx),
      profile: await loadResumeProfile(tx),
    }),
    { isolationLevel: "repeatable read" }
  );
  if (snapshot.contentHash !== optimization.sourceProfileContentHash) throw new DocumentExportError("profile_changed");
  if (!profile) throw new DocumentExportError("no_profile");
  return { job, optimization, profile };
}
