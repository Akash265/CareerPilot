// Phase 13b: gap detection moved to @ai-career/resume-optimization (src/gaps/), shared with skill verification and the
// resume. Re-exported here so the cover-letter and interview-prep code keeps its imports.
export {
  computeGapTerms, containsTerm, isGapCandidate, MAX_GAP_TERM_WORDS, type RequirementForGapDetection, type RequirementTermType,
} from "@ai-career/resume-optimization";
