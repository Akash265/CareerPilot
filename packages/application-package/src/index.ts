export * from "./types";
export { capText, isHttpUrl } from "./research/text";
export { extractCitedFacts, MAX_WEB_FACTS, MAX_FACT_CHARS } from "./research/extractCitedFacts";
export { deriveInternalFacts, type InternalJobSummary } from "./research/deriveInternalFacts";
export {
  runCompanyResearch, MAX_PAUSE_CONTINUATIONS,
  type CompanyResearchInput, type CompanyResearchResult, type CompanyResearchEnv,
} from "./research/runCompanyResearch";
export {
  ensureCompanyResearch, loadCompanyResearch, CompanyResearchRefreshFailedError,
  type CompanyResearchRow, type CompanyResearchFactRow, type CompanyResearchWithFacts, type JobForResearch,
} from "./research/ensureCompanyResearch";
export {
  buildEvidenceIndex, type PitchEvidenceItem, type ResearchFactForEvidence, type RequirementForEvidence,
} from "./pitch/buildEvidenceIndex";
export { PitchDraftSchema, PitchDraftBulletSchema, type PitchDraft, type PitchDraftBullet } from "./pitch/pitchSchema";
export { generatePitch, PitchGenerationValidationError, type GeneratePitchInput } from "./pitch/generatePitch";
export { applyPitchGuard, REQUIRED_EVIDENCE_KIND, type PitchGuardResult } from "./pitch/applyPitchGuard";
export { insertPitchVersion, type ApplicationPitchRow, type NewPitchVersion } from "./pipeline/insertPitchVersion";
export {
  runPitchGeneration, PitchGenerationError,
  type PitchGenerationErrorClass, type RunPitchGenerationEnv, type RunPitchGenerationOptions, type RunPitchGenerationResult,
} from "./pipeline/runPitchGeneration";
export { createEditedPitch, EditPitchBodySchema, PitchEditError, type EditPitchBody } from "./pipeline/createEditedPitch";
