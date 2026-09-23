import type { Sponsorship, WorkMode, WorkModePreference } from "../types";

export interface EligibilityInput {
  companyName: string;
  jobWorkMode: WorkMode;
  jobMinExperienceYears: number | null;
  jobSponsorship: Sponsorship;
  excludedCompanies: string[];
  excludedIndustries: string[];
  constraintsWorkMode: WorkModePreference;
  visaSponsorshipRequired: boolean | null;
  candidateYearsOfExperience: number | null;
  experienceGraceYears: number;
  previouslyDismissed: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  /** A fixed, evidence-carrying string when ineligible; null when eligible. Never a bare boolean (CLAUDE.md §6). */
  reason: string | null;
}

const ELIGIBLE: EligibilityResult = { eligible: true, reason: null };

/**
 * Deterministic hard filter (design doc §5). Order matters only for which single reason is
 * reported when several would apply; "previously dismissed" is checked first since it reflects
 * an explicit user decision that should never be second-guessed by any other rule.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  if (input.previouslyDismissed) {
    return { eligible: false, reason: `You dismissed this job at ${input.companyName}.` };
  }

  const nameLower = input.companyName.toLowerCase();

  // A blank/whitespace-only entry would otherwise match every company ("anything".includes("") is
  // always true in JS). The normal UI path (GoalReviewForm's nonEmpty() filter) already prevents this,
  // but the Zod schema doesn't enforce it, so it's reachable via direct API use -- filter defensively.
  const excludedCompanies = input.excludedCompanies.filter((c) => c.trim().length > 0);
  const excludedIndustries = input.excludedIndustries.filter((term) => term.trim().length > 0);

  const excludedCompany = excludedCompanies.find((c) => nameLower.includes(c.toLowerCase()));
  if (excludedCompany) {
    return { eligible: false, reason: `${input.companyName} matches "${excludedCompany}" on your excluded-companies list.` };
  }

  const excludedIndustry = excludedIndustries.find((term) => nameLower.includes(term.toLowerCase()));
  if (excludedIndustry) {
    return { eligible: false, reason: `${input.companyName} matches your excluded industry "${excludedIndustry}".` };
  }

  if (input.constraintsWorkMode === "remote" && (input.jobWorkMode === "onsite" || input.jobWorkMode === "hybrid")) {
    return { eligible: false, reason: `This role is ${input.jobWorkMode}, but your career goal requires remote.` };
  }

  if (
    input.jobMinExperienceYears !== null &&
    input.candidateYearsOfExperience !== null &&
    input.jobMinExperienceYears > input.candidateYearsOfExperience + input.experienceGraceYears
  ) {
    return {
      eligible: false,
      reason: `Requires ${input.jobMinExperienceYears}+ years; your profile states ${input.candidateYearsOfExperience}.`,
    };
  }

  if (input.visaSponsorshipRequired === true && input.jobSponsorship === "not_offered") {
    return { eligible: false, reason: "Your career goal requires visa sponsorship, and this posting states it does not offer it." };
  }

  return ELIGIBLE;
}
