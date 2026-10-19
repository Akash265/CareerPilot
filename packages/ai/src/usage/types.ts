/**
 * Phase 11a (design §3.1). Every Anthropic `messages.create` and every Voyage embedding request is
 * labelled with the product operation that spent the money. A new operation is added here (and only
 * here): `ai_calls.operation` is plain text, not a CHECK, so no migration is needed.
 */
export const AI_OPERATIONS = [
  "resume_extraction",
  "career_goal_parse",
  "job_requirements_extraction",
  "resume_optimization",
  "company_research",
  "discovery_web_search",
  "pitch_generation",
  "cover_letter_generation",
  "interview_prep_generation",
  "match_explanation",
  "profile_fact_embedding",
  "goal_embedding",
  "job_embedding",
  "resume_similarity_embedding",
] as const;

export type AiOperation = (typeof AI_OPERATIONS)[number];

export type AiProvider = "anthropic" | "voyage";

/** Transport outcome only (design §2.7): schema-validation failures stay with each call site's *ValidationError. */
export type AiCallOutcome = "ok" | "api_error" | "blocked";

export interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  webSearchRequests: number;
}

/**
 * One row of `ai_calls`. Carries metadata only -- never prompt text, response text, or any profile field
 * (CLAUDE.md §9). `errorCode` is a short code (e.g. `anthropic:429`, `voyage:503`, `network`), never an
 * error message, because provider messages can echo request content. An `ok` row may carry `usage_estimated`: the
 * provider reported no token usage, so the tokens are a conservative estimate from the request.
 */
export interface AiCallEvent extends UsageCounts {
  id: string;
  createdAt: Date;
  operation: AiOperation;
  provider: AiProvider;
  model: string;
  latencyMs: number;
  estimatedCostUsd: number;
  priceKnown: boolean;
  outcome: AiCallOutcome;
  errorCode: string | null;
}

/**
 * Where usage goes. Property (not method) syntax on purpose: it makes TypeScript check parameter types
 * contravariantly, so a structurally-declared implementation elsewhere (packages/db's DbUsageSink, which
 * does not import this package) fails to compile if the two shapes drift.
 */
export interface AiUsageSink {
  /** Sum of estimated_cost_usd for calls created at or after `since`. */
  spendSinceUsd: (since: Date) => Promise<number>;
  record: (event: AiCallEvent) => Promise<void>;
}

export const ZERO_USAGE: UsageCounts = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  webSearchRequests: 0,
});
