import type { EvidenceCatalogEntry, EvidenceSourceType } from "./buildResumeSnapshot";
import type { OptimizeResumeDraft } from "./optimizeResumeSchema";

export interface AppliedBullet {
  sourceFactId: string;
  sourceType: EvidenceSourceType;
  originalText: string;
  optimizedText: string;
  changeType: "unchanged" | "reordered" | "reworded";
  justification: string;
}

export interface RejectedClaim {
  sourceFactId: string;
  reason: string;
}

export interface GuardResult {
  appliedBullets: AppliedBullet[];
  rejectedClaims: RejectedClaim[];
}

/**
 * The actual hallucination backstop (design doc §5, CLAUDE.md §6/§9, D61): the optimizer's own
 * unsupportedClaimsDetected self-report is not trusted as the sole guarantee. Every sourceFactId
 * the model cites must be a key in the catalog that was ACTUALLY passed to that specific call --
 * not merely "some id that looks plausible" -- or the change is dropped into rejectedClaims and
 * never reaches the user as "applied." originalText is always read back from the catalog, never
 * trusted from the model's own echo, so a subtly altered "original" can never slip through
 * mislabeled as unchanged.
 */
export function applyDeterministicGuard(catalog: EvidenceCatalogEntry[], draft: OptimizeResumeDraft): GuardResult {
  const byId = new Map(catalog.map((entry) => [entry.sourceFactId, entry]));
  const appliedBullets: AppliedBullet[] = [];
  const rejectedClaims: RejectedClaim[] = [];

  for (const bullet of draft.selectedBullets) {
    const entry = byId.get(bullet.sourceFactId);
    if (!entry) {
      rejectedClaims.push({
        sourceFactId: bullet.sourceFactId,
        reason: "sourceFactId does not match any evidence item in this user's profile",
      });
      continue;
    }
    appliedBullets.push({
      sourceFactId: entry.sourceFactId,
      sourceType: entry.sourceType,
      originalText: entry.text,
      optimizedText: bullet.optimizedText,
      changeType: bullet.changeType,
      justification: bullet.justification,
    });
  }

  return { appliedBullets, rejectedClaims };
}
