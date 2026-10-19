import type { EvidenceCatalogEntry } from "../optimization/buildResumeSnapshot";
import { normalizeTermKey } from "./normalizeTermKey";

/** A required job term not found in the profile (formerly application-package's GapTerm; same shape). */
export interface GapTerm {
  term: string;
  requirementId: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `termLower` occurs in `haystackLower` with no [a-z0-9] character immediately before or
 * after it -- a boundary-aware match, deliberately stricter than a plain substring so short terms
 * ("Go", "C") are not hidden inside longer words ("Google", "C++" would still match itself, but "Go"
 * inside "Google" would not). Both arguments are expected to already be lowercased.
 */
export function containsTerm(haystackLower: string, termLower: string): boolean {
  const escaped = escapeRegExp(termLower);
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(haystackLower);
}

/** job_requirements.term_type (see ensureJobRequirements). */
export type RequirementTermType = "skill" | "tool" | "certification" | "other";

/** What computeGapTerms needs from a job_requirements row: the evidence fields plus the term's type (D104). */
export interface RequirementForGapDetection {
  id: string;
  termText: string;
  requirementLevel: "required" | "preferred";
  termType: RequirementTermType;
}

/** D104: only these term types name something profile text can be checked for. */
const GAP_TERM_TYPES: ReadonlySet<RequirementTermType> = new Set(["skill", "tool", "certification"]);
/** D104: a longer term is a descriptive phrase ("Production data pipeline building experience"), not a matchable name. */
export const MAX_GAP_TERM_WORDS = 4;

/** D104: a required, non-blank skill/tool/certification term of at most MAX_GAP_TERM_WORDS words. */
export function isGapCandidate(r: RequirementForGapDetection): boolean {
  const term = r.termText.trim();
  if (r.requirementLevel !== "required" || term.length === 0 || !GAP_TERM_TYPES.has(r.termType)) return false;
  return term.split(/\s+/).length <= MAX_GAP_TERM_WORDS;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Deterministic gap detection (Phase 7c design §4.3, decision 6): required job terms whose text is not
 * contained -- boundary-aware match (deliberately stricter than scoreKeywordCoverage's substring rule
 * so short terms like "Go" are not hidden by "Google") -- in the text of any profile evidence entry,
 * formatted exactly as buildEvidenceIndex formats it ("context: text"), so a term found here can never
 * also appear in a p: evidence snapshot. job_requirements has no order column, so terms are sorted
 * (term, then id, by plain code-unit comparison for stability across environments) for a stable result.
 * Returns EVERY missing required term (no cap, D100): callers that feed the model slice the first
 * MAX_GAP_TERMS themselves, while the likely-question gap check and the stored snapshot use all of them.
 * Only skill, tool and certification terms of at most MAX_GAP_TERM_WORDS words are candidates (D104):
 * "other"-typed and longer, phrase-shaped requirements ("Production data pipeline building experience")
 * are descriptive and almost never contained verbatim in profile text, so they would be false gaps. The
 * cost: such a requirement is never treated as a gap, even when the profile really lacks it.
 * Known limitation (design §9, D92): "Postgres" in the profile does not cover "PostgreSQL" in the job.
 */
export function computeGapTerms(requirements: RequirementForGapDetection[], catalog: EvidenceCatalogEntry[]): GapTerm[] {
  const haystack = catalog.map((e) => (e.context ? `${e.context}: ${e.text}` : e.text)).join("\n").toLowerCase();
  const sorted = requirements
    .filter(isGapCandidate)
    .map((r) => ({ term: r.termText.trim(), key: normalizeTermKey(r.termText), requirementId: r.id }))
    .sort((a, b) => compareStrings(a.key, b.key) || compareStrings(a.requirementId, b.requirementId));

  const seen = new Set<string>();
  const gaps: GapTerm[] = [];
  for (const candidate of sorted) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    if (containsTerm(haystack, candidate.key)) continue;
    gaps.push({ term: candidate.term, requirementId: candidate.requirementId });
  }
  return gaps;
}
