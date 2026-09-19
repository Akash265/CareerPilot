export type ParsedSalaryFloor = {
  amount: number | null;
  currency: string | null;
  isParsed: boolean;
};

const CURRENCY_CODES = ["EUR", "USD", "GBP", "CHF", "CAD", "AUD"];
const CODE_RE = new RegExp(`(?:^|[^A-Za-z])(${CURRENCY_CODES.join("|")})(?![A-Za-z])`, "gi");

// Below this an "annual salary floor" is far more likely to be an hourly,
// daily, or mis-scaled figure than a real salary in any supported currency.
const MIN_PLAUSIBLE_ANNUAL_FLOOR = 1000;

// The longest run of digits and grouping/decimal characters, ending on a digit.
const NUMBER_RUN_RE = /\d[\d.,'’   ]*\d|\d/;
const PLAIN_DECIMAL_RE = /^(\d+)[.,](\d{1,2})$/;
// lead, all groups, the group separator, then an optional decimal separator + digits.
const GROUPED_RE = /^([1-9]\d{0,2})(([,.'’   ])\d{3}(?:\3\d{3})*)(?:([.,])(\d{1,2}))?$/;

const THOUSANDS_SUFFIX_RE = /^\s*k(?![A-Za-z])/i;
const RANGE_THOUSANDS_RE = /^\s*(?:[-–—]|to\b|bis\b)\s*[€£$]?\s*\d[\d.,]*\s*k(?![A-Za-z])/i;
const SCALE_WORD_RE =
  /^\s*(?:mm|mn|mio|mln|million|millions|bn|billion|thousand|thousands|tsd|tausend|lakhs?|lacs?|lpa|crores?|m|b)(?![A-Za-z])/i;
const NON_ANNUAL_PERIOD_RE =
  /\b(?:hours?|hourly|hrs?|days?|daily|weeks?|weekly|bi-?weekly|fortnightly|months?|monthly|quarterly|monat(?:lich)?|stunde|tag|woche)\b|\/\s*(?:h|hr|hrs|hour|d|day|wk|week|mo|month)\b|\bp\.?\s?(?:h|d|w|m)\b/i;

/**
 * Only shapes whose meaning is unambiguous resolve to a number:
 *  - plain digits ("60000")
 *  - one decimal separator followed by 1-2 digits ("60.5", "60,50")
 *  - digit groups of exactly 3 after a 1-3 digit lead, with ONE consistent
 *    separator from `, . ' ’ <space>` ("60.000", "60,000", "60 000", "90'000"),
 *    optionally followed by a decimal separator that differs from it
 *    ("1,234.56", "60.000,50")
 * Everything else ("60.1234", "1.23.456", "1,234,56", "0.500") is null so the
 * caller reports isParsed: false instead of guessing.
 */
function parseNumericToken(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token);

  const plain = PLAIN_DECIMAL_RE.exec(token);
  if (plain) return Number(`${plain[1]}.${plain[2]}`);

  const grouped = GROUPED_RE.exec(token);
  if (grouped) {
    const [, lead, groups, groupSeparator, decimalSeparator, decimals] = grouped;
    if (decimalSeparator !== undefined && decimalSeparator === groupSeparator) return null;
    const integerPart = (lead + groups).split(groupSeparator).join("");
    return Number(decimals === undefined ? integerPart : `${integerPart}.${decimals}`);
  }

  return null;
}

// null when the text names no currency, or names more than one, or uses a
// dollar sign that belongs to another currency (R$, CA$, A$, ...).
function detectCurrency(text: string): string | null {
  const found = new Set<string>();
  let hasForeignDollar = false;

  if (text.includes("€")) found.add("EUR");
  if (text.includes("£")) found.add("GBP");
  for (const match of text.matchAll(/([A-Za-z]*)\$/g)) {
    const prefix = match[1].toUpperCase();
    if (prefix === "" || prefix === "US") found.add("USD");
    else hasForeignDollar = true;
  }
  for (const match of text.matchAll(CODE_RE)) found.add(match[1].toUpperCase());

  return !hasForeignDollar && found.size === 1 ? [...found][0] : null;
}

/**
 * Extends DECISIONS.md D6's principle ("the LLM never extracts or estimates
 * numeric salary data") from job-posting salary text to career-goal salary
 * text: the Anthropic extraction call (extractCareerGoal.ts) returns only
 * the raw phrase the user wrote; this function is the one place that turns
 * it into a number.
 *
 * `isParsed: true` is a promise that the review UI may skip its "please
 * confirm this number" warning, so it is only made when the currency is
 * unambiguous, the number's format is unambiguous, no scale word or non-annual
 * period contradicts it, and the amount is a plausible annual floor. Anything
 * else still returns whatever pieces were found, with `isParsed: false`, so the
 * review form always exposes plain amount/currency inputs as the fallback
 * (design doc §5). A range yields its lower bound: the floor.
 */
export function parseSalaryFloor(text: string | null): ParsedSalaryFloor {
  if (text === null) return { amount: null, currency: null, isParsed: false };
  const trimmed = text.trim();
  if (trimmed === "") return { amount: null, currency: null, isParsed: false };

  const currency = detectCurrency(trimmed);

  const numberMatch = NUMBER_RUN_RE.exec(trimmed);
  if (!numberMatch) return { amount: null, currency, isParsed: false };

  const base = parseNumericToken(numberMatch[0]);
  if (base === null) return { amount: null, currency, isParsed: false };

  const rest = trimmed.slice(numberMatch.index + numberMatch[0].length);
  if (SCALE_WORD_RE.test(rest)) return { amount: null, currency, isParsed: false };

  // "60-80k" means 60k-80k: the suffix on the upper bound applies to both.
  const scaled = THOUSANDS_SUFFIX_RE.test(rest) || RANGE_THOUSANDS_RE.test(rest) ? base * 1000 : base;
  const amount = Math.round(scaled * 100) / 100;

  if (NON_ANNUAL_PERIOD_RE.test(trimmed)) return { amount, currency, isParsed: false };
  if (currency === null) return { amount, currency: null, isParsed: false };
  if (amount < MIN_PLAUSIBLE_ANNUAL_FLOOR) return { amount, currency, isParsed: false };

  return { amount, currency, isParsed: true };
}
