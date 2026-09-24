# Architecture — AI Career Intelligence & Application Platform

Status: **Phases 0–6 and 7a are implemented** (foundation, candidate profile, career goal, job intelligence, hybrid matching, ATS resume optimization, company research + Hiring Manager Pitch); document export (7b) onward is designed but not yet built. This document describes the agreed architecture as of 2026-09-06. See `DECISIONS.md` for the rationale behind each choice. Update this file as implementation reveals deviations — it must describe what's actually built, not an aspiration.

## 1. Product framing

Single-user personal tool ([D1](../DECISIONS.md)). Not a job board, not multi-tenant SaaS. Core loop: candidate profile + natural-language career goal → job discovery/ranking → factual, evidence-bound application generation → human-approved submission → outcome tracking → improved future ranking.

## 2. System diagram

```
USER
 │
 ▼
NEXT.JS WEB APP (TypeScript, Tailwind, shadcn/ui)
 │
 ▼
API / DOMAIN SERVICES (business logic lives here — workers only execute)
 ├─ Candidate Profile          ├─ Resume Optimization
 ├─ Career Goal Parser         ├─ ATS Evaluation
 ├─ Job Intelligence           ├─ Application Tracker
 ├─ Matching Engine            └─ Browser Automation Control (Auto-Prep)
 │
 ▼
POSTGRESQL + pgvector + pg_trgm     (RLS-enabled, user_id-scoped — D2)
 ├─ structured data
 ├─ full-text / trigram lexical search
 └─ vector embeddings (profile_facts, jobs)
 │
 ▼
REDIS + BULLMQ
 ├─ job ingestion workers        ├─ evaluation workers
 ├─ resume generation workers    └─ browser automation (Auto-Prep) workers
 │
 ▼
MINIO (local) / R2 (optional cloud) — encrypted object storage
 │
 ▼
ANTHROPIC (generation) + VOYAGE AI (embeddings)   — D7
 │
 ▼
LANGFUSE — observability + cost/budget alerting   — D8
```

## 3. Data sourcing boundary ([D3](../DECISIONS.md))

Ingestion adapters are pluggable, one per source type:
- Official ATS/job-board APIs (Greenhouse, Lever, Ashby, …)
- RSS/XML career-page feeds
- User-uploaded files (CSV/JSON exports)
- Apify actors

Each source must be explicitly enabled via a consent checkbox ("I confirm I have reviewed the ToS of my data sources and am legally permitted to ingest them") before its adapter runs. `LEGAL.md` at repo root documents this boundary. No generic/open-ended HTML scraper exists in this system.

Implemented in Phase 4: Greenhouse and Lever board APIs and CSV/JSON upload (`packages/ingestion/src/adapters`). Ashby, RSS and Apify remain unbuilt; each is a new `SourceAdapter`. The consent gate is enforced in the API and again in the worker ([D37](../DECISIONS.md)).

## 4. Matching pipeline

```
Career Goal + Candidate Profile
        │
        ▼
Deterministic Eligibility Filter   (disallowed countries, hard experience mismatch,
        │                           dismissed, onsite-when-remote-required)
        ▼
Full-Text/Trigram Retrieval  +  pgvector Semantic Retrieval  (hybrid — neither alone is sufficient)
        │
        ▼
Weighted Hybrid Candidate Set
        │
        ▼
AI Match Reasoning   (fast/cheap model tier — explanation only, not filtering)
        │
        ▼
Final Personalized Ranking + Explanation
```

Ranking weights (initial, tunable, see spec §8): skills/requirements 30%, experience 15%, location/work mode 15%, sponsorship 10%, role preference 10%, salary 5%, industry/company 5%, freshness 5%, semantic fit 5%.

Salary and location values entering this pipeline are always deterministically parsed ([D6](../DECISIONS.md)) — the LLM never extracts or estimates numeric salary data.

