import type { SalaryPeriod, SalaryResult } from "../types";

// Design (validated against ~1,430 real postings, see plan "Refinements" R6/R11/R12):
//  1. Find currency+amount candidates (prefix form "$1 - $2", suffix form "1 - 2 EUR").
//  2. A trailing ISO code overrides the symbol ("$43,500 MXN" is pesos).
//  3. Reject magnitude figures ($100B), bonus/equity amounts, and anything with no salary context nearby.
//  4. Period: explicit wins; no period + >= 10,000 -> year; no period + < 10,000 -> not a salary.
//  5. Several *different* candidates (regional ranges) -> unparsed, first span kept. Never guess.

const ISO =
  "USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|INR|SGD|HKD|JPY|CNY|KRW|MXN|BRL|ARS|COP|CLP|ZAR|AED|SAR|ILS|TRY";
const CUR = `(?:US\\$|CA\\$|MX\\$|HK\\$|NZ\\$|AU\\$|R\\$|S\\$|C\\$|A\\$|\\$|€|£|${ISO})`;
const NUM = "(?:\\d{1,3}(?:[.,]\\d{3})+|\\d+)(?:\\.\\d{1,2})?";
// The k suffix must not swallow the trailing space, or "$1 $2" (no separator) cannot match.
const AMT = `${NUM}(?:\\s?[kK]\\b)?`;
const SEP = "\\s?(?:-|–|—|to|and)\\s?";
const UNIT = "(?:\\s?(?:\\/\\s?(?:hr|hour|yr|year|mo|month)|per\\s(?:hour|year|month|annum)))?";

const PREFIX = new RegExp(
  `(?<![A-Za-z])(${CUR})\\s?(${AMT})${UNIT}(?:${SEP}(?:${CUR})?\\s?(${AMT})|\\s+${CUR}\\s?(${AMT}))?`,
  "g"
);
const SUFFIX = new RegExp(`(?<![\\d.,])(${AMT})(?:\\s?(?:${ISO}|€|£))?(?:${SEP}(${AMT}))?\\s?(${ISO}|€|£)`, "g");
const TRAILING_ISO = new RegExp(`^\\s?(${ISO})\\b`);

const MAGNITUDE_AFTER = /^\s?(?:M\b|MM\b|B\b|T\b|bn\b|tn\b|million|billion|trillion)/i;
const CONTEXT =
  /(salary|compensation|pay\b|base\b|ote\b|on-target|wage|remuneration|per (?:year|annum|hour|month)|annual|annually|hourly|monthly|\/\s?(?:yr|year|hr|hour|mo|month)\b|a year|an hour|p\.a\.)/i;
const NEGATIVE_BEFORE =
  /(equity|bonus|stock|rsu|options|signing|commission|revenue|funding|raised|valuation)[^.$€£]{0,25}$/i;

const ANNUALIZE: Record<SalaryPeriod, number> = { year: 1, month: 12, hour: 2080 };
const AMBIGUOUS_DOLLAR_COUNTRIES = new Set(["CA", "AU", "NZ", "SG", "HK"]);

// Scanning stops once the candidate cap is reached, which bounds the O(n^2) overlap check on hostile text;
// results come from the candidates seen.
const MAX_CANDIDATES = 50;
// Descriptions are untrusted third-party text; real ones are ~15KB.
const MAX_TEXT_CHARS = 200_000;

const NONE: SalaryResult = { raw: null, min: null, max: null, currency: null, period: null, isParsed: false };

function currencyOf(symbol: string): string {
  const s = symbol.toUpperCase();
  const table: Record<string, string> = {
    "€": "EUR", "£": "GBP", "US$": "USD", "C$": "CAD", "CA$": "CAD", "A$": "AUD", "AU$": "AUD",
    "R$": "BRL", "MX$": "MXN", "S$": "SGD", "HK$": "HKD", "NZ$": "NZD", "$": "USD",
  };
  return table[s] ?? s;
}

function toNumber(raw: string): number {
  let s = raw.trim();
  const thousands = /k$/i.test(s);
  s = s.replace(/k$/i, "").trim();
  // European "60.000" / "1.234.567" (dot thousands, no decimals) vs "45.50".
  s = /^\d{1,3}(?:\.\d{3})+$/.test(s) ? s.replace(/\./g, "") : s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (thousands ? n * 1000 : n) : NaN;
}

