import { describe, it, expect } from "vitest";
import { evaluateEligibility, type EligibilityInput } from "./evaluateEligibility";

const base: EligibilityInput = {
  companyName: "Acme Corp",
  jobWorkMode: "remote",
  jobMinExperienceYears: null,
  jobSponsorship: "unknown",
  excludedCompanies: [],
  excludedIndustries: [],
  constraintsWorkMode: "any",
  visaSponsorshipRequired: null,
  candidateYearsOfExperience: 5,
  experienceGraceYears: 1,
  previouslyDismissed: false,
};

describe("evaluateEligibility", () => {
  it("is eligible when nothing disqualifies it", () => {
    expect(evaluateEligibility(base)).toEqual({ eligible: true, reason: null });
  });

  it("excludes a company on the excluded-companies list, case-insensitively", () => {
    const result = evaluateEligibility({ ...base, excludedCompanies: ["acme"] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/Acme Corp.*excluded-companies/);
  });

  it("excludes a company whose name contains an excluded-industry term", () => {
    const result = evaluateEligibility({ ...base, companyName: "Acme Defense Systems", excludedIndustries: ["defense"] });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/excluded industry.*defense/i);
  });

  it("excludes an onsite job when the goal requires remote", () => {
    const result = evaluateEligibility({ ...base, jobWorkMode: "onsite", constraintsWorkMode: "remote" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/onsite.*remote/i);
  });

  it("excludes a hybrid job when the goal requires remote", () => {
    const result = evaluateEligibility({ ...base, jobWorkMode: "hybrid", constraintsWorkMode: "remote" });
    expect(result.eligible).toBe(false);
  });

  it("does not exclude a remote job when the goal requires remote", () => {
    expect(evaluateEligibility({ ...base, jobWorkMode: "remote", constraintsWorkMode: "remote" }).eligible).toBe(true);
  });

  it("does not exclude an onsite job when work mode preference is 'any'", () => {
    expect(evaluateEligibility({ ...base, jobWorkMode: "onsite", constraintsWorkMode: "any" }).eligible).toBe(true);
  });

  it("excludes a job requiring more than experience + grace years", () => {
    const result = evaluateEligibility({
      ...base, jobMinExperienceYears: 7, candidateYearsOfExperience: 5, experienceGraceYears: 1,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/7\+? years.*5/);
  });

  it("does not exclude a job within the experience grace window", () => {
    const result = evaluateEligibility({
      ...base, jobMinExperienceYears: 6, candidateYearsOfExperience: 5, experienceGraceYears: 1,
    });
    expect(result.eligible).toBe(true);
  });

  it("never hard-blocks on experience when either side is unknown", () => {
    expect(evaluateEligibility({ ...base, jobMinExperienceYears: 20, candidateYearsOfExperience: null }).eligible).toBe(true);
    expect(evaluateEligibility({ ...base, jobMinExperienceYears: null, candidateYearsOfExperience: 0 }).eligible).toBe(true);
  });

  it("excludes a job that does not offer sponsorship when it is required", () => {
    const result = evaluateEligibility({ ...base, visaSponsorshipRequired: true, jobSponsorship: "not_offered" });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/sponsorship/i);
  });

  it("does not exclude an unknown-sponsorship job even when sponsorship is required", () => {
    expect(evaluateEligibility({ ...base, visaSponsorshipRequired: true, jobSponsorship: "unknown" }).eligible).toBe(true);
  });

  it("excludes a previously dismissed job regardless of every other field", () => {
    const result = evaluateEligibility({ ...base, previouslyDismissed: true });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/dismissed/i);
  });

  it("ignores a blank entry in excludedCompanies instead of excluding every company", () => {
    // "anything".includes("") is always true in JS -- a blank entry must not become a wildcard.
    expect(evaluateEligibility({ ...base, excludedCompanies: ["", "   "] }).eligible).toBe(true);
  });

  it("ignores a blank entry in excludedIndustries instead of excluding every company", () => {
    expect(evaluateEligibility({ ...base, excludedIndustries: ["", "\t"] }).eligible).toBe(true);
  });
});
