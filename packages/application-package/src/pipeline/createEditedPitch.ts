import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { hasUnsafeText } from "@ai-career/ingestion/text";
import { MAX_BULLET_CHARS, type StoredPitchBullet } from "../types";
import { insertPitchVersion, type ApplicationPitchRow } from "./insertPitchVersion";

const { applicationPitches } = schema;

const EditedBulletText = z
  .string()
  .trim()
  .min(1)
  .max(MAX_BULLET_CHARS)
  .refine((s) => !hasUnsafeText(s), { message: "contains unsupported characters" });

/** Request body for POST /api/application-pitches/[jobId]/edit. Bullets are ordered company, role, candidate. */
export const EditPitchBodySchema = z
  .object({
    baseVersionId: z.string().uuid(),
    bullets: z.tuple([EditedBulletText, EditedBulletText, EditedBulletText]),
  })
  .strict();

export type EditPitchBody = z.infer<typeof EditPitchBodySchema>;

export class PitchEditError extends Error {
  readonly errorClass = "base_not_found" as const;
  constructor() {
    super("base_not_found");
    this.name = "PitchEditError";
  }
}

/**
 * Saves a user's wording as a new user_edited version (spec decision 4, D77). The base's evidence and
 * research snapshot are carried over so the user can still see what the wording was originally based
 * on, but supported/unsupportedReason become null: the guard judged the model's text, not the user's,
 * and the user is the authority on their own claims -- hence requiresReview = false.
 */
export async function createEditedPitch(
  db: DbClient,
  userId: string,
  jobId: string,
  body: EditPitchBody
): Promise<ApplicationPitchRow> {
  return withUserContext(db, userId, async (tx) => {
    const [base] = await tx
      .select()
      .from(applicationPitches)
      .where(and(eq(applicationPitches.id, body.baseVersionId), eq(applicationPitches.jobId, jobId)))
      .limit(1);
    if (!base) throw new PitchEditError();

    const baseBullets = base.bullets as StoredPitchBullet[];
    const bullets: StoredPitchBullet[] = baseBullets.map((b, i) => ({
      kind: b.kind,
      text: body.bullets[i],
      supported: null,
      unsupportedReason: null,
      evidence: b.evidence,
    }));

    return insertPitchVersion(tx, userId, jobId, {
      origin: "user_edited",
      parentPitchId: base.id,
      companyResearchId: base.companyResearchId,
      researchStatusSnapshot: base.researchStatusSnapshot,
      researchedAtSnapshot: base.researchedAtSnapshot,
      bullets,
      requiresReview: false,
      sourceProfileContentHash: null,
      generationModel: null,
    });
  });
}
