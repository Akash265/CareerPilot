import { describe, it, expect } from "vitest";
import { parseSalaryFloor } from "./parseSalaryFloor";

describe("parseSalaryFloor", () => {
  it("returns unparsed for null input", () => {
    expect(parseSalaryFloor(null)).toEqual({ amount: null, currency: null, isParsed: false });
  });

  it("returns unparsed for blank input", () => {
    expect(parseSalaryFloor("   ")).toEqual({ amount: null, currency: null, isParsed: false });
  });

  it("parses a euro symbol with a 'k' suffix", () => {
    expect(parseSalaryFloor("minimum €60k")).toEqual({ amount: 60000, currency: "EUR", isParsed: true });
  });

  it("parses a pound symbol with comma-separated thousands", () => {
    expect(parseSalaryFloor("£70,000")).toEqual({ amount: 70000, currency: "GBP", isParsed: true });
  });

  it("parses a dollar symbol with a trailing '+'", () => {
    expect(parseSalaryFloor("$120k+")).toEqual({ amount: 120000, currency: "USD", isParsed: true });
  });

  it("parses an ISO currency code written after the number", () => {
    expect(parseSalaryFloor("at least 90000 USD")).toEqual({ amount: 90000, currency: "USD", isParsed: true });
  });

  it("takes the lower bound of a range as the floor", () => {
    expect(parseSalaryFloor("60k-80k EUR")).toEqual({ amount: 60000, currency: "EUR", isParsed: true });
  });

  it("returns the amount unparsed when no currency can be determined", () => {
    expect(parseSalaryFloor("80k")).toEqual({ amount: 80000, currency: null, isParsed: false });
  });

  it("returns fully unparsed when there is no number at all", () => {
    expect(parseSalaryFloor("competitive")).toEqual({ amount: null, currency: null, isParsed: false });
  });

  it("returns unparsed (but keeps the parsed pieces) for ambiguous per-month phrasing", () => {
    expect(parseSalaryFloor("5000 EUR per month")).toEqual({ amount: 5000, currency: "EUR", isParsed: false });
  });

  it("returns unparsed for a bare per-month number with no currency", () => {
    expect(parseSalaryFloor("3000 per month")).toEqual({ amount: 3000, currency: null, isParsed: false });
  });

  it("parses European dot-thousands notation", () => {
    expect(parseSalaryFloor("€60.000")).toEqual({ amount: 60000, currency: "EUR", isParsed: true });
  });

  it("parses dot-thousands notation with German 'per year' phrasing (no per-month signal)", () => {
    expect(parseSalaryFloor("minimum €60.000 pro Jahr")).toEqual({
      amount: 60000,
      currency: "EUR",
      isParsed: true,
    });
  });

  it("parses dot-thousands notation without a currency symbol", () => {
    expect(parseSalaryFloor("at least 90.000 EUR")).toEqual({ amount: 90000, currency: "EUR", isParsed: true });
  });

  it("parses multi-group dot-thousands notation", () => {
    expect(parseSalaryFloor("€1.234.000")).toEqual({ amount: 1234000, currency: "EUR", isParsed: true });
  });

  it("still treats a real decimal point as a decimal, not thousands notation", () => {
    expect(parseSalaryFloor("€60.5k")).toEqual({ amount: 60500, currency: "EUR", isParsed: true });
  });

  it("returns unparsed for a genuinely ambiguous multi-dot number", () => {
    expect(parseSalaryFloor("€1.23.456")).toEqual({ amount: null, currency: "EUR", isParsed: false });
  });

  it("returns unparsed for a dot followed by an unusual number of digits", () => {
    expect(parseSalaryFloor("€60.1234")).toEqual({ amount: null, currency: "EUR", isParsed: false });
  });
});
