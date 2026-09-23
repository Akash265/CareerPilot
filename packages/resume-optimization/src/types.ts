export const EVALUATOR_VERSION = "v1";

/** All fractions are 0-1 except semanticSimilarity, which is null when there is nothing comparable
 * (no job embedding yet, or a transient Voyage failure) -- D6-style "never estimate." */
export interface EvaluationScores {
  requiredKeywordCoverage: number;
  preferredKeywordCoverage: number;
  semanticSimilarity: number | null;
  factualConsistency: number;
  actionVerbScore: number;
  machineReadabilityScore: number;
}

/**
 * requiredKeywordCoverage and factualConsistency carry the most weight -- required-term coverage is
 * the core ATS objective (spec §10.2's own example leads with it), and factual consistency is
 * principle #6 ("never hallucinate") made measurable -- both outrank the two heuristic-only factors
 * (action verbs, readability).
 */
export const EVALUATION_WEIGHTS: Record<keyof EvaluationScores, number> = {
  requiredKeywordCoverage: 0.3,
  preferredKeywordCoverage: 0.15,
  semanticSimilarity: 0.2,
  factualConsistency: 0.2,
  actionVerbScore: 0.075,
  machineReadabilityScore: 0.075,
};
