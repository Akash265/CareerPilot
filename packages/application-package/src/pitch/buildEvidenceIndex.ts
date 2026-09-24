import type { EvidenceCatalogEntry } from "@ai-career/resume-optimization";
import type { EvidenceKind } from "../types";

export interface PitchEvidenceItem {
  id: string;
  kind: EvidenceKind;
  text: string;
  sourceUrl: string | null;
}

export interface ResearchFactForEvidence {
  id: string;
  factText: string;
  sourceUrl: string | null;
}

export interface RequirementForEvidence {
  id: string;
  termText: string;
  requirementLevel: "required" | "preferred";
}

/**
 * The single list of everything a pitch bullet may cite (design doc §4.4). The id prefix encodes the
 * kind (r: research fact, q: job requirement, p: profile evidence) so applyPitchGuard can check "the
 * company bullet cites research" etc. by id alone; prefixes also make ids unique across the three
 * source tables.
 */
export function buildEvidenceIndex(
  researchFacts: ResearchFactForEvidence[],
  requirements: RequirementForEvidence[],
  catalog: EvidenceCatalogEntry[]
): PitchEvidenceItem[] {
  return [
    ...researchFacts.map((f) => ({ id: `r:${f.id}`, kind: "research" as const, text: f.factText, sourceUrl: f.sourceUrl })),
    ...requirements.map((r) => ({ id: `q:${r.id}`, kind: "requirement" as const, text: `[${r.requirementLevel}] ${r.termText}`, sourceUrl: null })),
    ...catalog.map((e) => ({ id: `p:${e.sourceFactId}`, kind: "profile" as const, text: e.context ? `${e.context}: ${e.text}` : e.text, sourceUrl: null })),
  ];
}
