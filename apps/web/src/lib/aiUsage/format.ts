import type { AiOperation } from "@ai-career/ai";

/** Whole cents; a non-zero amount under a cent shows as "<$0.01" rather than a misleading "$0.00". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Floored, so the badge never claims a threshold the spend has not reached. */
export function percentOfCeiling(spentUsd: number, ceilingUsd: number): number {
  return Math.floor((spentUsd / ceilingUsd) * 100);
}

/** Typed over every AiOperation, so adding an operation without a label is a compile error. */
const OPERATION_LABELS: Record<AiOperation, string> = {
  resume_extraction: "Resume extraction",
  career_goal_parse: "Career goal parsing",
  job_requirements_extraction: "Job requirements extraction",
  resume_optimization: "Resume optimization",
  company_research: "Company research",
  discovery_web_search: "Discovery web search",
  pitch_generation: "Hiring manager pitch",
  cover_letter_generation: "Cover letter",
  interview_prep_generation: "Interview prep",
  match_explanation: "Match explanations",
  profile_fact_embedding: "Profile embeddings",
  goal_embedding: "Career goal embedding",
  job_embedding: "Job embeddings",
  resume_similarity_embedding: "Resume similarity embedding",
};

/** Rows written by a newer build may carry an operation this build does not know: show it raw. */
export function operationLabel(operation: string): string {
  return (OPERATION_LABELS as Record<string, string>)[operation] ?? operation;
}
