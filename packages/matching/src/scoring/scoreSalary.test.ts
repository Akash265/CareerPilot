import { describe, it, expect } from "vitest";
import { scoreSalary, type SalaryComparisonInput } from "./scoreSalary";

const base: SalaryComparisonInput = {
  jobMin: 70000, jobMax: 90000, jobCurrency: "USD", jobIsParsed: true,
  floorNormalized: null, floorCurrency: null, floorIsParsed: false,
  targetNormalized: null, targetCurrency: null, targetIsParsed: false,
};

describe("scoreSalary", () => {
  it("returns null when the job's salary is not parsed", () => {
    expect(scoreSalary({ ...base, jobIsParsed: false })).toBeNull();
  });
  it("returns null when neither a floor nor a target is parsed", () => {
    expect(scoreSalary(base)).toBeNull();
  });
  it("returns null on a currency mismatch", () => {
    const result = scoreSalary({ ...base, floorNormalized: 60000, floorCurrency: "EUR", floorIsParsed: true });
    expect(result).toBeNull();
  });
  it("returns 0 when below a parsed floor", () => {
    const result = scoreSalary({ ...base, jobMax: 50000, jobMin: 40000, floorNormalized: 60000, floorCurrency: "USD", floorIsParsed: true });
    expect(result).toBe(0);
  });
  it("returns 1 when at or above the target", () => {
    const result = scoreSalary({ ...base, targetNormalized: 90000, targetCurrency: "USD", targetIsParsed: true });
    expect(result).toBe(1);
  });
  it("returns 1 when at or above the floor and no target is stated", () => {
    const result = scoreSalary({ ...base, floorNormalized: 70000, floorCurrency: "USD", floorIsParsed: true });
    expect(result).toBe(1);
  });
  it("interpolates between the floor and target", () => {
    // jobFigure 90000, floor 70000, target 110000 -> 0.6 + 0.4*(20000/40000) = 0.8
    const result = scoreSalary({
      ...base, floorNormalized: 70000, floorCurrency: "USD", floorIsParsed: true,
      targetNormalized: 110000, targetCurrency: "USD", targetIsParsed: true,
    });
    expect(result).toBeCloseTo(0.8);
  });
});