function periodNear(text: string, start: number, end: number): SalaryPeriod | null {
  const around = text.slice(Math.max(0, start - 40), end + 40).toLowerCase();
  if (/(per hour|\/\s?hr|\/\s?hour|hourly|an hour)/.test(around)) return "hour";
  if (/(per month|\/\s?mo\b|\/\s?month|monthly|a month)/.test(around)) return "month";
  if (/(per year|per annum|\/\s?yr|\/\s?year|annual|annually|yearly|a year|p\.a\.)/.test(around)) return "year";
  return null;
}

interface Candidate {
  raw: string;
  symbol: string;
  lo: number;
  hi: number;
  period: SalaryPeriod;
  start: number;
  end: number;
}

export function extractSalary(text: string, ctx: { countryCode?: string | null } = {}): SalaryResult {
  text = text.slice(0, MAX_TEXT_CHARS);
  const candidates: Candidate[] = [];
  // Set once the MAX_CANDIDATES cap is hit: a later, disagreeing candidate could then exist past
  // where scanning stopped without ever being seen, so "every candidate seen agrees" can no
  // longer support a confident isParsed:true (D6/D34 "never guess").
  let truncated = false;

  const PATTERNS = [PREFIX, SUFFIX];
  scan: for (let patternIndex = 0; patternIndex < PATTERNS.length; patternIndex++) {
    const re = PATTERNS[patternIndex];
    re.lastIndex = 0;
    const isPrefix = re === PREFIX;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      let end = m.index + m[0].length;
      let symbol = isPrefix ? m[1] : m[3];
      const first = toNumber(isPrefix ? m[2] : m[1]);
      const secondRaw = isPrefix ? (m[3] ?? m[4]) : m[2];
      const second = secondRaw ? toNumber(secondRaw) : first;
      if (!Number.isFinite(first) || !Number.isFinite(second)) continue;

      // "$43,500 - $48,333 MXN": the trailing code is the real currency; the symbol is a hint.
      if (isPrefix) {
        const trailing = TRAILING_ISO.exec(text.slice(end));
        if (trailing) {
          symbol = trailing[1];
          end += trailing[0].length;
        }
      }

      if (MAGNITUDE_AFTER.test(text.slice(end))) continue;
      if (NEGATIVE_BEFORE.test(text.slice(Math.max(0, start - 60), start))) continue;
      if (!CONTEXT.test(text.slice(Math.max(0, start - 120), end + 60))) continue;
      // The suffix pattern re-matches the tail of a range the prefix pattern already took.
      if (candidates.some((c) => start < c.end && c.start < end)) continue;

      const period = periodNear(text, start, end);
      const lo = Math.min(first, second);
      const hi = Math.max(first, second);
      if (!period && lo < 10000) continue;
      if (hi * ANNUALIZE[period ?? "year"] < 1000) continue;

      candidates.push({ raw: text.slice(start, end).trim(), symbol, lo, hi, period: period ?? "year", start, end });
      if (candidates.length >= MAX_CANDIDATES) {
        // Exactly hitting the cap is only "truncated" if a candidate genuinely existed beyond it:
        // either this regex has another raw match right after the one we just took (`re.exec`
        // resumes from its own lastIndex, so this checks exactly that), or a later, not-yet-scanned
        // pattern matches anywhere in the text. A text with precisely MAX_CANDIDATES occurrences
        // and nothing more must still be able to confidently parse.
        const moreInThisPattern = re.exec(text) !== null;
        const moreInLaterPatterns = PATTERNS.slice(patternIndex + 1).some((later) => {
          later.lastIndex = 0;
          return later.test(text);
        });
        truncated = moreInThisPattern || moreInLaterPatterns;
        break scan;
      }
    }
  }

  if (candidates.length === 0) return { ...NONE };
  candidates.sort((a, b) => a.start - b.start);
  const head = candidates[0];
  const currency = currencyOf(head.symbol);

  const allAgree = candidates.every(
    (c) => currencyOf(c.symbol) === currency && c.lo === head.lo && c.hi === head.hi && c.period === head.period
  );
  const ambiguousDollar = head.symbol === "$" && AMBIGUOUS_DOLLAR_COUNTRIES.has(ctx.countryCode ?? "");
  if (!allAgree || ambiguousDollar || truncated) return { ...NONE, raw: head.raw };

  const factor = ANNUALIZE[head.period];
  return { raw: head.raw, min: head.lo * factor, max: head.hi * factor, currency, period: head.period, isParsed: true };
}
