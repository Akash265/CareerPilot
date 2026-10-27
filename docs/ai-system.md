# AI System

How CarrierPilot uses LLMs and embeddings, as built. Design rationale lives in [DECISIONS.md](../DECISIONS.md); the per-feature pipelines are in [architecture.md](architecture.md) §4–§7 and §11–§21.

## Principles

- **Deterministic first.** Eligibility filtering, salary/experience/sponsorship parsing, scoring, ranking, de-duplication, ATS keyword coverage and the citation guards are plain code. An LLM is used only for extraction from free text, explanation and grounded generation ([D7](../DECISIONS.md)).
- **Structured output only.** Every extraction and generation call forces one tool (`tool_choice`) whose input is the result; the result is validated with Zod and a schema failure is a typed `…ValidationError`, never a partial result. (Company research is the exception: it uses the server-side web-search tool and keeps only cited text.)
- **Grounded generation.** Generated text must cite facts that exist: the resume optimizer's output passes `applyDeterministicGuard` ([D61](../DECISIONS.md), [D63](../DECISIONS.md)); pitches, cover letters and interview prep pass `checkCitations` against the exact catalog they were given; company research keeps only text the web-search API itself cited.
- **Untrusted input is data.** Wherever raw text reaches a prompt (resume text, the goal statement, job descriptions, research and profile evidence) it is wrapped in tags with a random per-request name and an instruction that their content is data, never instructions ([D20](../DECISIONS.md), CLAUDE.md §9). The match explanation gets no raw text at all, only the already-computed structured factors. The browser autofill never lets an LLM decide what to type or click ([D127](../DECISIONS.md)).
- **Every call is tracked and budgeted.** All calls go through `trackAiCall`: one content-free `ai_calls` row (operation, model, tokens, estimated cost, outcome), a monthly ceiling checked before the call (`AI_MONTHLY_BUDGET_USD`, 429 `ai_budget_exceeded` when reached), and optional metadata-only Langfuse export (§21, [D154](../DECISIONS.md)–[D164](../DECISIONS.md)).
- **Models by role, not version.** `ANTHROPIC_MODEL_FAST` and `ANTHROPIC_MODEL_RESEARCH` name the models; code never hard-codes a model id ([D7](../DECISIONS.md)).

## Operations

Each row is one `operation` label as recorded in `ai_calls` and shown on `/usage`.

| Operation | Model / provider | Tool | Code | Trigger | Output checks |
|---|---|---|---|---|---|
| `resume_extraction` | `ANTHROPIC_MODEL_FAST` | `record_resume_extraction` | `packages/ai/src/extractProfile.ts` | `POST /api/profile/resume` | Zod; the user reviews every field before it is saved |
| `career_goal_parse` | `ANTHROPIC_MODEL_FAST` | `record_career_goal_extraction` | `packages/ai/src/extractCareerGoal.ts` | `POST /api/career-goal/parse` | Zod; strict salary parser; the user reviews and corrects before confirming ([D25](../DECISIONS.md)) |
| `match_explanation` | `ANTHROPIC_MODEL_FAST` | `record_match_explanation` | `packages/matching/src/explanation/generateMatchExplanation.ts` | matching worker, top `MATCHING_EXPLAIN_TOP_N` eligible jobs | Zod; cached `MATCHING_EXPLANATION_TTL_DAYS`; the score itself is deterministic |
| `job_requirements_extraction` | `ANTHROPIC_MODEL_FAST` | `record_job_requirements` | `packages/resume-optimization/src/requirements/extractJobRequirements.ts` | first resume optimization for a job | Zod; cached per job |
| `resume_optimization` | `ANTHROPIC_MODEL_FAST` | `record_resume_optimization` | `packages/resume-optimization/src/optimization/optimizeResume.ts` | `POST /api/resume-optimizations/[jobId]/run` | Zod + `applyDeterministicGuard` (every change must cite a real profile fact) + ATS evaluation |
| `company_research` | `ANTHROPIC_MODEL_RESEARCH` + web search | — | `packages/application-package/src/research/runCompanyResearch.ts` | pitch / cover letter / interview prep, or research refresh | only API-cited text is kept; cached per company |
| `pitch_generation` | `ANTHROPIC_MODEL_FAST` | `record_pitch` | `packages/application-package/src/pitch/generatePitch.ts` | `POST /api/application-pitches/[jobId]/run` | Zod + `checkCitations` |
| `cover_letter_generation` | `ANTHROPIC_MODEL_FAST` | `record_cover_letter` | `packages/application-package/src/coverLetter/generateCoverLetter.ts` | `POST /api/cover-letters/[jobId]/run` | Zod + `checkCitations` |
| `interview_prep_generation` | `ANTHROPIC_MODEL_RESEARCH` | `record_interview_prep` | `packages/application-package/src/interviewPrep/generateInterviewPrep.ts` | `POST /api/interview-preps/[jobId]/run` | Zod + `checkCitations` |
| `profile_fact_embedding` | Voyage (`VOYAGE_EMBEDDING_MODEL`) | — | `apps/web/src/lib/profile/saveProfile.ts` | profile confirm / edit | content-hash cached; a failure leaves the embedding null and is retried next save |
| `goal_embedding` | Voyage | — | `packages/matching/src/embeddings/ensureGoalEmbedding.ts` | goal confirm, or lazily at matching | failure degrades to keyword-only scoring ([D55](../DECISIONS.md)) |
| `job_embedding` | Voyage | — | `packages/matching/src/embeddings/ensureJobEmbeddings.ts` | matching run, new jobs only | content-hash cached |
| `resume_similarity_embedding` | Voyage | — | `packages/resume-optimization/src/pipeline/runResumeOptimization.ts` | resume optimization | feeds the ATS semantic-similarity signal |

