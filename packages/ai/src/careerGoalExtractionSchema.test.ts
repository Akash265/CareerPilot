import { describe, it, expect } from "vitest";
import { CareerGoalExtractionSchema } from "./careerGoalExtractionSchema";

const valid = {
  targetRoles: ["Data Engineer"],
  seniority: "senior",
  locations: ["Germany", "UK"],
  workMode: "remote",
  minExperienceYears: 3,
  employmentType: "full-time",
  salaryFloorRaw: "minimum €60k",
  salaryTargetRaw: "ideally €80k",
  visaSponsorshipRequired: true,
  skills: ["SQL"],
  preferredIndustries: ["fintech"],
  excludedIndustries: ["consulting"],
  preferredCompanies: ["Spotify"],
  excludedCompanies: ["Accenture"],
  hardConstraints: ["no on-call"],
};

describe("CareerGoalExtractionSchema", () => {
  it("accepts a fully populated draft", () => {
    expect(CareerGoalExtractionSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts null for every nullable scalar and empty lists", () => {
    const empty = {
      ...valid,
      seniority: null,
      minExperienceYears: null,
      employmentType: null,
      salaryFloorRaw: null,
      salaryTargetRaw: null,
      visaSponsorshipRequired: null,
      targetRoles: [],
      locations: [],
      skills: [],
      preferredIndustries: [],
      excludedIndustries: [],
      preferredCompanies: [],
      excludedCompanies: [],
      hardConstraints: [],
    };
    expect(CareerGoalExtractionSchema.safeParse(empty).success).toBe(true);
  });

  it.each(Object.keys(valid))("rejects a draft that omits %s", (field) => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest[field];
    expect(CareerGoalExtractionSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    ["an unknown workMode", { workMode: "sometimes" }],
    ["a negative minExperienceYears", { minExperienceYears: -1 }],
    ["a fractional minExperienceYears", { minExperienceYears: 2.5 }],
    ["a numeric salaryFloorRaw (salary must stay a phrase)", { salaryFloorRaw: 60000 }],
    ["a numeric salaryTargetRaw (salary must stay a phrase)", { salaryTargetRaw: 80000 }],
    ["a string visaSponsorshipRequired", { visaSponsorshipRequired: "yes" }],
    ["a non-array targetRoles", { targetRoles: "Data Engineer" }],
    ["a non-string entry in a list", { skills: ["SQL", 42] }],
  ])("rejects %s", (_label, patch) => {
    expect(CareerGoalExtractionSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
