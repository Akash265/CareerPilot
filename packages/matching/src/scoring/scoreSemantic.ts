/**
 * Refinement #2: the "overall contextual fit" factor -- the raw job<->goal cosine similarity,
 * unblended. Unknown (no embedding yet) is neutral, never zero. Cosine similarity is mathematically
 * in [-1, 1] like every other factor's [0, 1] range, clamped here (a negative similarity would
 * otherwise pull overallScore slightly below 0, unlike every other factor which is already clamped,
 * e.g. scoreSkills).
 */
export function scoreSemantic(similarity: number | null): number {
  return Math.max(0, Math.min(1, similarity ?? 0.5));
}