Embeddings are called through `embedTexts` (`packages/ai/src/embeddings.ts`): up to 3 attempts on network errors, 429 and 5xx, honouring `retry-after`. `VOYAGE_API_BASE` overrides the endpoint (the E2E suite points it at a local stand-in, [D183](../DECISIONS.md)).

## Skill verification (Phase 13b)

No new prompt or operation. The user can confirm a missing required skill ("I have it" with an evidence sentence, "same as" a profile skill, or "I don't have it"); a confirmed skill enters the evidence catalog as a `verified_skill` entry, so every existing citation guard accepts it without change. One sentence was added to the resume optimizer's prompt saying such entries are the candidate's own confirmation. Requirements extraction (`job_requirements_extraction`, cached by description hash) now also runs after each matching run for the top `SKILL_GAP_TOP_N` matches, so it appears on `/usage` earlier than before; a budget block stops that step and never fails matching. The evidence text is user-written and untrusted: it travels inside the catalog under the same tagged-data rule as other profile evidence, and is never logged. Alias suggestions are a fixed table, not a model call ([D199](../DECISIONS.md)-[D204](../DECISIONS.md)).

## Prompts

Prompts are code: each lives next to its call in the files above, beside the tool's JSON schema and the Zod schema that validates it, and changes go through review and the evals below. There is no separate prompt registry or version field; a prompt change is a commit.

## Evaluation

Two layers. The `*.test.ts` files under `eval/` run in `pnpm test` with a fake client that returns the recorded expected answer: they check the pipeline shape (schemas, mapping, guards) deterministically. The `eval:*` scripts call the real model (they cost money and need real keys in `.env`) and score accuracy or grounding; run them by hand when a prompt or a model setting changes.

| Package | Script (`pnpm --filter <package> <script>`) | Scores |
|---|---|---|
| `@ai-career/ai` | `eval:accuracy`, `eval:career-goal-accuracy` | resume extraction and career-goal parsing, field by field, against labelled fixtures |
| `@ai-career/ingestion` | `eval:extraction` (no AI; also `eval/extractionEval.test.ts` in `pnpm test`) | deterministic salary / experience / sponsorship / work-mode extraction |
| `@ai-career/matching` | `eval:explanation` | match explanations stay grounded in the computed factors |
| `@ai-career/resume-optimization` | `eval:requirements`, `eval:optimization` | requirement extraction; optimization quality and guard behaviour |
| `@ai-career/application-package` | `eval:pitch`, `eval:cover-letter`, `eval:interview-prep`, `eval:research` | citation grounding of each generated document; research smoke |

The E2E suite (`pnpm e2e`) runs the real pipelines against local stand-ins that return fixed tool answers, so it checks wiring end to end, not model quality.

## Failure handling

- A schema-invalid answer, a budget block, or a provider error is reported per operation (`ai_calls.outcome`, `/usage`), shown to the user as a short message, and never stored as a result.
- Worker jobs that fail store only a code in BullMQ (`contentFreeJobError`, [D180](../DECISIONS.md)); logs carry error class, code and frames, never messages ([D166](../DECISIONS.md)).
