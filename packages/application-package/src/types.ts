/** Shared Phase 7a types (design doc §3-§4). */

export type ResearchStatus = "ok" | "no_results" | "failed";

/** A fact about to be written to company_research_facts (before it has an id). */
export interface ResearchFactDraft {
  sourceKind: "web" | "internal";
  factText: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  citedText: string | null;
}

export const PITCH_BULLET_KINDS = ["company", "role", "candidate"] as const;
export type PitchBulletKind = (typeof PITCH_BULLET_KINDS)[number];

export type EvidenceKind = "research" | "requirement" | "profile";

/** A copy of one cited evidence item, stored inside the pitch so it survives a research refresh. */
export interface EvidenceSnapshot {
  id: string;
  kind: EvidenceKind;
  text: string;
  sourceUrl: string | null;
}

/** One element of application_pitches.bullets. supported is null for a user_edited version. */
export interface StoredPitchBullet {
  kind: PitchBulletKind;
  text: string;
  supported: boolean | null;
  unsupportedReason: string | null;
  evidence: EvidenceSnapshot[];
}

export const MAX_BULLET_CHARS = 600;
