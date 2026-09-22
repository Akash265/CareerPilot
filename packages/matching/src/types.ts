export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";
export type WorkModePreference = "remote" | "hybrid" | "onsite" | "any";
export type Sponsorship = "offered" | "not_offered" | "unknown";

/**
 * Every factor is a 0-1 fraction except `salaryScore`, which is `null` when
 * there is nothing safe to compare (missing/unparsed salary data, or a
 * currency mismatch) -- D6: never estimate. `computeOverallScore` (Task 2)
 * redistributes a null factor's weight across the rest rather than treating
 * it as zero.
 */
export interface FactorScores {
  skillsScore: number;
  experienceScore: number;
  locationScore: number;
  sponsorshipScore: number;
  roleScore: number;
  salaryScore: number | null;
  industryScore: number;
  freshnessScore: number;
  semanticScore: number;
}

/** architecture.md §4's initial weights (skills 30/experience 15/location 15/sponsorship 10/role 10/salary 5/industry 5/freshness 5/semantic 5). */
export const FACTOR_WEIGHTS: Record<keyof FactorScores, number> = {
  skillsScore: 0.3,
  experienceScore: 0.15,
  locationScore: 0.15,
  sponsorshipScore: 0.1,
  roleScore: 0.1,
  salaryScore: 0.05,
  industryScore: 0.05,
  freshnessScore: 0.05,
  semanticScore: 0.05,
};
