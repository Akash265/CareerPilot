export interface SkillMatchDetail {
  skill: string;
  found: boolean;
}

export interface SkillsScoreResult {
  score: number;
  lexicalHitRate: number;
  matches: SkillMatchDetail[];
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Deterministic keyword hit-rate blended 70/30 with job<->goal semantic similarity (Refinement #2:
 * the same signal `scoreSemantic` uses on its own for "overall contextual fit"). A skill is "found"
 * on a plain case-insensitive substring match against the title + description -- deliberately not a
 * regex, so skill names with regex metacharacters ("C++", "C#") never need escaping.
 */
export function scoreSkills(
  skills: string[],
  jobTitle: string,
  descriptionText: string,
  semanticSimilarity: number | null
): SkillsScoreResult {
  // A blank/whitespace-only entry would otherwise always "match" (haystack.includes("") is always
  // true in JS), inflating the lexical hit-rate. The normal UI path already prevents this reaching
  // here, but the Zod schema doesn't enforce it -- filter defensively.
  const nonBlankSkills = skills.filter((s) => s.trim().length > 0);
  if (nonBlankSkills.length === 0) {
    return { score: 1, lexicalHitRate: 1, matches: [] };
  }
  const haystack = `${jobTitle} ${descriptionText}`.toLowerCase();
  const matches = nonBlankSkills.map((skill) => ({ skill, found: haystack.includes(skill.toLowerCase()) }));
  const lexicalHitRate = matches.filter((m) => m.found).length / matches.length;
  const score =
    semanticSimilarity === null ? lexicalHitRate : clamp01(0.7 * lexicalHitRate + 0.3 * semanticSimilarity);
  return { score: clamp01(score), lexicalHitRate, matches };
}