Implemented in Phase 5: eligibility (`packages/matching/src/eligibility`), hybrid retrieval (`packages/matching/src/retrieval/fetchCandidateJobs.ts` -- lexical keyword hit-rate computed in TS, semantic similarity via pgvector `<=>`), the nine weighted factors (`packages/matching/src/scoring`), and AI match reasoning bounded to the top `MATCHING_EXPLAIN_TOP_N` jobs per run (`packages/matching/src/explanation`). No structured `job_requirements` table feeds skill matching -- skill matching still reads `jobs.descriptionText` directly (D49); Phase 6 added `job_requirements` (`packages/resume-optimization`) but deliberately scoped it to the resume optimizer only, not to `scoreSkills` (design doc decision 2; D49's own "Phase 6 adds job_requirements as new data, not a replacement" anticipated exactly this boundary). See D49–D55, D58–D67.

## 5. Application generation & hallucination guardrail ([D5](../DECISIONS.md))

```
profile_facts (one row per resume bullet/fact, each with its own embedding)
        │
        ▼
Resume Optimizer proposes: { new_text, source_fact, source_embedding_id }
        │
        ▼
Stage 1 — cosine_similarity(new_text, source_fact) > 0.85 ?  ──No──▶ reject
        │ Yes
        ▼
Stage 2 — NLI entailment check (fast model):
          { entailment: ENTAIL | CONTRADICT | NEUTRAL, contradicting_span }
        │
   CONTRADICT ──▶ reject
        │ ENTAIL or NEUTRAL
        ▼
Accepted change (NEUTRAL results are flagged requires_review: true)
```

Output structured per spec §11 (`modified_bullet_points`, `added_terms`, `justifications`, `unsupported_claims_detected`, `requires_review`), validated with Zod.

ATS/Machine Readability evaluation runs after optimization, scoring keyword coverage, required-skill coverage, semantic similarity, action-verb quality, format readability, experience alignment, factual consistency — reported transparently as an internal signal, never claimed as a guarantee of real-world ATS behavior (spec §10.2).

## 6. Application automation — "Auto-Prep", not autofill ([D4](../DECISIONS.md))

```
Prepare → Generate Resume + Pitch → Build structured application payload
   (candidate fields mapped to Workday/Lever/Greenhouse schema)
        ↓
Open Application Portal
        ↓
Per-ATS adapter (versioned plugin) attempts field mapping + runs selector health-check
        ↓
   Healthy? ──No──▶ fall back to manual mode, flag for user, log which fields are unmapped
        │ Yes
        ▼
Assisted paste (clipboard / extension helper) — never a silent auto-submit
        ↓
USER REVIEWS AND CLICKS FINAL SUBMIT MANUALLY
```

The "stop before submit" invariant (spec §4, §13) is structural here — a human performs the paste and the click — not merely a pause step inside a DOM automation script.

## 7. AI/model layer ([D7](../DECISIONS.md), [D8](../DECISIONS.md))

Task-to-tier mapping (model **version resolved by role via env var, not hardcoded**):

| Task | Approach | Tier |
|---|---|---|
| Eligibility filtering | Deterministic code | none |
| Matching / ranking | Voyage embeddings + pgvector | cached permanently |
| Match explanation | Anthropic, fast/cheap tier | on ranking |
| Resume optimization + entailment check | Anthropic, deep-reasoning tier | on-demand (shortlist action) |
| Company research | Anthropic research tier (`ANTHROPIC_MODEL_RESEARCH`) + server-side web search; only API-cited text kept | on-demand, cached per company, manual refresh |
| Hiring Manager Pitch | Anthropic, fast/cheap tier + deterministic citation guard | on-demand (user action on a match) |

Caching: embedding cache (permanent, content-hash keyed), match-reason cache (7-day TTL, job+resume-version keyed), optimized resume/pitch (generated once, lazily, only when the user acts). Monthly spend ceiling enforced via Langfuse alerting.

`EMBEDDING_PROVIDER` env var: `voyage` (default) or a self-hosted BGE/E5 endpoint for fully offline operation.

## 8. Data model additions beyond spec §19

- `profile_facts` — sentence/bullet-level candidate facts, each with its own embedding. Required by the entailment guardrail ([D5](../DECISIONS.md)); not present in the original spec, which only implied resume-level embedding.
- All tables carry `user_id UUID` with RLS policies ([D2](../DECISIONS.md)), defaulting to a fixed local UUID via `DEFAULT_USER_ID`.
- `automation_sessions` stores the generated payload and per-field mapped/unmapped state rather than raw DOM-automation logs ([D4](../DECISIONS.md)).
- `career_goals` / `career_goal_constraints` (implemented in Phase 3) deviate from spec §19's one-line description: a goal is versioned and never edited in place (`version`, `is_active`, [D23](../DECISIONS.md)), a row is created when the goal is parsed with its own `parse_status`/`parse_error` ([D24](../DECISIONS.md)), and the constraints row holds 21 structured fields including the minimum salary as `salary_floor_raw` / `salary_floor_normalized` / `salary_currency` / `salary_is_parsed` and the preferred salary as the parallel `salary_target_*` columns ([D22](../DECISIONS.md), [D25](../DECISIONS.md), [D28](../DECISIONS.md)).
- `career_goal_constraints` is the single source of truth for search-relevant preferences. `candidate_profiles` therefore keeps only contact fields, `years_of_experience` and `work_authorization_notes`; its earlier work-mode, salary-expectation, visa, preferred-role and industry columns and the `company_preferences` table were dropped ([D21](../DECISIONS.md)).
- `job_sources`, `ingestion_runs`, `raw_job_postings`, `jobs`, `job_postings`, `job_duplicate_candidates` (Phase 4, [D35](../DECISIONS.md)/[D36](../DECISIONS.md)). `jobs` is derived from its postings by a pure merge; salary uses the D6 raw + normalized + currency + period + `is_parsed` shape (implemented as `salary_raw`, `salary_min`, `salary_max`, `salary_currency`, `salary_period`, `salary_is_parsed`, with the min/max annualized).

Everything else (job_requirements, resume_optimizations, ats_evaluations, application_outcomes, learning_features, plus the original core tables) follows spec §19 as written. `application_pitches` deviates from spec §19's one-line description; see §14 and [D71](../DECISIONS.md).

## 9. Security & privacy

- Uploaded files: scanned/stripped of macros and EXIF, renamed with UUID, stored encrypted (MinIO local / R2 optional).
- Log scrubbing: exact-match substring redaction of known profile values ([D9](../DECISIONS.md)) — no NER/generic-regex PII detection.
- Retention: resume text and generated documents auto-deleted 30 days after an application reaches a terminal status (Rejected/Hired).
- Structured logging only; no resume/profile content in production logs regardless of scrubbing (defense in depth).

## 10. What's still open

- Confirm `EMBEDDING_PROVIDER=voyage` as the actual default vs. self-hosted BGE for the first implementation pass (leaning Voyage per [D7](../DECISIONS.md); revisit only if offline operation becomes a near-term requirement).
- Never measured or not yet built after Phase 4: the 0.8 trigram threshold for duplicate candidates has no labeled data; there is no duplicate-resolution or unmerge UI and no deletion of a source ([D36](../DECISIONS.md)); behavior at the volume of many real boards is unobserved; there is no Dockerfile or compose service for the ingestion worker ([D32](../DECISIONS.md)).

## 11. Job ingestion (Phase 4)

```
source (Greenhouse | Lever | upload)
  │  fetch        adapter.fetch(source) → { externalId, payload } records         (untrusted, size/time capped)
  ▼
raw_job_postings   latest payload + content_hash per (source, external id)
  │  normalize    pure rules: HTML → text, keys, salary, work mode, experience, sponsorship, posted date
  ▼
identify           tier 1 same (source, external id) · tier 2 same fingerprint · tier 3 trigram near-match → FLAG only
  ▼
job_postings       one row per source appearance, holding its normalized snapshot
  │  recompute    mergePostings(all postings of the job) → jobs row + field_provenance
  ▼
close              only after a complete, non-empty fetch of a non-upload source: unseen postings close;
                   a job closes when none of its postings is open
```

- **Process model ([D32](../DECISIONS.md)).** Adapters, normalization, identity and the database pipeline are in `packages/ingestion`. `services/job-ingestion` is a thin BullMQ process: it reconciles one repeatable scheduler per enabled, consented, non-upload source against the database every 60 seconds, and runs a concurrency-1 worker that calls `runIngestion`. The web app enqueues "Run now" and upload runs onto the same queue. Only infrastructure runs under `infra/docker-compose.yml`; the worker is started with `pnpm --filter @ai-career/job-ingestion start` (no Dockerfile or compose service exists).
- **Failure model.** Adapters and the pipeline throw only `IngestError`, which carries an error class and no content; transient classes retry with backoff, permanent ones do not. Runs and sources store the class ([D29](../DECISIONS.md), [D37](../DECISIONS.md)). A failed record is counted and skipped without aborting the run.
- **Consent gate ([D37](../DECISIONS.md), [D3](../DECISIONS.md)).** The source is created disabled and unconsented; enabling requires `consentConfirmed`; the run API refuses an unconsented or disabled source; `runIngestion` refuses it again. Uploads require a consent field.
- **Data quality.** Enrichment is deterministic with evidence or an explicit unknown ([D33](../DECISIONS.md), [D34](../DECISIONS.md)); missing values are `null`/`unknown`, never defaults. Hostile input is bounded ([D39](../DECISIONS.md)).
- **Reading.** `GET /api/jobs` and `GET /api/jobs/[id]` power the `/jobs` browser; `/sources` manages the watch-list. Ranking, eligibility filtering and embeddings are implemented in Phase 5 (`packages/matching`, `/matches`); see §4.

## 12. Hybrid matching (Phase 5)

```
career_goal_constraints (embedding, generated on confirm)  +  jobs (embedding, generated lazily on a matching run)
  │
  ▼
services/matching-worker  (BullMQ "matching" queue, concurrency 1, no scheduler -- manual trigger only)
  │  runMatching()
  ▼
deterministic eligibility  (excluded company/industry, remote-required vs. onsite/hybrid, experience gap beyond
                             a grace window, sponsorship required-but-not-offered, previously dismissed)
  │  ineligible -> job_matches row with a reason, nothing further
  ▼
nine weighted factor scores + computeOverallScore  (unknown data -> full/neutral credit or redistributed weight, never a guessed zero -- D52)
  │
  ▼
top MATCHING_EXPLAIN_TOP_N by score, whose explanation is stale or missing
  │  generateMatchExplanation()  (fast/cheap tier; only pre-computed scores/evidence in the prompt -- D53)
  ▼
job_matches  (read by GET /api/matches, GET /api/matches/[jobId]; PATCH sets user_action)
```

- **Process model.** Mirrors D32: domain logic in `packages/matching`, `services/matching-worker` is BullMQ glue only. No compose service or Dockerfile (same as `job-ingestion`); started with `pnpm --filter @ai-career/matching-worker start`.
- **Cost control.** Embeddings are permanent, content-hash-keyed caches (`jobs.embedding_content_hash`, mirrors `profile_facts`). Explanations are capped per run and invalidated only on real change, not a blind re-run (D54).
- **Known gaps carried into Phase 6+.** No structured `industry` field, so industry preference/exclusion is a company-name-substring heuristic (weak signal, never a hard block on a non-match). "Already applied" is not an eligibility rule (no applications table until Phase 9). No auto-trigger on goal confirm or ingestion completion -- "Find Matches" is manual. `MATCHING_EXPLAIN_TOP_N`, `MATCHING_EXPERIENCE_GRACE_YEARS`, `MATCHING_FRESHNESS_HALF_LIFE_HOURS` are unmeasured starting defaults.

## 13. ATS Resume Optimization (Phase 6)

```
job_matches (must be eligible) + an active, confirmed career goal
  │
  ▼
ensureJobRequirements  -- cached per (job, jobs.description_hash); a stale/missing cache re-runs
                           extractJobRequirements (Anthropic) and replaces job_requirements for the job
  │
  ▼
buildResumeSnapshot  -- an evidence catalog assembled directly from work_experiences/bullets,
                         achievements, projects, certifications, education and skills
  │
  ▼
optimizeResume  (Anthropic tool-use)  -- proposes selected/reworded bullets citing catalog entries
  │
  ▼
applyDeterministicGuard  -- the sole authority on hallucination: every cited source fact is checked
                             against the catalog built above; anything unverifiable is dropped into
                             rejectedClaims, never stored as an applied bullet
  │
  ▼
evaluation/*  (keyword coverage, semantic similarity, factual consistency from the guard's own tally,
               action-verb/readability heuristics) -> computeOverallScore
  │
  ▼
one transaction: resume_optimizations (versioned, never overwritten) + ats_evaluations (1:1)
```

- **Package boundary.** All of the above lives in `packages/resume-optimization` (`requirements/`, `optimization/`, `evaluation/`, `pipeline/`), consumed by `apps/web`'s `POST /api/resume-optimizations/[jobId]/run` and `GET /api/resume-optimizations/[jobId]` routes and the `ResumeOptimizationPanel` on the job match detail page.
- **Deterministic guard boundary.** `optimizeResume`'s prompt is instruction, not enforcement (D61); `applyDeterministicGuard` is the only code path allowed to mark a bullet as applied, and it is re-checked against the evidence catalog independently of anything the model claims about itself (D63) -- the model's own `unsupportedClaimsDetected` self-report is never trusted in place of it.
- **Three new tables.** `job_requirements` (a per-term cache keyed by description hash, replaced wholesale on re-extraction -- D58), `resume_optimizations` (versioned per job, one row per "Optimize"/"Regenerate" -- D59), `ats_evaluations` (1:1 with an optimization, written in the same transaction -- D59/D66).
- **Execution model.** Runs synchronously inside the API route -- no new BullMQ worker, unlike ingestion (D32) or matching (D50). It is a single user-triggered action on one job (not a batch job over many jobs), so there is nothing to hold a worker queue open for; extraction/optimization failures propagate to the route rather than being swallowed (D66).
- Full rationale, alternatives considered, and the complete decision set: `docs/superpowers/specs/2026-09-23-phase-6-ats-resume-optimization-design.md` and DECISIONS.md D58–D67.

## 14. Company Research & Hiring Manager Pitch (Phase 7a)

```
eligible job_matches row + non-empty evidence catalog (profile)
  │
  ▼
ensureCompanyResearch  -- cached per (user, jobs.company_key); failed attempts retried, refresh is manual
  │   runCompanyResearch: research tier + web_search_20250305 (D79); input = company name, job title, posting URL only
  │   extractCitedFacts: a web fact exists only if the API attached a web_search_result_location citation
  │   deriveInternalFacts: deterministic facts from this company's jobs rows
  ▼
ensureJobRequirements (Phase 6) + buildResumeSnapshot (Phase 6) -> buildEvidenceIndex (r:/q:/p: ids)
  │
  ▼
generatePitch (fast tier, forced tool call) -> applyPitchGuard (each bullet must cite its own kind)
  │
  ▼
application_pitches (versioned; generated or user_edited; evidence snapshotted per bullet)
```

- **Package boundary.** `packages/application-package` (`research/`, `pitch/`, `pipeline/`), consumed by `apps/web`'s four `/api/application-pitches/[jobId]` routes and `PitchPanel`. No BullMQ; `hasUnsafeText` comes through the `@ai-career/ingestion/text` subpath.
- **Privacy boundary.** The research call never receives profile, resume, goal or requirement data (D73).
- **Grounding.** Web facts are grounded by API citations (D72); pitch bullets by `applyPitchGuard` (D75). Unsupported bullets are shown, flagged, never dropped.
- **Three new tables.** `company_research`, `company_research_facts`, `application_pitches` (D71).
- **Execution model.** Synchronous API routes, like Phase 6. Research uses the basic `web_search_20250305` tool (D79); the first pitch for a company waits for web research, typically ~16-22s, not the ~a minute originally estimated with the newer tool.
- **Known gaps.** No research history; `company_key` collisions share research; no domain allow/block list for search; no export (7b), interview prep or cover letter (7c). Cached internal facts ("Company has N roles…") reflect jobs at research time until Refresh; a company whose search hits `max_uses` with nothing cited is stored as `failed` and re-searched on every pitch request (a cost follow-up, not fixed here); the internal-facts query caps at 50 jobs.
- Full rationale: `docs/superpowers/specs/2026-09-24-phase-7a-company-research-pitch-design.md` and DECISIONS.md D69–D79.
