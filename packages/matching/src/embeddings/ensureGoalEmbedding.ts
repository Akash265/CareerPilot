import { eq } from "drizzle-orm";
import { embedTexts } from "@ai-career/ai";
import { schema, type DbClient } from "@ai-career/db";
import type { Env } from "@ai-career/config";

const { careerGoalConstraints, careerGoals } = schema;

/**
 * Generates and stores `career_goal_constraints.embedding` if it is not already set. Returns the
 * embedding (existing or freshly generated), or null if generation fails or there is no text to
 * embed. Never throws -- a Voyage outage must not block a matching run (mirrors saveProfile.ts's
 * "degrade to null" rule for profile_facts).
 */
export async function ensureGoalEmbedding(
  tx: DbClient,
  env: Pick<Env, "EMBEDDING_PROVIDER" | "VOYAGE_API_KEY" | "VOYAGE_EMBEDDING_MODEL">,
  careerGoalConstraintsId: string
): Promise<number[] | null> {
  const [row] = await tx
    .select({
      embedding: careerGoalConstraints.embedding,
      targetRoles: careerGoalConstraints.targetRoles,
      skills: careerGoalConstraints.skills,
      careerGoalId: careerGoalConstraints.careerGoalId,
    })
    .from(careerGoalConstraints)
    .where(eq(careerGoalConstraints.id, careerGoalConstraintsId))
    .limit(1);
  if (!row) return null;
  if (row.embedding) return row.embedding;

  const [goal] = await tx.select({ rawText: careerGoals.rawText }).from(careerGoals).where(eq(careerGoals.id, row.careerGoalId)).limit(1);
  const text = [...row.targetRoles, ...row.skills, goal?.rawText ?? ""].filter(Boolean).join(" ");
  if (!text.trim()) return null;

  let embedding: number[] | null;
  try {
    [embedding] = await embedTexts(env, [text]);
  } catch {
    // Swallowed on purpose: the error may echo the goal text (PII), which CLAUDE.md §9 forbids logging.
    return null;
  }
  if (!embedding) return null;

  await tx
    .update(careerGoalConstraints)
    .set({ embedding, embeddingModel: env.VOYAGE_EMBEDDING_MODEL })
    .where(eq(careerGoalConstraints.id, careerGoalConstraintsId));
  return embedding;
}
