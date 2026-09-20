import { describe, it, expect } from "vitest";
import { CareerGoalConstraintsSchema, ConfirmCareerGoalSchema } from "./careerGoalConstraintsSchema";

const valid = {
  targetRoles: ["Data Engineer"],
  seniority: null,
  locations: ["Germany"],
  workMode: "remote",
  minExperienceYears: 3,
  employmentType: null,
  salaryFloorRaw: "minimum €60k",
  salaryFloorNormalized: 60000,
  salaryCurrency: "EUR",
  salaryIsParsed: true,
  salaryTargetRaw: "ideally €80k",
  salaryTargetNormalized: 80000,
  salaryTargetCurrency: "EUR",
  salaryTargetIsParsed: true,
  visaSponsorshipRequired: null,
  skills: [],
  preferredIndustries: [],
  excludedIndustries: [],
  preferredCompanies: [],
  excludedCompanies: [],
  hardConstraints: [],
};

const issues = (input: unknown) => {
  const result = CareerGoalConstraintsSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("CareerGoalConstraintsSchema", () => {
  it("accepts a fully populated payload", () => {
    expect(CareerGoalConstraintsSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a payload with no salary information at all", () => {
    const none = {
      ...valid,
      salaryFloorRaw: null, salaryFloorNormalized: null, salaryCurrency: null, salaryIsParsed: false,
      salaryTargetRaw: null, salaryTargetNormalized: null, salaryTargetCurrency: null, salaryTargetIsParsed: false,
    };
    expect(CareerGoalConstraintsSchema.safeParse(none).success).toBe(true);
  });

  it.each(Object.keys(valid))("rejects a payload that omits %s", (field) => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest[field];
    expect(CareerGoalConstraintsSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    ["an unknown workMode", { workMode: "sometimes" }],
    ["a negative minExperienceYears", { minExperienceYears: -2 }],
    ["a fractional minExperienceYears", { minExperienceYears: 1.5 }],
    ["a negative salary floor", { salaryFloorNormalized: -1 }],
    ["a negative preferred salary", { salaryTargetNormalized: -1 }],
    ["a string salary floor amount", { salaryFloorNormalized: "60000" }],
    ["a non-boolean salaryTargetIsParsed", { salaryTargetIsParsed: "yes" }],
    ["a non-array locations", { locations: "Germany" }],
    ["a non-string list entry", { excludedCompanies: ["Acme", null] }],
  ])("rejects %s", (_label, patch) => {
    expect(CareerGoalConstraintsSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  describe("preferred salary versus minimum salary", () => {
    it("rejects a preferred salary below the minimum in the same currency", () => {
      expect(issues({ ...valid, salaryTargetNormalized: 50000 })).toEqual([
        "salaryTargetNormalized: Preferred salary cannot be lower than the minimum salary",
      ]);
    });

    it("accepts a preferred salary equal to the minimum", () => {
      expect(issues({ ...valid, salaryTargetNormalized: 60000 })).toEqual([]);
    });

    it("does not compare amounts in different currencies", () => {
      expect(issues({ ...valid, salaryTargetNormalized: 50000, salaryTargetCurrency: "GBP" })).toEqual([]);
    });

    it("does not compare when either amount or currency is missing", () => {
      expect(issues({ ...valid, salaryTargetNormalized: 50000, salaryTargetCurrency: null })).toEqual([]);
      expect(issues({ ...valid, salaryFloorNormalized: null, salaryTargetNormalized: 50000 })).toEqual([]);
      expect(issues({ ...valid, salaryTargetNormalized: null })).toEqual([]);
    });
  });
});

describe("ConfirmCareerGoalSchema", () => {
  const goalId = "00000000-0000-0000-0000-000000000001";

  it("accepts a uuid goalId with valid constraints", () => {
    expect(ConfirmCareerGoalSchema.safeParse({ goalId, constraints: valid }).success).toBe(true);
  });

  it("rejects a goalId that is not a uuid", () => {
    expect(ConfirmCareerGoalSchema.safeParse({ goalId: "abc", constraints: valid }).success).toBe(false);
  });

  it("surfaces the preferred-vs-minimum problem under the constraints path", () => {
    const result = ConfirmCareerGoalSchema.safeParse({ goalId, constraints: { ...valid, salaryTargetNormalized: 1000 } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].path).toEqual(["constraints", "salaryTargetNormalized"]);
  });
});
