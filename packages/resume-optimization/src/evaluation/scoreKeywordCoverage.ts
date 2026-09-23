export interface RequirementTerm {
  termText: string;
  requirementLevel: "required" | "preferred";
}

export interface KeywordCoverageResult {
  requiredKeywordCoverage: number;
  preferredKeywordCoverage: number;
}

/**
 * Case-insensitive substring match against the optimized resume text -- same "plain substring, no
 * regex" rule as packages/matching/src/scoring/scoreSkills.ts, so a term like "C++" never needs
 * escaping. A level with zero (non-blank) terms scores 1, same vacuously-satisfied convention as
 * scoreSkills' empty-skills case.
 */
export function scoreKeywordCoverage(terms: RequirementTerm[], optimizedText: string): KeywordCoverageResult {
  const haystack = optimizedText.toLowerCase();
  const coverage = (level: "required" | "preferred"): number => {
    const levelTerms = terms.filter((t) => t.requirementLevel === level && t.termText.trim().length > 0);
    if (levelTerms.length === 0) return 1;
    const found = levelTerms.filter((t) => haystack.includes(t.termText.toLowerCase())).length;
    return found / levelTerms.length;
  };
  return { requiredKeywordCoverage: coverage("required"), preferredKeywordCoverage: coverage("preferred") };
}
