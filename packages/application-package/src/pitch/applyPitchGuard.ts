import type { EvidenceKind, EvidenceSnapshot, PitchBulletKind, StoredPitchBullet } from "../types";
import { capText } from "../research/text";
import type { PitchEvidenceItem } from "./buildEvidenceIndex";
import type { PitchDraft } from "./pitchSchema";

export const REQUIRED_EVIDENCE_KIND: Record<PitchBulletKind, EvidenceKind> = {
  company: "research",
  role: "requirement",
  candidate: "profile",
};

const KIND_LABEL: Record<EvidenceKind, string> = {
  research: "company research",
  requirement: "job requirement",
  profile: "profile evidence",
};

export interface PitchGuardResult {
  bullets: StoredPitchBullet[];
  requiresReview: boolean;
}

/** Model-supplied ids are untrusted: quote and cap them before they go into a stored reason. */
const quoteId = (id: string) => JSON.stringify(capText(id, 60));

/**
 * The pitch's grounding backstop (design doc §4.5; same role as Phase 6's applyDeterministicGuard).
 * The model's citations are checked against the evidence index that was actually passed to THIS call:
 * every id must exist, no id may repeat within a bullet, and each bullet must cite at least one item of
 * its required kind. A failing bullet is kept with supported=false and a reason -- never dropped -- so
 * the user always sees three bullets and exactly what failed. Evidence text is re-read from the index,
 * never from the model.
 */
export function applyPitchGuard(evidence: PitchEvidenceItem[], draft: PitchDraft): PitchGuardResult {
  const byId = new Map(evidence.map((item) => [item.id, item]));

  const bullets: StoredPitchBullet[] = draft.bullets.map((bullet) => {
    const reasons: string[] = [];
    const seen = new Set<string>();
    const snapshots: EvidenceSnapshot[] = [];

    for (const id of bullet.evidenceIds) {
      if (seen.has(id)) {
        reasons.push(`evidence id ${quoteId(id)} is cited more than once`);
        continue;
      }
      seen.add(id);
      const item = byId.get(id);
      if (!item) {
        reasons.push(`evidence id ${quoteId(id)} does not exist`);
        continue;
      }
      snapshots.push({ id: item.id, kind: item.kind, text: item.text, sourceUrl: item.sourceUrl });
    }

    const required = REQUIRED_EVIDENCE_KIND[bullet.kind];
    if (!snapshots.some((s) => s.kind === required)) {
      reasons.push(`cites no ${KIND_LABEL[required]}`);
    }

    return {
      kind: bullet.kind,
      text: bullet.text,
      supported: reasons.length === 0,
      unsupportedReason: reasons.length === 0 ? null : reasons.join("; "),
      evidence: snapshots,
    };
  });

  return { bullets, requiresReview: bullets.some((b) => b.supported === false) || draft.requiresReview };
}
