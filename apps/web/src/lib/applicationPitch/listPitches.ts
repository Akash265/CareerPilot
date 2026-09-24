// apps/web/src/lib/applicationPitch/listPitches.ts
import { desc, eq } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { toPitchView, type PitchView } from "./serializePitch";

const { applicationPitches } = schema;

/** Call inside withUserContext. Newest version first. */
export async function listPitches(tx: DbClient, jobId: string): Promise<PitchView[]> {
  const rows = await tx
    .select()
    .from(applicationPitches)
    .where(eq(applicationPitches.jobId, jobId))
    .orderBy(desc(applicationPitches.version));
  return rows.map(toPitchView);
}
