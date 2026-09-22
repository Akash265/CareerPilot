import { FACTOR_WEIGHTS, type FactorScores } from "../types";

/**
 * Weighted sum on a 0-100 scale, one decimal place. A factor whose value is `null` (only
 * `salaryScore` can be, today) has its weight redistributed proportionally across the known
 * factors rather than being treated as a zero (design doc §6).
 */
export function computeOverallScore(factors: FactorScores): number {
  const entries = Object.entries(factors) as [keyof FactorScores, number | null][];
  const known = entries.filter((entry): entry is [keyof FactorScores, number] => entry[1] !== null);
  const knownWeightTotal = known.reduce((sum, [key]) => sum + FACTOR_WEIGHTS[key], 0);
  if (knownWeightTotal === 0) return 0;
  const weighted = known.reduce((sum, [key, value]) => sum + (FACTOR_WEIGHTS[key] / knownWeightTotal) * value, 0);
  return Math.round(weighted * 1000) / 10;
}
