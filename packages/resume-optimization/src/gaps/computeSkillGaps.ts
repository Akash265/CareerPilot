import type { EvidenceCatalogEntry } from "../optimization/buildResumeSnapshot";
import { containsTerm, isGapCandidate, type RequirementForGapDetection } from "./computeGapTerms";
import { normalizeTermKey } from "./normalizeTermKey";
import { aliasGroupOf } from "./aliases";

export interface SkillVerificationForGaps {
  termKey: string;
  status: "have" | "dont_have" | "alias";
  aliasSkillName: string | null;
}
export type SkillGapState = "covered" | "declined" | "unanswered";
export interface SkillGap {
  termKey: string;
  termDisplay: string;
  requirementIds: string[];
  state: SkillGapState;
  suggestion: string | null;
}

/**
 * Phase 13b design §5.2: every gap candidate (isGapCandidate, D104) of one job, grouped by normalized term and
 * classified. covered = the user said "have", or aliased it to a skill still in the profile, or profile text contains
 * it (computeGapTerms' boundary-aware rule; profile text wins over "dont_have"). declined = "dont_have". Otherwise
 * unanswered, with a suggestion: a stale alias's old skill, else a profile skill in the same alias group. A suggestion
 * never covers a term. Sorted by term key; requirement ids sorted.
 */
export function computeSkillGaps(
  requirements: RequirementForGapDetection[],
  catalog: EvidenceCatalogEntry[],
  verifications: SkillVerificationForGaps[],
  profileSkillNames: string[]
): SkillGap[] {
  const haystack = catalog.map((e) => (e.context ? `${e.context}: ${e.text}` : e.text)).join("\n").toLowerCase();
  const profileByKey = new Map(profileSkillNames.map((name) => [normalizeTermKey(name), name]));
  const answerByKey = new Map(verifications.map((answer) => [answer.termKey, answer]));

  const byKey = new Map<string, { termDisplay: string; requirementIds: string[] }>();
  for (const r of requirements.filter(isGapCandidate)) {
    const key = normalizeTermKey(r.termText);
    const existing = byKey.get(key);
    if (existing) existing.requirementIds.push(r.id);
    else byKey.set(key, { termDisplay: r.termText.trim().replace(/\s+/g, " "), requirementIds: [r.id] });
  }

  const gaps: SkillGap[] = [];
  for (const [termKey, { termDisplay, requirementIds }] of byKey) {
    const answer = answerByKey.get(termKey);
    const liveAlias = answer?.status === "alias" && answer.aliasSkillName !== null && profileByKey.has(normalizeTermKey(answer.aliasSkillName));
    let state: SkillGapState;
    if (answer?.status === "have" || liveAlias || containsTerm(haystack, termKey)) state = "covered";
    else if (answer?.status === "dont_have") state = "declined";
    else state = "unanswered";
    gaps.push({
      termKey, termDisplay, requirementIds: [...requirementIds].sort(), state,
      suggestion: state === "unanswered" ? suggestionFor(termKey, answer, profileByKey) : null,
    });
  }
  return gaps.sort((a, b) => (a.termKey < b.termKey ? -1 : a.termKey > b.termKey ? 1 : 0));
}

function suggestionFor(termKey: string, answer: SkillVerificationForGaps | undefined, profileByKey: Map<string, string>): string | null {
  if (answer?.status === "alias" && answer.aliasSkillName) return answer.aliasSkillName;
  for (const key of aliasGroupOf(termKey) ?? []) {
    const name = key === termKey ? undefined : profileByKey.get(key);
    if (name) return name;
  }
  return null;
}
