/** Refinement #2: the "overall contextual fit" factor -- the raw job<->goal cosine similarity, unblended. Unknown (no embedding yet) is neutral, never zero. */
export function scoreSemantic(similarity: number | null): number {
  return similarity ?? 0.5;
}
