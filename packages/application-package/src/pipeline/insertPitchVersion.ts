import { eq, max, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";

const { applicationPitches } = schema;

export type ApplicationPitchRow = typeof applicationPitches.$inferSelect;
export type NewPitchVersion = Omit<typeof applicationPitches.$inferInsert, "id" | "userId" | "jobId" | "version" | "createdAt">;

/**
 * Allocates the next version for (user, job) and inserts it. MUST run inside withUserContext (a
 * transaction): pg_advisory_xact_lock serializes concurrent generate/edit calls for the same job until
 * commit, so two parallel requests get versions N+1 and N+2 instead of a unique-index violation. Same
 * pattern as runResumeOptimization's version allocation, with its own lock namespace.
 */
export async function insertPitchVersion(
  tx: DbClient,
  userId: string,
  jobId: string,
  values: NewPitchVersion
): Promise<ApplicationPitchRow> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('application_pitches'), hashtext(${userId} || ':' || ${jobId}))`);
  const [{ maxVersion }] = await tx
    .select({ maxVersion: max(applicationPitches.version) })
    .from(applicationPitches)
    .where(eq(applicationPitches.jobId, jobId));
  const [row] = await tx
    .insert(applicationPitches)
    .values({ ...values, jobId, version: (maxVersion ?? 0) + 1 })
    .returning();
  return row;
}
