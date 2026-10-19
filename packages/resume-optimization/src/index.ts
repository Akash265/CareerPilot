export { JobRequirementExtractionSchema } from "./requirements/jobRequirementExtractionSchema";
export type { JobRequirementExtractionDraft, ExtractedRequirement } from "./requirements/jobRequirementExtractionSchema";
export { extractJobRequirements, JobRequirementExtractionValidationError } from "./requirements/extractJobRequirements";
export { ensureJobRequirements, type JobForRequirements } from "./requirements/ensureJobRequirements";
export { buildResumeSnapshot, type EvidenceSourceType, type EvidenceCatalogEntry, type ResumeSnapshot } from "./optimization/buildResumeSnapshot";
export { OptimizeResumeSchema, SelectedBulletSchema } from "./optimization/optimizeResumeSchema";
export type { OptimizeResumeDraft, SelectedBulletDraft } from "./optimization/optimizeResumeSchema";
export { optimizeResume, OptimizeResumeValidationError } from "./optimization/optimizeResume";
export type { RequirementForPrompt, OptimizeResumeInput } from "./optimization/optimizeResume";
export { applyDeterministicGuard, type AppliedBullet, type RejectedClaim, type GuardResult } from "./optimization/applyDeterministicGuard";
export { scoreKeywordCoverage, type RequirementTerm, type KeywordCoverageResult } from "./evaluation/scoreKeywordCoverage";
export { cosineSimilarity, scoreSemanticSimilarity } from "./evaluation/scoreSemanticSimilarity";
export { scoreFactualConsistency } from "./evaluation/scoreFactualConsistency";
export { scoreActionVerbsAndReadability, type ReadabilityResult } from "./evaluation/scoreActionVerbsAndReadability";
export { EVALUATOR_VERSION, EVALUATION_WEIGHTS, type EvaluationScores } from "./types";
export { computeOverallScore } from "./evaluation/computeOverallScore";
export {
  runResumeOptimization, ResumeOptimizationError,
  type ResumeOptimizationErrorClass, type RunResumeOptimizationEnv, type RunResumeOptimizationOptions, type RunResumeOptimizationResult,
} from "./pipeline/runResumeOptimization";
export {
  computeGapTerms, containsTerm, isGapCandidate, MAX_GAP_TERM_WORDS,
  type GapTerm, type RequirementForGapDetection, type RequirementTermType,
} from "./gaps/computeGapTerms";
export { normalizeTermKey } from "./gaps/normalizeTermKey";
export { ALIAS_GROUPS, aliasGroupOf } from "./gaps/aliases";
export { computeSkillGaps, type SkillGap, type SkillGapState, type SkillVerificationForGaps } from "./gaps/computeSkillGaps";
export {
  selectTopMatchJobs, ensureTopMatchRequirements, type TopMatchJob, type TopMatchRequirementsResult,
} from "./gaps/topMatchRequirements";
