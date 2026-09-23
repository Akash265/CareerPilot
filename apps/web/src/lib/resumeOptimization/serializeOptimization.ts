// apps/web/src/lib/resumeOptimization/serializeOptimization.ts
import { schema } from "@ai-career/db";

type OptimizationRow = typeof schema.resumeOptimizations.$inferSelect;
type EvaluationRow = typeof schema.atsEvaluations.$inferSelect;

export interface SelectedBulletView {
  sourceFactId: string;
  sourceType: string;
  originalText: string;
  optimizedText: string;
  changeType: "unchanged" | "reordered" | "reworded";
  justification: string;
}

export interface RejectedClaimView {
  sourceFactId: string;
  reason: string;
}

export interface EvaluationView {
  requiredKeywordCoverage: number;
  preferredKeywordCoverage: number;
  semanticSimilarity: number | null;
  factualConsistency: number;
  actionVerbScore: number;
  machineReadabilityScore: number;
  overallScore: number;
  evaluatorVersion: string;
}

export interface OptimizationView {
  id: string;
  version: number;
  selectedBullets: SelectedBulletView[];
  addedTerms: string[];
  unsupportedClaimsDetected: string[];
  rejectedClaims: RejectedClaimView[];
  requiresReview: boolean;
  generationModel: string;
  createdAt: string;
  evaluation: EvaluationView;
}

/** 0-1 stored fraction -> 0-100 display percentage, same convention as lib/matching/serializeMatch's pct(). */
const pct = (value: string): number => Math.round(Number(value) * 100);

export function toEvaluationView(row: EvaluationRow): EvaluationView {
  return {
    requiredKeywordCoverage: pct(row.requiredKeywordCoverage),
    preferredKeywordCoverage: pct(row.preferredKeywordCoverage),
    semanticSimilarity: row.semanticSimilarity === null ? null : pct(row.semanticSimilarity),
    factualConsistency: pct(row.factualConsistency),
    actionVerbScore: pct(row.actionVerbScore),
    machineReadabilityScore: pct(row.machineReadabilityScore),
    overallScore: Number(row.overallScore),
    evaluatorVersion: row.evaluatorVersion,
  };
}

export function toOptimizationView(row: OptimizationRow, evaluation: EvaluationRow): OptimizationView {
  return {
    id: row.id,
    version: row.version,
    selectedBullets: row.selectedBullets as SelectedBulletView[],
    addedTerms: row.addedTerms,
    unsupportedClaimsDetected: row.unsupportedClaimsDetected,
    rejectedClaims: row.rejectedClaims as RejectedClaimView[],
    requiresReview: row.requiresReview,
    generationModel: row.generationModel,
    createdAt: row.createdAt.toISOString(),
    evaluation: toEvaluationView(evaluation),
  };
}
