/**
 * Full credit when either side is unknown or the candidate already meets the minimum (never guess,
 * never penalize missing data -- CLAUDE.md §6). A gap beyond `graceYears` is only reachable here in
 * a unit test: `evaluateEligibility` (Task 1) already hard-excludes it before scoring runs.
 */
export function scoreExperience(
  jobMinYears: number | null,
  candidateYears: number | null,
  graceYears: number
): number {
  if (jobMinYears === null || candidateYears === null) return 1;
  if (jobMinYears <= candidateYears) return 1;
  const gap = jobMinYears - candidateYears;
  return Math.max(0, 1 - gap / graceYears);
}
