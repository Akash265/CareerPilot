// apps/web/src/lib/applicationPitch/serializePitch.ts
import {
  isHttpUrl, type ApplicationPitchRow, type CompanyResearchWithFacts, type StoredPitchBullet,
} from "@ai-career/application-package";

export interface PitchEvidenceView {
  id: string;
  kind: "research" | "requirement" | "profile";
  text: string;
  sourceUrl: string | null;
}

export interface PitchBulletView {
  kind: "company" | "role" | "candidate";
  text: string;
  supported: boolean | null;
  unsupportedReason: string | null;
  evidence: PitchEvidenceView[];
}

export interface PitchView {
  id: string;
  version: number;
  origin: "generated" | "user_edited";
  parentPitchId: string | null;
  bullets: PitchBulletView[];
  requiresReview: boolean;
  researchStatus: "ok" | "no_results" | "failed";
  researchedAt: string | null;
  generationModel: string | null;
  createdAt: string;
}

export interface ResearchFactView {
  id: string;
  sourceKind: "web" | "internal";
  factText: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
}

export interface ResearchView {
  id: string;
  companyName: string;
  status: "ok" | "no_results" | "failed";
  researchedAt: string;
  searchCount: number;
  facts: ResearchFactView[];
}

/** Defense in depth (spec §6): URLs were validated before insert, and are re-validated before they can become a link. */
const safeUrl = (url: string | null): string | null => (url !== null && isHttpUrl(url) ? url : null);

export function toPitchView(row: ApplicationPitchRow): PitchView {
  const bullets = row.bullets as StoredPitchBullet[];
  return {
    id: row.id,
    version: row.version,
    origin: row.origin,
    parentPitchId: row.parentPitchId,
    bullets: bullets.map((b) => ({
      kind: b.kind,
      text: b.text,
      supported: b.supported,
      unsupportedReason: b.unsupportedReason,
      evidence: b.evidence.map((e) => ({ id: e.id, kind: e.kind, text: e.text, sourceUrl: safeUrl(e.sourceUrl) })),
    })),
    requiresReview: row.requiresReview,
    researchStatus: row.researchStatusSnapshot,
    researchedAt: row.researchedAtSnapshot === null ? null : row.researchedAtSnapshot.toISOString(),
    generationModel: row.generationModel,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toResearchView({ research, facts }: CompanyResearchWithFacts): ResearchView {
  return {
    id: research.id,
    companyName: research.companyName,
    status: research.status,
    researchedAt: research.researchedAt.toISOString(),
    searchCount: research.searchCount,
    facts: facts.map((f) => ({
      id: f.id,
      sourceKind: f.sourceKind,
      factText: f.factText,
      sourceUrl: safeUrl(f.sourceUrl),
      sourceTitle: f.sourceTitle,
    })),
  };
}
