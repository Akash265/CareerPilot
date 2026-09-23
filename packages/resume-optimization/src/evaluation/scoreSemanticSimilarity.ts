export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Pure in-memory cosine, not a pgvector `<=>` query (D63): both vectors are already in hand by the
 * time Task 11 calls this (job.embedding from the row it already fetched, the resume embedding from
 * one embedTexts call), so a second DB round trip would add nothing. Cosine is in [-1, 1]; clamped
 * to [0, 1] for the 0-100 scorecard percentage, same convention as matching's scoreSemantic.
 */
export function scoreSemanticSimilarity(jobEmbedding: number[] | null, resumeEmbedding: number[] | null): number | null {
  if (jobEmbedding === null || resumeEmbedding === null) return null;
  return Math.max(0, Math.min(1, cosineSimilarity(jobEmbedding, resumeEmbedding)));
}
