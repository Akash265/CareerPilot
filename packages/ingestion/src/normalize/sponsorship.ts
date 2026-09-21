import type { SponsorshipValue } from "../types";

// Bare "sponsorship" is NOT a signal ("event sponsorship", "executive sponsor",
// "financial sponsor" all appear in real postings). Every phrase here ties the
// word to a visa / work / immigration / employment context.

const NEGATION =
  "(?:no|not|cannot|can['’]?t|unable to|won['’]?t|will not|do(?:es)? not|don['’]?t|not able to|not in a position to)";
const WORK_CONTEXT = "(?:visas?|immigration|work|employment)";

const NOT_OFFERED: RegExp[] = [
  new RegExp(`\\b${NEGATION}\\b[^.\\n]{0,40}\\b${WORK_CONTEXT}\\b[^.\\n]{0,20}\\bsponsor(?:ship|ing)?\\b`, "i"),
  new RegExp(`\\b${NEGATION}\\b[^.\\n]{0,40}\\bsponsor(?:ship|ing)?\\b[^.\\n]{0,20}\\b${WORK_CONTEXT}\\b`, "i"),
  /\bvisa sponsorship (?:is )?(?:not|unavailable)/i,
  /\b(?:without|not require|no need for)\b[^.\n]{0,30}\bsponsorship\b/i,
  /\bmust (?:already )?(?:be|have)\b[^.\n]{0,30}\b(?:authori[sz]ed|authori[sz]ation|eligible|right) to work\b/i,
];

const OFFERED: RegExp[] = [
  /\bvisa sponsorship (?:is |will be )?(?:available|offered|provided|possible)/i,
  /\b(?:we|company|employer)\b[^.\n]{0,25}\b(?:sponsor|offer(?:s)? sponsorship)\b[^.\n]{0,20}\bvisas?\b/i,
  /\b(?:offer|provide)s?\b[^.\n]{0,15}\bvisa sponsorship\b/i,
  /\bsponsor(?:ing)?\b[^.\n]{0,12}\b(?:work )?visas?\b/i,
];

// Global copies for blanking every negated clause. String.replace resets lastIndex to 0 first, so sharing them is safe.
const NOT_OFFERED_GLOBAL = NOT_OFFERED.map((p) => new RegExp(p.source, p.flags + "g"));

// Descriptions are untrusted third-party text; real ones are ~15KB.
const MAX_TEXT_CHARS = 200_000;

function snippet(text: string, index: number, length: number): string {
  const from = Math.max(0, index - 40);
  const to = Math.min(text.length, index + length + 40);
  return text.slice(from, to).replace(/\s+/g, " ").trim();
}

export function extractSponsorship(text: string): {
  value: SponsorshipValue;
  evidence: string | null;
  conflict: boolean;
} {
  text = text.slice(0, MAX_TEXT_CHARS);
  let negatedEvidence: string | null = null;
  // Blank (not delete) every negated clause with same-length spaces, so "cannot sponsor work visas" (said any number
  // of times) is never also read as an offer, and match indexes still point into the ORIGINAL text.
  let blanked = text;
  for (const [i, pattern] of NOT_OFFERED.entries()) {
    if (negatedEvidence === null) {
      const m = pattern.exec(text);
      if (m) negatedEvidence = snippet(text, m.index, m[0].length);
    }
    blanked = blanked.replace(NOT_OFFERED_GLOBAL[i] as RegExp, (m) => " ".repeat(m.length));
  }

  let offeredEvidence: string | null = null;
  for (const pattern of OFFERED) {
    const m = pattern.exec(blanked);
    if (m) {
      // Evidence is what the user reads: cut it from the original, not from the blanked copy.
      offeredEvidence = snippet(text, m.index, m[0].length);
      break;
    }
  }

  if (offeredEvidence && negatedEvidence) {
    return { value: "unknown", evidence: `${offeredEvidence} || ${negatedEvidence}`, conflict: true };
  }
  if (offeredEvidence) return { value: "offered", evidence: offeredEvidence, conflict: false };
  if (negatedEvidence) return { value: "not_offered", evidence: negatedEvidence, conflict: false };
  return { value: "unknown", evidence: null, conflict: false };
}
