import { EVALUATION_WEIGHTS, type EvaluationScores } from "../types";

/**
 * Weighted sum on a 0-100 scale, one decimal place -- same shape as
 * packages/matching/src/scoring/computeOverallScore.ts. A null factor (only semanticSimilarity can
 * be) has its weight redistributed proportionally across the known factors rather than treated as
 * zero.
 */
export function computeOverallScore(scores: EvaluationScores): number {
  const entries = Object.entries(scores) as [keyof EvaluationScores, number | null][];
  const known = entries.filter((entry): entry is [keyof EvaluationScores, number] => entry[1] !== null);
  const knownWeightTotal = known.reduce((sum, [key]) => sum + EVALUATION_WEIGHTS[key], 0);
  if (knownWeightTotal === 0) return 0;
  const weighted = known.reduce((sum, [key, value]) => sum + (EVALUATION_WEIGHTS[key] / knownWeightTotal) * value, 0);
  return Math.round(weighted * 1000) / 10;
}
