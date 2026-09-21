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
  let remaining = text;
  for (const pattern of NOT_OFFERED) {
    if (negatedEvidence === null) {
      const m = pattern.exec(text);
      if (m) negatedEvidence = snippet(text, m.index, m[0].length);
    }
    // Remove EVERY negated clause so none of them ("cannot sponsor work visas", said twice) is also read as an offer.
    // A fresh global copy per call: a shared /g regex would leak lastIndex between calls.
    remaining = remaining.replace(new RegExp(pattern.source, pattern.flags + "g"), " ");
  }

  let offeredEvidence: string | null = null;
  for (const pattern of OFFERED) {
    const m = pattern.exec(remaining);
    if (m) {
      offeredEvidence = snippet(remaining, m.index, m[0].length);
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
