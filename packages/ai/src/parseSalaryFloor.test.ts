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

  describe("thousands separators other than comma and dot", () => {
    it.each<[string, number]>([
      ["at least 60 000 EUR", 60000],
      ["60\u00a0000 EUR", 60000],
      ["60\u202f000 EUR", 60000],
      ["€1 234 567", 1234567],
    ])("parses %j (space-grouped) as %d EUR", (input, amount) => {
      expect(parseSalaryFloor(input)).toEqual({ amount, currency: "EUR", isParsed: true });
    });

    it.each<[string, number]>([
      ["60'000 CHF", 60000],
      ["CHF 90'000", 90000],
      ["CHF 90\u2019000", 90000],
    ])("parses %j (apostrophe-grouped) as %d CHF", (input, amount) => {
      expect(parseSalaryFloor(input)).toEqual({ amount, currency: "CHF", isParsed: true });
    });
  });

  describe("grouping combined with decimals", () => {
    it("parses English grouping with a decimal point", () => {
      expect(parseSalaryFloor("$1,234.56")).toEqual({ amount: 1234.56, currency: "USD", isParsed: true });
      expect(parseSalaryFloor("60,000.00 USD")).toEqual({ amount: 60000, currency: "USD", isParsed: true });
    });

    it("parses German grouping with a decimal comma", () => {
      expect(parseSalaryFloor("€ 60.000,50")).toEqual({ amount: 60000.5, currency: "EUR", isParsed: true });
    });

    it("parses a decimal comma before a k suffix", () => {
      expect(parseSalaryFloor("60,5k EUR")).toEqual({ amount: 60500, currency: "EUR", isParsed: true });
    });

    it.each(["€1,234,56", "60 000 80 000 EUR", "€0.500", "€1.23.456", "€60.1234"])(
      "refuses to guess at %j",
      (input) => {
        expect(parseSalaryFloor(input)).toEqual({ amount: null, currency: "EUR", isParsed: false });
      }
    );
  });

  describe("currency disambiguation", () => {
    it("does not read a prefixed dollar sign (R$, CA$) as USD", () => {
      expect(parseSalaryFloor("R$ 8.000")).toEqual({ amount: 8000, currency: null, isParsed: false });
      expect(parseSalaryFloor("CA$100k")).toEqual({ amount: 100000, currency: null, isParsed: false });
    });

    it("still reads US$ and a bare $ as USD", () => {
      expect(parseSalaryFloor("US$60k")).toEqual({ amount: 60000, currency: "USD", isParsed: true });
      expect(parseSalaryFloor("$60k")).toEqual({ amount: 60000, currency: "USD", isParsed: true });
    });

    it("refuses to pick between two different currencies", () => {
      expect(parseSalaryFloor("€60k or $70k")).toEqual({ amount: 60000, currency: null, isParsed: false });
    });

    it("accepts a symbol and a matching code together", () => {
      expect(parseSalaryFloor("€60k EUR")).toEqual({ amount: 60000, currency: "EUR", isParsed: true });
    });

    it("reads a code written directly before the number", () => {
      expect(parseSalaryFloor("EUR60k")).toEqual({ amount: 60000, currency: "EUR", isParsed: true });
    });

    it("does not read a code glued onto a k suffix", () => {
      expect(parseSalaryFloor("60kEUR")).toEqual({ amount: 60, currency: null, isParsed: false });
    });
  });

  describe("scale words", () => {
    it.each(["1.5 million EUR", "€1.5m", "€2 Mio", "€1.5bn"])("refuses to scale %j", (input) => {
      expect(parseSalaryFloor(input)).toEqual({ amount: null, currency: "EUR", isParsed: false });
    });

    it("refuses lakh-style amounts", () => {
      expect(parseSalaryFloor("₹12 LPA")).toEqual({ amount: null, currency: null, isParsed: false });
    });
  });

  describe("non-annual pay periods", () => {
    it.each<[string, number, string]>([
      ["$50 per hour", 50, "USD"],
      ["£25/hr", 25, "GBP"],
      ["€300/day", 300, "EUR"],
      ["€1.200 pro Woche", 1200, "EUR"],
      ["€3.000 monatlich", 3000, "EUR"],
      ["€5000 pm", 5000, "EUR"],
    ])("keeps the pieces but marks %j unparsed", (input, amount, currency) => {
      expect(parseSalaryFloor(input)).toEqual({ amount, currency, isParsed: false });
    });

    it("still parses explicitly annual phrasing", () => {
      expect(parseSalaryFloor("€60k / year")).toEqual({ amount: 60000, currency: "EUR", isParsed: true });
      expect(parseSalaryFloor("€60k p.a.")).toEqual({ amount: 60000, currency: "EUR", isParsed: true });
    });
  });

  describe("ranges", () => {
    it("applies a k suffix on the upper bound to the lower bound too", () => {
      expect(parseSalaryFloor("60-80k EUR")).toEqual({ amount: 60000, currency: "EUR", isParsed: true });
      expect(parseSalaryFloor("€60 - €80k")).toEqual({ amount: 60000, currency: "EUR", isParsed: true });
    });

    it("does not invent a multiplier for a bare small range", () => {
      expect(parseSalaryFloor("60-80 EUR")).toEqual({ amount: 60, currency: "EUR", isParsed: false });
    });
  });

  describe("implausibly small annual floors", () => {
    it.each<[string, number]>([
      ["60 EUR", 60],
      ["€0", 0],
      ["€0k", 0],
    ])("marks %j unparsed instead of trusting it", (input, amount) => {
      expect(parseSalaryFloor(input)).toEqual({ amount, currency: "EUR", isParsed: false });
    });
  });

  it("only ever reports isParsed with a known currency and a plausible annual amount", () => {
    const corpus = [
      "minimum €60k", "£70,000", "$120k+", "at least 90000 USD", "60k-80k EUR", "80k", "competitive",
      "5000 EUR per month", "€60.000", "€1.234.000", "€60.5k", "€1.23.456", "at least 60 000 EUR",
      "60'000 CHF", "R$ 8.000", "CA$100k", "€60k or $70k", "60kEUR", "1.5 million EUR", "$50 per hour",
      "60-80k EUR", "60 EUR", "€0", "¥5,000,000", "₹12 LPA", "EUR 60.000-80.000", "-€60k", "€ 60.000,50",
      "$60k–$80k", "60k€", "€60K+", "from 60k up to 80k euro", "salary: competitive", "1 234 EUR", "€999",
    ];
    for (const input of corpus) {
      const result = parseSalaryFloor(input);
      if (result.isParsed) {
        expect(result.currency, input).not.toBeNull();
        expect(result.amount, input).not.toBeNull();
        expect(result.amount as number, input).toBeGreaterThanOrEqual(1000);
      }
    }
  });

  it("round-trips every plausible amount across grouping styles, currencies, and annual phrasings", () => {
    const group = (n: number, separator: string) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, separator);
    const currencies: Array<[string, string, "before" | "after"]> = [
      ["€", "EUR", "before"], ["£", "GBP", "before"], ["$", "USD", "before"],
      ["CHF", "CHF", "before"], ["EUR", "EUR", "after"], ["USD", "USD", "after"],
    ];
    const wraps = [(s: string) => s, (s: string) => `minimum ${s}`, (s: string) => `${s} per year`, (s: string) => `${s} p.a.`];
    const amounts = [1000, 1234, 12000, 45000, 60000, 99999, 120500, 1234567];
    const separators = ["", ",", ".", " ", "'", "\u2019", "\u00a0", "\u202f"];

    for (const amount of amounts) {
      for (const [symbol, code, position] of currencies) {
        const forms = separators.map((separator) => group(amount, separator));
        if (amount % 1000 === 0) forms.push(`${amount / 1000}k`, `${amount / 1000}K+`);
        for (const form of forms) {
          for (const wrap of wraps) {
            const phrase = wrap(position === "before" ? `${symbol}${symbol.length > 1 ? " " : ""}${form}` : `${form} ${symbol}`);
            expect(parseSalaryFloor(phrase), phrase).toEqual({ amount, currency: code, isParsed: true });
          }
        }
      }
    }
  });
});
