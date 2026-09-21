import { describe, it, expect } from "vitest";
import { extractSalary } from "./salary";

const parsed = (text: string, ctx?: { countryCode?: string | null }) => {
  const r = extractSalary(text, ctx);
  return { min: r.min, max: r.max, currency: r.currency, period: r.period, isParsed: r.isParsed };
};

describe("extractSalary — formats seen in real postings", () => {
  it("parses a plain annual range", () => {
    expect(parsed("The base salary range for this role is $150,000 - $200,000 per year.")).toEqual({
      min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true,
    });
  });

  it("honours a trailing ISO code over the symbol, and annualizes an explicit monthly period (Airbnb Mexico)", () => {
    const text = "The base pay range shown below is monthly.\n\nMexico Monthly Pay Range\n$43,500 — $48,333 MXN\n\nReasonable Accommodations";
    expect(parsed(text)).toEqual({ min: 43500 * 12, max: 48333 * 12, currency: "MXN", period: "month", isParsed: true });
  });

  it("reads R$ as BRL with dot thousands (Airbnb Brazil)", () => {
    expect(parsed("Brazil Monthly Pay Range\nR$14.000 — R$17.500 BRL")).toEqual({
      min: 14000 * 12, max: 17500 * 12, currency: "BRL", period: "month", isParsed: true,
    });
  });

  it("reads European dot-thousands (€71.000 — €84.000)", () => {
    expect(parsed("The annual salary range is €71.000 — €84.000 EUR")).toEqual({
      min: 71000, max: 84000, currency: "EUR", period: "year", isParsed: true,
    });
  });

  it("handles a repeated trailing code (296,000 PLN — 350,000 PLN)", () => {
    expect(parsed("The salary range is 296,000 PLN — 350,000 PLN per year")).toEqual({
      min: 296000, max: 350000, currency: "PLN", period: "year", isParsed: true,
    });
  });

  it("handles a range with no separator (Spotify: '$184,050 $262,928 plus equity')", () => {
    expect(parsed("The United States base range for this position is $184,050 $262,928 plus equity.")).toEqual({
      min: 184050, max: 262928, currency: "USD", period: "year", isParsed: true,
    });
  });

  it("handles a per-unit suffix between the amounts (Palantir: '$28/hour to $47/hour')", () => {
    expect(parsed("The salary range for this position is estimated to be $28/hour to $47/hour.")).toEqual({
      min: 28 * 2080, max: 47 * 2080, currency: "USD", period: "hour", isParsed: true,
    });
  });

  it("expands a k suffix and infers a year for amounts >= 10,000 with no stated period", () => {
    expect(parsed("Compensation: $120k - $150k")).toEqual({
      min: 120000, max: 150000, currency: "USD", period: "year", isParsed: true,
    });
  });

  it("keeps the raw span and treats one explicit CAD range as CAD", () => {
    const r = extractSalary("Pay Range\n$83,000 — $98,000 CAD");
    expect(r.currency).toBe("CAD");
    expect(r.raw).toBe("$83,000 — $98,000 CAD");
  });

  it("counts a range repeated with a trailing code once, not as a conflict", () => {
    expect(parsed("Pay Range\n$123,000 — $145,000 USD")).toMatchObject({ min: 123000, max: 145000, isParsed: true });
  });
});

describe("extractSalary — things that are NOT pay", () => {
  it("ignores market-size and volume figures (Stripe)", () => {
    const text =
      "Our commercial segment includes businesses processing $20M–$50M in annual payment volume. " +
      "We are attacking a $100B market opportunity. Stripe moved $1.4T in annual volume.";
    const r = extractSalary(text);
    expect(r.raw).toBeNull();
    expect(r.isParsed).toBe(false);
  });

  it("ignores bonus and equity amounts", () => {
    const r = extractSalary("This role is also eligible for a signing bonus of $10,000 and equity.");
    expect(r.raw).toBeNull();
  });

  it("requires salary context: a bare dollar figure elsewhere is not pay", () => {
    expect(extractSalary("We offer a $500 learning stipend and free lunch.").raw).toBeNull();
  });

  it("does not guess a period for small amounts", () => {
    expect(extractSalary("Pay: $5,000 - $6,000").raw).toBeNull();
  });

  it("rejects implausible annualized values", () => {
    expect(extractSalary("annual volume of $1.9 processed").raw).toBeNull();
  });
});

describe("extractSalary — ambiguity and absence", () => {
  it("does not parse conflicting regional ranges, but keeps the first span", () => {
    const r = extractSalary(
      "US: the base salary range is $150,000 - $200,000. UK: the base salary range is £100,000 - £130,000."
    );
    expect(r.isParsed).toBe(false);
    expect(r.min).toBeNull();
    expect(r.raw).toContain("$150,000");
  });

  it("does not parse a bare $ when the posting is in a non-US dollar country", () => {
    const r = extractSalary("Salary: $90,000 - $110,000 per year", { countryCode: "CA" });
    expect(r.isParsed).toBe(false);
    expect(r.raw).not.toBeNull();
    expect(extractSalary("Salary: $90,000 - $110,000 per year", { countryCode: "US" }).isParsed).toBe(true);
  });

  it("returns all-null (never zero) when there is no salary", () => {
    expect(extractSalary("We are hiring a data engineer.")).toEqual({
      raw: null, min: null, max: null, currency: null, period: null, isParsed: false,
    });
  });
});

describe("extractSalary — adversarial input (posting text is untrusted)", () => {
  // A quadratic regex on hostile text would stall the ingestion worker. Each string is ~200k chars.
  const cases: Array<[string, string]> = [
    ["repeated '$1,'", "$1,".repeat(70_000)],
    ["repeated '1 '", "1 ".repeat(100_000)],
    ["only currency symbols", "$".repeat(200_000)],
    ["repeated '1,000'", "1,000".repeat(40_000)],
  ];

  it.each(cases)("finishes quickly on %s", (_label, text) => {
    const started = performance.now();
    let result: ReturnType<typeof extractSalary> | undefined;
    expect(() => {
      result = extractSalary(text);
    }).not.toThrow();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).toBeDefined();
  });
});
