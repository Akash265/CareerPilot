export type ParsedSalaryFloor = {
  amount: number | null;
  currency: string | null;
  isParsed: boolean;
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  "€": "EUR",
  "£": "GBP",
  "$": "USD",
};

const CURRENCY_CODES = ["EUR", "USD", "GBP", "CHF", "CAD", "AUD"];

/**
 * Resolves a digit string (commas already stripped, dots may remain) to a
 * number, or `null` when the dot usage is ambiguous.
 *
 * A `.` in salary text is genuinely ambiguous between European
 * thousands-grouping ("€60.000" = 60000) and a decimal point ("60.5" = 60.5).
 * We only trust an interpretation when the shape is unambiguous:
 *  - no dot at all -> plain number.
 *  - exactly one dot, followed by exactly 3 digits with nothing after ->
 *    thousands separator (e.g. "60.000").
 *  - exactly one dot, followed by 1-2 digits at the end -> real decimal
 *    point (e.g. "60.5", "60.50").
 *  - multiple dots that all look like grouping (first group 1-3 digits,
 *    every later group exactly 3 digits, e.g. "1.234.000") -> thousands
 *    separators throughout.
 *  - anything else (e.g. "60.1234", "1.23.456") -> unparseable; caller
 *    should surface isParsed: false rather than guess.
 */
function resolveNumericAmount(rawDigits: string): number | null {
  if (!rawDigits.includes(".")) {
    const value = Number(rawDigits);
    return Number.isNaN(value) ? null : value;
  }

  const groups = rawDigits.split(".");

  if (groups.length === 2) {
    const [whole, frac] = groups;
    if (/^\d{3}$/.test(frac)) {
      const value = Number(whole + frac);
      return Number.isNaN(value) ? null : value;
    }
    if (/^\d{1,2}$/.test(frac)) {
      const value = Number(`${whole}.${frac}`);
      return Number.isNaN(value) ? null : value;
    }
    return null;
  }

  const [first, ...rest] = groups;
  const looksLikeGrouping = /^\d{1,3}$/.test(first) && rest.every((g) => /^\d{3}$/.test(g));
  if (looksLikeGrouping) {
    const value = Number(groups.join(""));
    return Number.isNaN(value) ? null : value;
  }

  return null;
}

/**
 * Extends DECISIONS.md D6's principle ("the LLM never extracts or estimates
 * numeric salary data") from job-posting salary text to career-goal salary
 * text: the Anthropic extraction call (extractCareerGoal.ts) returns only
 * the raw phrase the user wrote; this function is the one place that turns
 * it into a number. Deliberately narrow -- anything it can't confidently
 * resolve comes back with isParsed: false so the review UI always exposes
 * plain amount/currency inputs as a fallback (design doc §5).
 */
export function parseSalaryFloor(text: string | null): ParsedSalaryFloor {
  if (text === null) return { amount: null, currency: null, isParsed: false };
  const trimmed = text.trim();
  if (trimmed === "") return { amount: null, currency: null, isParsed: false };

  let currency: string | null = null;
  for (const [symbol, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (trimmed.includes(symbol)) {
      currency = code;
      break;
    }
  }
  if (currency === null) {
    const codeMatch = trimmed.toUpperCase().match(new RegExp(`\\b(${CURRENCY_CODES.join("|")})\\b`));
    if (codeMatch) currency = codeMatch[1];
  }

  // Matches the first number in the phrase, optionally followed by a "k"/"K"
  // thousands suffix -- e.g. "60k", "60,000", "60000". A range like
  // "60k-80k" intentionally matches only the FIRST number: that's the floor.
  const numberMatch = trimmed.match(/(\d[\d,.]*)\s*([kK])?/);
  if (!numberMatch) return { amount: null, currency, isParsed: false };

  const digits = numberMatch[1].replace(/,/g, "");
  const resolved = resolveNumericAmount(digits);
  if (resolved === null) return { amount: null, currency, isParsed: false };
  let amount = resolved;
  if (numberMatch[2]) amount *= 1000;

  // Per-month phrasing is too ambiguous to safely annualize (gross vs net,
  // currency-specific conventions) -- surface the parsed pieces but mark the
  // whole result unparsed so the user confirms/corrects it by hand.
  if (/\bmonth(ly)?\b|\/\s*mo\b/i.test(trimmed)) {
    return { amount, currency, isParsed: false };
  }

  // Without a currency, a bare number is too ambiguous to trust as a
  // confirmed salary floor.
  if (currency === null) return { amount, currency: null, isParsed: false };

  return { amount, currency, isParsed: true };
}
