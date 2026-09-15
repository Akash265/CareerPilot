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
  let amount = Number(digits);
  if (Number.isNaN(amount)) return { amount: null, currency, isParsed: false };
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
