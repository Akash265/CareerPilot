# Phase 6 — ATS Resume Optimization: Design

Date: 2026-09-23
Status: design approved by user; not yet implemented.
Spec reference: project specification §10 (Application Generation — New Model), §10.1 (ATS Keyword Injection & Semantic Weighting), §10.2 (Machine Readability / ATS Confidence), §11 (Structured Outputs & Hallucination Guardrails), §19 (job_requirements, resume_optimizations, ats_evaluations tables), roadmap Phase 6
Related decisions: D2 (RLS), D6 (never invent/estimate; deterministic where possible), D7/D8 (task-to-tier model selection, deterministic before AI), D14 (app-enforced polymorphic reference, no cross-table FK where Postgres can't express it — precedent for `job_requirements`/`resume_optimizations` shape), D20 (per-request random delimiter defense against prompt injection from untrusted text), D46/D49 (job_requirements deliberately deferred out of Phase 5 to this phase), D57 (distinguish transient `Anthropic.APIError` from a malformed-output validation error)

## 1. Scope

**In scope**
- LLM-based extraction of structured job requirements (`job_requirements`: required vs. preferred terms, with evidence quotes) from `jobs.descriptionText`, cached by `descriptionHash`.
- An evidence-bound resume optimizer: given a job's requirements and the candidate's existing structured profile facts (work experience bullets, achievements, projects, certifications, education, skills), selects/reorders/rewords bullets and reports added terms and any claim it could not ground in evidence — never inventing a bullet, employer, number, or skill.
- A deterministic guard that independently verifies every optimizer-proposed change actually cites a real, existing profile fact before it can be treated as "applied" — the actual hallucination backstop, not merely the model's self-report.
- A deterministic + embedding-based ATS/machine-readability scorecard (`ats_evaluations`): keyword coverage, required-skill coverage, semantic similarity, factual consistency, action-verb quality, machine readability, overall score.
- Manual, versioned regeneration (`resume_optimizations.version`) — no automatic retry loop.
- API + UI: an "Optimize Resume" action and result view on the existing job match detail page (`/matches/[jobId]`), including version history and a mandatory review banner for any unsupported/rejected claim.

**Out of scope (later phases, deliberate)**
- Resume document export (PDF/DOCX) and any templating/rendering pipeline — Phase 7 ("document storage").
- The three-bullet Hiring Manager Pitch and company research — Phase 7.
- Wiring `job_requirements` back into Phase 5's `scoreSkills` matching factor — a deliberate future decision with its own design discussion, not a side effect of this phase. Matching continues to read `jobs.descriptionText` directly, unchanged.
- An automatic multi-retry generation loop or a second, independent LLM entailment-check call — the deterministic guard plus the optimizer's own self-report is the chosen mechanism; regeneration is user-triggered only.
- A new background worker/queue service — this phase's LLM work is 1-2 bounded calls per user action, run synchronously in a Next.js API route, same pattern as `extractCareerGoal`/`extractProfile`.
- Version history for `job_requirements` itself — re-extraction (on a description-hash change) replaces the prior rows outright; only `resume_optimizations` is a versioned audit trail.
- "Already applied" as a constraint on optimization — no `applications` table until Phase 9.

## 2. Decisions taken in brainstorming

| # | Decision | Alternative rejected |
|---|---|---|
| 1 | Phase 6 ends at structured, reviewable data (optimized bullets + ATS scorecard) shown in the UI | Also generate a downloadable PDF/DOCX file this phase |
| 2 | `job_requirements` feeds only the resume optimizer; Phase 5's `scoreSkills` is left untouched | Also update matching to use structured requirement coverage |
| 3 | Iteration is manual "Regenerate," producing a new versioned `resume_optimizations` row | An automatic re-prompt loop that retries until a score threshold is met |
| 4 | Factuality is enforced by one optimizer LLM call (with self-reported `unsupportedClaimsDetected`) plus a deterministic guard that verifies every cited `sourceFactId` against the actual evidence catalog | A second, independent LLM entailment-check call re-verifying each claim |
| 5 | The ATS scorecard is computed deterministically (term matching, cosine similarity on existing embeddings, rule-based heuristics) with zero additional LLM calls | A dedicated LLM evaluator call that judges the resume qualitatively |
| 6 | Runs synchronously in a Next.js API route, no new service | A new background worker + queue (`services/resume-optimization-worker`) |

Each becomes a DECISIONS.md entry (D58 onward) when implemented.

## 3. Data model

All three tables are RLS-scoped (`user_id` defaulting to `current_setting('app.current_user_id')::uuid`, same as every existing table).

### `job_requirements`

One row per extracted term (not a JSON blob), so coverage math is a simple count.

```
id                             uuid pk
userId                         uuid
jobId                          uuid, FK jobs(id) cascade
termText                       text
termType                       enum: skill | tool | certification | other
requirementLevel               enum: required | preferred
evidenceQuote                  text, nullable  -- verbatim snippet from descriptionText
extractionModel                text
extractionSourceDescriptionHash text          -- cache key = jobs.descriptionHash
createdAt                      timestamptz
```

Re-extraction (triggered when `jobs.descriptionHash` no longer matches `extractionSourceDescriptionHash`) deletes and replaces all rows for that job — this table is a cache of the current description, not a history.

### `resume_optimizations`

One row per generation attempt; never overwritten.

```
id                        uuid pk
userId                    uuid
jobId                     uuid, FK jobs(id) cascade
careerGoalId              uuid, FK career_goals(id)  -- audit: which goal was active
version                   integer                    -- 1, 2, 3... per (userId, jobId)
sourceProfileContentHash  text   -- hash of the evidence catalog used; recorded for a future staleness
                                 -- check (like jobMatches.explanationDescriptionHash) but not read or
                                 -- enforced by anything in Phase 6 itself
selectedBullets           jsonb  -- [{ sourceFactId, originalText, optimizedText,
                                 --    changeType: "unchanged"|"reordered"|"reworded", justification }]
addedTerms                text[]
unsupportedClaimsDetected text[] -- optimizer's own self-report
requiresReview            boolean
rejectedClaims            jsonb  -- [{ sourceFactId, reason }] -- guard-rejected, never "applied"
generationModel           text
createdAt                 timestamptz
```

### `ats_evaluations`

One row per `resume_optimizations` row (1:1 — a fresh score always accompanies a fresh optimization).

```
id                        uuid pk
userId                    uuid
resumeOptimizationId      uuid, FK resume_optimizations(id) cascade
requiredKeywordCoverage   numeric
preferredKeywordCoverage  numeric
semanticSimilarity        numeric  -- cosine, job.embedding vs. optimized-bullet embeddings
factualConsistency        numeric  -- accepted / (accepted + rejected) from the guard
actionVerbScore           numeric
machineReadabilityScore   numeric
overallScore              numeric
evaluatorVersion          text     -- versions the scoring formula, like matching's factor weights
createdAt                 timestamptz
```

## 4. Pipeline

New package `packages/resume-optimization` (pure logic, no BullMQ — mirrors `packages/matching`'s shape and dependency list: `@ai-career/ai`, `@ai-career/config`, `@ai-career/db`, `@anthropic-ai/sdk`, `drizzle-orm`, `zod`).

```
packages/resume-optimization/src/
├── requirements/
│   ├── extractJobRequirements.ts   -- Anthropic tool-use call over jobs.descriptionText
│   └── ensureJobRequirements.ts    -- cache by descriptionHash; skip the LLM call if unchanged
├── optimization/
│   ├── buildResumeSnapshot.ts      -- deterministic: builds the {sourceFactId -> text} evidence
│   │                                  catalog from work_experience_bullets/achievements/projects/
│   │                                  certifications/education/skills; hashes it
│   ├── optimizeResume.ts           -- Anthropic tool-use call, Zod-validated output
│   └── applyDeterministicGuard.ts  -- pure function; verifies every cited sourceFactId exists in
│                                      THIS call's catalog; moves failures to rejectedClaims
├── evaluation/
│   ├── scoreKeywordCoverage.ts
│   ├── scoreSemanticSimilarity.ts
│   ├── scoreFactualConsistency.ts
│   ├── scoreActionVerbsAndReadability.ts
│   └── computeOverallScore.ts
└── pipeline/
    └── runResumeOptimization.ts    -- orchestrates: ensureJobRequirements -> buildResumeSnapshot ->
                                       optimizeResume -> applyDeterministicGuard -> persist
                                       resume_optimizations -> evaluate -> persist ats_evaluations ->
                                       return both
```

`runResumeOptimization(userId, jobId, careerGoalId)` is the single function the API route calls, run to completion within the request (no queue, no polling).

## 5. Deterministic guard (hard requirement, CLAUDE.md §6/§9, spec §11)

The optimizer's own `unsupportedClaimsDetected`/`requiresReview` output is a self-report, not a safety mechanism on its own. The guard is the actual enforcement point: for every entry in `selectedBullets`, it checks whether `sourceFactId` is a key in the evidence catalog that was actually passed to that specific `optimizeResume` call (not merely "exists somewhere in the DB" — it must be traceable to this exact request's inputs). Any entry that fails is moved to `rejectedClaims` and excluded from what the UI presents as "applied" content. This closes the gap where a model invents a plausible-looking id. Both the self-report and the guard's rejections are surfaced to the user; a `requiresReview = true` optimization is never silently treated as clean.

## 6. Requirement extraction and resume optimization (LLM, fast tier)

Both calls follow the established `extractCareerGoal`/`extractProfile` shape: Anthropic tool-use with a JSON-schema `input_schema`, Zod validation of the parsed result, a typed `*ValidationError` thrown on malformed output, `Anthropic.APIError` caught and surfaced distinctly (D57's lesson).

`extractJobRequirements` treats `jobs.descriptionText` as untrusted external content — same per-request random-delimiter defense as `extractCareerGoal.ts` (D20), since a job description can itself contain injected instruction-like text (CLAUDE.md §9: "protect against prompt injection from job descriptions").

`optimizeResume`'s prompt is explicit that it may only select, reorder, or reword bullets already present in the supplied evidence catalog, must cite a `sourceFactId` for every change, and must never introduce a skill, employer, number, or claim not present in the catalog. This is the prompt-level instruction the deterministic guard then verifies rather than trusts.

## 7. ATS evaluation (deterministic + embeddings, no additional LLM call)

- **Keyword/required-skill coverage** — case-insensitive term presence of each `job_requirements` entry in the optimized bullet text, split by `requirementLevel`.
- **Semantic similarity** — cosine similarity between `jobs.embedding` and an embedding over the optimized resume text, reusing existing `profile_facts` embeddings for unchanged bullets and only re-embedding genuinely reworded text (minimizing new Voyage calls).
- **Factual consistency** — `accepted / (accepted + rejected)` from the deterministic guard's own tally; not a separate judgment call.
- **Action-verb quality / machine readability** — rule-based heuristics: a curated action-verb list checked against each bullet's opening word, bullet-length bounds, section presence.
- **Overall score** — a weighted combination of the above, behind an `EVALUATOR_VERSION` constant so the formula can change later without losing the ability to compare old scores (same idea as matching's versioned factor weights).

The UI must state plainly, per spec §10.2, that this score is an internal signal, never a guarantee of passing a real external ATS.

## 8. API and UI

**API** (`apps/web/src/app/api/resume-optimizations/`), following `api/matches`'s conventions exactly (`withUserContext`, `env.DEFAULT_USER_ID`, `readJsonBody`/`formatValidationError`):

- `POST /api/resume-optimizations/[jobId]/run` — runs the pipeline, creates a new version, returns `{ optimization, evaluation }`. Serves both first-time "Optimize" and later "Regenerate." `careerGoalId` is resolved server-side from the user's currently active confirmed career goal (same lookup the matching run uses), never taken from the request body. Returns 404 if no `job_matches` row exists for this job (the user hasn't run "Find Matches" yet) and 400 if that row exists but `eligible = false`.
- `GET /api/resume-optimizations/[jobId]` — all versions for the job, newest first, each with its nested evaluation.

**UI** — extends `apps/web/src/app/matches/[jobId]/MatchDetailClient.tsx` (no new top-level page this phase):

- "Optimize Resume" action, shown only when the match is eligible.
- Result view: per-bullet diff (original vs. optimized, change-type badge, justification), added-terms list, a prominent review banner for any `unsupportedClaimsDetected`/`rejectedClaims`, the ATS scorecard with its internal-signal disclaimer, and version history with "Regenerate."
- New `apps/web/src/lib/resumeOptimization/` (`serializeOptimization.ts`, `listOptimizations.ts`), mirroring `lib/matching/`.

## 9. Testing, eval, process

**Unit** (`packages/resume-optimization/src/**/*.test.ts`): `applyDeterministicGuard` (valid citation accepted, fabricated/missing id rejected, empty catalog); `buildResumeSnapshot` (catalog shape, hash stability); each `evaluation/*` scorer against fixtures (mirrors `packages/matching/src/scoring/*.test.ts`); `extractJobRequirements`/`optimizeResume` against fake-Anthropic good/malformed/`APIError` responses; `ensureJobRequirements` cache hit/miss.

**Integration** (`route.test.ts`): 200 happy path, 400 ineligible job, 404 unknown job, 400 malformed body, validation-error surfacing — same shape as `api/matches/[jobId]/route.test.ts`.

**AI eval** (`packages/resume-optimization/eval/`, following the `packages/matching/eval/scoreExplanationEval.ts` precedent — domain-specific LLM calls are evaluated in their own package, not `packages/ai/eval`): a requirement-extraction accuracy dataset (job description -> expected required/preferred terms) and an optimization-quality dataset (fixture resume + job -> guard rejects zero legitimate claims, keyword coverage measurably improves). Evaluated for accuracy and consistency per CLAUDE.md §10.

**Process**: brainstorm (this doc) -> DECISIONS.md (D58+) -> writing-plans -> subagent-driven-development (worktree, per-task implementer/reviewer) -> a second, independent whole-branch review before merge (mandatory per the Phase 4/5 lesson: a fresh review has found real bugs task-level review structurally cannot, every time it's been tried) -> merge to main.

## 10. Assumptions to verify during planning

- The action-verb list and bullet-length/section heuristics for `scoreActionVerbsAndReadability` are unmeasured starting heuristics, same status as Phase 5's scoring weights and freshness half-life — expect to tune later, not to get right on the first pass.
- The overall-score weighting formula (how the six sub-scores combine) is a first guess behind `EVALUATOR_VERSION`, not a validated formula.
- Whether re-embedding only "genuinely reworded" bullets (vs. the whole optimized text) is worth the complexity, or whether always re-embedding the full text is simpler and cheap enough, should be confirmed against real Voyage latency/cost during implementation.
- Exact wording/placement of the "internal signal, not a guarantee" ATS disclaimer in the UI.
