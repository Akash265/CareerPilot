/** Refinement #3: company-name-only heuristic (no structured `industry` field exists yet). Never penalizes a non-match, only fails to boost it. */
export function scoreIndustry(companyName: string, preferredIndustries: string[]): number {
  if (preferredIndustries.length === 0) return 1;
  const name = companyName.toLowerCase();
  return preferredIndustries.some((term) => name.includes(term.toLowerCase())) ? 1 : 0.5;
}
