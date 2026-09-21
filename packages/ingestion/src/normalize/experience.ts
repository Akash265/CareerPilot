// "N+ years of [a few words] experience" and "experience: N years". The LOWEST
// stated figure is kept: Phase 5 uses this to exclude on a *hard* mismatch, so
// understating is the safe direction. Optional (nice-to-have) lines and company boasts are ignored
// (real postings: "2+ years ... (nice to have)").

const YEARS_THEN_EXPERIENCE =
  /(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*\+?\s*)?(?:years?|yrs?)['’]?\s+(?:of\s+)?(?:[A-Za-z/&-]+\s+){0,4}?experience/gi;
const EXPERIENCE_THEN_YEARS =
  /experience[:\s]+(?:of\s+)?(?:at least\s+|minimum\s+(?:of\s+)?)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi;
const BOAST = /(?:we(?:'ve| have)|our (?:team|company|founders?)|company (?:has|with))[^.]{0,40}$/i;
// A line is optional if it says so ANYWHERE ("... (nice to have)", "... is a plus"). "preferably" and
// "ideally" only make the years optional when they come BEFORE them ("Preferably 3+ years..."); after
// them they qualify the kind of experience ("8+ years of sales experience, preferably selling a
// technical product" -- a real posting -- is a hard 8-year requirement).
const OPTIONAL_ANYWHERE = /(nice to have|a plus|bonus points|desirable|\(preferred\)|\(optional\))/i;
const OPTIONAL_WHEN_BEFORE = /(preferred|preferably|ideally)/i;
// Descriptions are untrusted third-party text; real ones are ~15KB.
const MAX_TEXT_CHARS = 200_000;

function isOptional(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  return OPTIONAL_ANYWHERE.test(line) || OPTIONAL_WHEN_BEFORE.test(text.slice(lineStart, index));
}

export function extractMinExperience(text: string): { years: number | null; evidence: string | null } {
  text = text.slice(0, MAX_TEXT_CHARS);
  let best: { years: number; evidence: string } | null = null;

  for (const pattern of [YEARS_THEN_EXPERIENCE, EXPERIENCE_THEN_YEARS]) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text))) {
      const years = Number(m[1]);
      if (!(years >= 0 && years <= 40)) continue;
      if (BOAST.test(text.slice(Math.max(0, m.index - 60), m.index))) continue;
      if (isOptional(text, m.index)) continue;
      if (best === null || years < best.years) {
        const from = Math.max(0, m.index - 40);
        const to = Math.min(text.length, m.index + m[0].length + 40);
        best = { years, evidence: text.slice(from, to).replace(/\s+/g, " ").trim() };
      }
    }
  }
  return best ?? { years: null, evidence: null };
}
