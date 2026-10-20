# Architecture — AI Career Intelligence & Application Platform

Status: **Phases 0–10, 11a and 11b are implemented** (foundation, candidate profile, career goal, job intelligence, hybrid matching, ATS resume optimization, company research + Hiring Manager Pitch, document export, cover letter + interview preparation, application tracker, guarded browser autofill, outcome analytics, personal response model, AI usage tracking + monthly budget ceiling, structured logging + worker/queue status). This document describes the agreed architecture as of 2026-09-06. See `DECISIONS.md` for the rationale behind each choice. Update this file as implementation reveals deviations — it must describe what's actually built, not an aspiration.

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
 ├─ Matching Engine            └─ Browser Automation Control (guarded autofill)
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
 ├─ resume generation workers    └─ browser automation (guarded autofill) worker — host-run only, §18
 │
 ▼
MINIO (local) / R2 (optional cloud) — encrypted object storage
 │
 ▼
ANTHROPIC (generation) + VOYAGE AI (embeddings)   — D7
 │
 ▼
AI USAGE (ai_calls table, monthly budget gate) — D154/D155
 │
 ▼
LANGFUSE — optional, metadata-only OTLP export    — D160
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

## 6. Application automation — guarded autofill ([D127](../DECISIONS.md))

```
"Open & autofill application" (AutofillPanel, /matches/[jobId])
        ↓
createSession: resolve Greenhouse/Lever posting → build form URL (never scraped) → automation_sessions (queued)
        ↓
enqueue onto BullMQ "browser-automation" (concurrency 1) ──fails──▶ failed / enqueue_failed, 503
        ↓
services/browser-worker (host-run, headed Chrome — not containerized)
  launch throwaway profile → navigate (host-allowlisted) → snapshot the form (plain-JS extractor, D131)
        ↓
  classify every field (standard-field rules + shared label regexes, D129) → build a fill plan
        ↓
  health check: every required field matched exactly once? ──No──▶ needs_manual (nothing filled), window released
        │ Yes
        ▼
  guarded fill/select/check/attach (actions.ts, D130) — each action verified by reading the value back
        ↓
  awaiting_user: window handed to the person; worker only polls for close / timeout / cancel / confirmation text
        ↓
   confirmation text/URL seen? ──Yes──▶ submission_detected (window released, not closed)
        │ No (closed / timed out / cancelled)
        ▼
  abandoned
        ↓
USER REVIEWS AND CLICKS SUBMIT THEMSELVES — the worker has no click/press/submit code path at all (D130)
        ↓
"Record as applied?" (submission_detected or abandoned) → links the session's own attached resume/cover letter
```

The "stop before submit" invariant (spec §4, §13) is structural: no Playwright call in `services/browser-worker`
can click, press a key, or submit a form (enforced by a source-scanning test, D130) — not a pause step inside
a DOM automation script. See §18 for the as-built package/table/route inventory and DECISIONS.md D127–D136.

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

Caching: embedding cache (permanent, content-hash keyed), match-reason cache (7-day TTL, job+resume-version keyed), optimized resume/pitch (generated once, lazily, only when the user acts). Monthly spend ceiling: enforced in-app before every AI call from the local `ai_calls` table, not via Langfuse alerting as first planned (§21, [D154](../DECISIONS.md), [D155](../DECISIONS.md)).

`EMBEDDING_PROVIDER` env var: `voyage` (default) or a self-hosted BGE/E5 endpoint for fully offline operation.

## 8. Data model additions beyond spec §19

- `profile_facts` — sentence/bullet-level candidate facts, each with its own embedding. Required by the entailment guardrail ([D5](../DECISIONS.md)); not present in the original spec, which only implied resume-level embedding.
- All tables carry `user_id UUID` with RLS policies ([D2](../DECISIONS.md)), defaulting to a fixed local UUID via `DEFAULT_USER_ID`.
- `automation_sessions` (Phase 8) stores one row per guarded-autofill attempt: portal/adapter version, the built form URL, lifecycle status, a `field_audit` of per-field actions/reasons/value *sources* (never values), and optional links to the attached documents and the resulting application ([D127](../DECISIONS.md), [D136](../DECISIONS.md)); see §18.
- `career_goals` / `career_goal_constraints` (implemented in Phase 3) deviate from spec §19's one-line description: a goal is versioned and never edited in place (`version`, `is_active`, [D23](../DECISIONS.md)), a row is created when the goal is parsed with its own `parse_status`/`parse_error` ([D24](../DECISIONS.md)), and the constraints row holds 21 structured fields including the minimum salary as `salary_floor_raw` / `salary_floor_normalized` / `salary_currency` / `salary_is_parsed` and the preferred salary as the parallel `salary_target_*` columns ([D22](../DECISIONS.md), [D25](../DECISIONS.md), [D28](../DECISIONS.md)).
- `career_goal_constraints` is the single source of truth for search-relevant preferences. `candidate_profiles` therefore keeps only contact fields, `years_of_experience` and `work_authorization_notes`; its earlier work-mode, salary-expectation, visa, preferred-role and industry columns and the `company_preferences` table were dropped ([D21](../DECISIONS.md)).
- `job_sources`, `ingestion_runs`, `raw_job_postings`, `jobs`, `job_postings`, `job_duplicate_candidates` (Phase 4, [D35](../DECISIONS.md)/[D36](../DECISIONS.md)). `jobs` is derived from its postings by a pure merge; salary uses the D6 raw + normalized + currency + period + `is_parsed` shape (implemented as `salary_raw`, `salary_min`, `salary_max`, `salary_currency`, `salary_period`, `salary_is_parsed`, with the min/max annualized).

Everything else (job_requirements, resume_optimizations, ats_evaluations, plus the original core tables) follows spec §19 as written. `learning_features` was never built: Phase 10 computes outcomes on read instead ([D140](../DECISIONS.md)). `ai_calls` (Phase 11a) is not in spec §19: one append-only, content-free row per AI call; see §21 and [D159](../DECISIONS.md). `application_pitches` deviates from spec §19's one-line description; see §14 and [D71](../DECISIONS.md). `generated_documents` is not in spec §19 at all; see §15 and [D81](../DECISIONS.md). `applications` and `application_events` (Phase 9) deviate from spec §19 by having no `application_outcomes` table at all ([D117](../DECISIONS.md)) and a nullable `job_id` for external applications ([D113](../DECISIONS.md)); see §17.

## 9. Security & privacy

- Uploaded files: scanned/stripped of macros and EXIF, renamed with UUID, stored encrypted (MinIO local / R2 optional).
- Network access: localhost by default, Host/Origin checks and an optional access token; rate limits on costly routes (Phase 11c, §23).
- Log scrubbing: exact-match substring redaction of known profile values ([D9](../DECISIONS.md)) plus one email-address pattern — no NER or name regexes. Implemented in Phase 11b ([D168](../DECISIONS.md)); see §22.
- Retention: `RETENTION_DAYS` (default 30) after an application reaches a terminal status, the job-specific generated documents and tailored resume text for that job are deleted -- resume optimizations, pitches, cover letters, interview prep and their rendered files. The base resume/profile is never deleted by retention. Implemented in Phase 9; see §17.
- Structured logging only; no resume/profile content in production logs regardless of scrubbing (defense in depth). Since Phase 11b every process logs through `@ai-career/logging`, which never writes an error's message ([D166](../DECISIONS.md), [D167](../DECISIONS.md)).

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
- **Known gaps carried into Phase 6+.** No structured `industry` field, so industry preference/exclusion is a company-name-substring heuristic (weak signal, never a hard block on a non-match). "Already applied" was not an eligibility rule here (no applications table until Phase 9); Phase 9 added it ([D118](../DECISIONS.md), §17). No auto-trigger on goal confirm or ingestion completion -- "Find Matches" is manual. A job that closes after it was matched is re-scored as ineligible ("posting has closed") on the next run and leaves the eligible list immediately; until that run its row still reads eligible, so the generation pipelines would still accept it ([D139](../DECISIONS.md)). `MATCHING_EXPLAIN_TOP_N`, `MATCHING_EXPERIENCE_GRACE_YEARS`, `MATCHING_FRESHNESS_HALF_LIFE_HOURS` are unmeasured starting defaults.

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
- **Known gaps.** No research history; `company_key` collisions share research; no domain allow/block list for search. Cached internal facts ("Company has N roles…") reflect jobs at research time until Refresh; a company whose search hits `max_uses` with nothing cited is stored as `failed` and re-searched on every pitch request (a cost follow-up, not fixed here); the internal-facts query caps at 50 jobs.
- Full rationale: `docs/superpowers/specs/2026-09-24-phase-7a-company-research-pitch-design.md` and DECISIONS.md D69–D79.

## 15. Document Export & Storage (Phase 7b)

```
profile rows + one resume_optimizations version   |   one application_pitches version
  │ buildResumeModel (pure, D82)                   │ buildPitchModel (pure)
  ▼                                                ▼
DocumentModel ──► storeDocument: hash → reuse | renderPdf (pdfkit + embedded Noto Sans) / renderDocx (docx)
                                 → MinIO "generated-documents" → generated_documents row (RLS)
```

- **Package boundary.** `packages/document-export` (`model/`, `render/`, `pipeline/`), used by `/api/documents` routes and the match page's download buttons and documents list. No LLM calls.
- **Guarantees.** Documents contain only stored profile text and guard-applied rewordings; education/certifications/skill names never reworded; no street address (D82). Export refused when the profile changed since the optimization or a generated pitch has an unsupported bullet (D84).
- **Machine readability.** Single column, real text, no images/tables; every renderer test extracts the text back with the same parsers used for uploads (D83).
- **Storage.** Generated keys, RLS-first download, attachment + nosniff + no-store headers (D85); identical exports de-duplicated by content hash, scoped per job so two jobs never share a stored file (D81, D84 update, migration `0021`).
- **Consistency.** `exportResume` reads the profile snapshot hash and the profile rows in one `REPEATABLE READ` transaction so a concurrent profile edit cannot pair an old hash with new rows (D84 update). `storeDocument` deletes its MinIO upload if the row insert fails for any reason other than the expected de-dup conflict, so a failed insert never orphans an object (D84).
- **Known gaps.** A job's MinIO objects are swept by Phase 9 retention (see §17), not by deleting the job itself; plain visual design; no templates. A resume row that de-duplicates by content keeps the filename from its first export -- a later company-name change in the job data does not rename it. If a stored object ever disappears without its row outside of Phase 9's own sweep (which always deletes rows before objects, D119), the row keeps being reused by hash-based reuse and download returns 502. The PDF's bullet glyph can be orphaned at a page break when the bullet text wraps to the next page (cosmetic). The embedded Noto Sans covers Latin/Greek/Cyrillic only -- CJK, Arabic and Hebrew names render as boxes in the PDF (pdfkit does no font fallback or bidi shaping); DOCX is unaffected, since it defers to the viewer's own fonts (D83 update).
- Rationale: `docs/superpowers/specs/2026-09-24-phase-7b-document-export-design.md`, DECISIONS.md D81–D87.

## 16. Cover Letter & Interview Preparation (Phase 7c)

```
eligible job_matches row + non-empty evidence catalog
  │
  ▼
prepareApplicationContext  -- shared with the pitch: gates → profile check → ensureCompanyResearch
  │                           → ensureJobRequirements → buildEvidenceIndex (r:/q:/p: ids)
  ├──────────────────────────────────────┐
  ▼ cover letter                         ▼ interview prep
computeGapTerms (all missing terms)      computeGapTerms (pure; ALL required terms missing from the profile)
generateCoverLetter (fast tier)          generateInterviewPrep (research tier; first 5 gap terms as fixed input)
  ▼                                      ▼
applyCoverLetterGuard                    applyInterviewPrepGuard (citation rules per section + gap rules
  + per-paragraph gap mentions             + framing claim check; likely questions vs ALL gap terms)
    (missingTermMentions) → review flag
  │        └── both call checkCitations (guard/checkCitations.ts), shared with applyPitchGuard
  ▼                                      ▼
hasUnsafeText → cover_letters            hasUnsafeText → interview_preparations
(versioned; generated | user_edited)     (versioned, read-only; gap_terms_snapshot)
```

- **Package boundary.** `packages/application-package` gains `guard/` (`checkCitations`), `coverLetter/`, `interviewPrep/` and `pipeline/{prepareApplicationContext,runCoverLetterGeneration,createEditedCoverLetter,runInterviewPrepGeneration,…}`; `runPitchGeneration` / `applyPitchGuard` now sit on the shared pieces (D89). Consumed by `apps/web`'s `/api/cover-letters/[jobId]` (GET, `run`, `edit`) and `/api/interview-preps/[jobId]` (GET, `run`) routes and the `CoverLetterPanel` / `InterviewPrepPanel` on the match page; research refresh stays on the pitch route (research is per company and shared).
- **Model tiers.** Cover letter on `ANTHROPIC_MODEL_FAST`; interview prep on `ANTHROPIC_MODEL_RESEARCH`. No new env var (D90, D91).
- **Strict tool use.** `generatePitch`, `generateCoverLetter` and `generateInterviewPrep` all pass `strict: true` on their tool definition, so the API validates `tool_use.input` against the schema before returning it (closes the intermittent non-conforming-output 502 that Zod alone caught after the fact); the three tool schemas state structure only (every object `additionalProperties: false` + full `required`; length/count keywords are unsupported under strict mode and removed, restated in a property's `description` only where the prompt text didn't already state that cap) and Zod remains the sole enforcer of lengths and counts. Each generator also rejects a `stop_reason: "max_tokens"` response before parsing it (D109).
- **Grounding.** Cover letter: opening cites a requirement, company paragraph a research fact, evidence paragraphs profile evidence, closing nothing; salutation and sign-off are added at export, never by the model (D90); a letter whose non-opening paragraph names a missing required term is marked for review, the paragraph staying supported (D101), and the paragraph records which terms it names so the review banner can say so instead of blaming the model (D106). Interview prep: likely questions cite profile evidence plus a requirement (technical/behavioral) or research-or-requirement (role, D97); gap questions must cite the missing term's own requirement and follow the gap rules (D92), and a framing that reads as claiming the missing skill is flagged by a sentence heuristic that ignores negated and conditional clauses and sees first-, second- and third-person claims (`findSkillClaim`, shared with the eval, D102, D105); likely questions that target any missing term are flagged (D96, D100); talking points cite research; questions to ask cite research or a requirement. Unsupported items are flagged, never dropped.
- **Gap terms.** Deterministic, not model-chosen: `required` skill/tool/certification job terms of at most four words (D104) not found in the profile evidence text by a boundary-aware match (D92, D95). All of them are stored with the pack and shown in the UI; only the first five are given to the model to write gap questions for (D100).
- **Interview prep count rules.** `likelyQuestions`, `talkingPoints` and `questionsToAsk` floor at 1 item each (`gapQuestions` stays 0..5); the prompt still asks for the planned ranges (5-8 / 3-6 / 3-5) and now adds "return fewer rather than inventing any" for when the evidence is too thin to reach them. An over-long array is not a schema failure: Zod keeps the first N items in order (likely 8, talking points 6, questions-to-ask 5, gap questions 5, an answer-outline 5 lines) via a `.transform` applied after the array's own minimum-length check (D110).
- **Two new tables.** `cover_letters` and `interview_preparations`, both RLS-scoped with advisory-locked versions (migrations `0022`, `0023`). `generated_documents` gains the `cover_letter` / `interview_prep` kinds and source columns; its source CHECK compares `kind::text` so a fresh DB migrates in one transaction (D93).
- **Export.** A generated cover letter with an unsupported paragraph is refused (409); an interview prep pack always exports with unsupported items marked "(unverified)", because it is for the candidate only (D93).
- **Execution model.** Synchronous API routes, like 7a — an interview prep call (research tier, large output) can take up to about a minute, a first-time company research adds its own ~16-22s.
- **Evals.** `eval:cover-letter` / `eval:interview-prep` (manual, real API). Latest (interview prep count rules, D110): interview prep: all 4 fixtures generated (up from 3/4 in D109), 55/57 items supported, 10/10 gap terms answered and supported, 2 likely questions flagged for targeting a gap term (fixture-4's known "Apache Spark" alias, D92), 0 framings flagged; the previously-failing thin-evidence fixture generated 3 honest likely questions instead of a 502. Earlier: pitch 9/9 bullets supported, 0 uncited numbers; cover letter 18/18 paragraphs supported over 4 fixtures, 1 paragraph naming a gap term, 0 uncited numbers (both unchanged by D110, not re-run). D94, D103, D107, D109.
- **Known gaps.** Gap detection has no alias/synonym handling ("Spark" does not cover "Apache Spark"; "Postgres" does not cover "PostgreSQL") (D92). Phrase-shaped and "other"-typed required terms ("Production data pipeline building experience") are excluded from gap detection rather than reported as false gaps, so such a requirement is never treated as a gap even when the profile lacks it (D104) — the real fix for both is upstream term extraction, not the matcher. `strict: true` (D109) makes the interview-prep call's tool_use.input structurally conform; a thin-evidence response that comes back below the schema's floor (1 item, D110) still legitimately fails Zod and 502s, but the floor is now low enough that this is expected to be rare. Gap detection can differ slightly from the ATS keyword-coverage list (boundary-aware vs substring); the likely-question gap check can false-positive on generic gap terms; the model is not told about missing terms beyond the fifth, so a likely question about one is flagged rather than avoided (D100). Calls are synchronous — no worker, no progress beyond a loading message. The guard checks citations, not semantic faithfulness: it cannot tell whether an answer outline says only what its cited facts say, and the framing claim check is a heuristic (paraphrased claims pass; a positive clause that later names the term is flagged; a conditional marker in the same clause hides a claim, D102, D105). No per-question notes, no mock interview, no editing of interview prep packs. The evidence block sent to the model is not length-capped (same as the pitch).
- Rationale: `docs/superpowers/specs/2026-09-29-phase-7c-interview-prep-cover-letter-design.md`, DECISIONS.md D89–D110.

## 17. Application Tracker (Phase 9)

```
"Mark as applied" (any match page)  |  "Add external application"
        │                                       │
        ▼                                       ▼
createApplication  -- loads job/match/ATS/documents, builds a one-time feature_snapshot,
                       inserts applications + an initial status_change event (one tx)
        │
        ▼
applications  (status on the row; terminal_at drives retention)  +  application_events  (append-only)
        │                              │
        ▼                              ▼
runMatching's eligibility        services/maintenance-worker  (daily BullMQ scheduler, + `pnpm retention:run`)
("already applied" excludes            │
 the job from the ranked feed)          ▼
                                  runRetentionSweep  -- rows first (per-application tx, FOR UPDATE SKIP LOCKED),
                                  MinIO objects after commit, then an orphan sweep (24h-guarded)
```

- **Package boundary.** `packages/applications` (no BullMQ, no LLM calls -- purely deterministic): `bodies.ts`
  (Zod request schemas), `status.ts` (`planStatusChange`), `snapshot.ts` (`buildFeatureSnapshot`),
  `documentLinks.ts` (`loadLinkedDocuments`, cross-job validation), `createApplication.ts`,
  `mutateApplication.ts` (`changeStatus`/`addEvent`/`updateApplication`/`deleteApplication`),
  `readApplications.ts` (`getApplication`/`listApplications`/`getApplicationForJob`/`listDocumentOptions`),
  `retention/{planRetention,runRetentionSweep}.ts`. Consumed by `apps/web`'s `/api/applications` routes (plus
  `/api/applications/for-job/[jobId]`) and the `ApplicationPanel` / `/applications` / `/applications/[id]` UI,
  and by `services/maintenance-worker`.
- **Two new tables.** `applications` (nullable `job_id`, `ON DELETE SET NULL`, for external applications --
  D113; a partial unique index on `(user_id, job_id) WHERE job_id IS NOT NULL` enforces one application per
  ingested job; `feature_snapshot jsonb` written once at creation, D116; `terminal_at` drives retention, D115)
  and `application_events` (append-only, `ON DELETE CASCADE` from `applications`, seven event types --
  migrations `0024_far_captain_universe.sql`, `0025_applications_rls.sql`). Both RLS-scoped like every other
  user table (D2). Since Phase 10a the snapshot is version 2 and also records ats.missedRequiredTerms (D143).
- **Lifecycle.** Permissive: any status may move to any other; every change is logged (D114). `terminal_at`
  is set to *now* on entering a terminal status, kept across a terminal→terminal move, and cleared on reopen
  (D115) -- this is the sole retention clock. No `application_outcomes` table; the outcome is the terminal
  status plus its event (D117, deviates from spec §19).
- **Matching integration.** `evaluateEligibility` gained a deterministic `alreadyApplied` check, run first;
  `runMatching` loads applied job ids once per run. An applied job's match page keeps its generation panels
  visible (`match.eligible || applicationId !== null`) so what was actually sent stays viewable after the job
  leaves the ranked feed; regenerating a document for it is refused by the existing eligibility check (D118,
  supersedes the Phase 5 gap noted in §12).
- **Maintenance worker.** `services/maintenance-worker`, same shape as `job-ingestion`/`matching-worker`: a
  BullMQ queue (`"maintenance"`) with one upserted repeatable scheduler (`retention-daily`, every 24h) and a
  concurrency-1 worker that calls `runRetentionSweep` for `DEFAULT_USER_ID`. `pnpm retention:run` runs the
  identical sweep once via a plain script (`runOnce.ts`), for manual use and E2E. It is the one containerized
  service ([D125](../DECISIONS.md)): `services/maintenance-worker/Dockerfile` (repo-root context, `pnpm deploy
  --prod` of just this service and its workspace packages, run as the non-root `node` user under `tsx`, no
  `.env` baked in -- `.dockerignore` and a CI check enforce that) and an opt-in `maintenance-worker` compose
  service behind the `workers` profile. The other two workers and the web app are still not containerized
  (§11/§12).
- **Retention.** `RETENTION_DAYS` (env, integer ≥ 0, default 30; `0` disables the whole sweep). Per due
  application, one transaction re-locks the row (`FOR UPDATE SKIP LOCKED`, replacing an unreliable
  per-user advisory lock on a pooled connection), deletes the job's generated rows across five tables, marks
  `retention_purged_at`, and logs a `documents_purged` event (counts only) -- MinIO objects are only removed
  **after** that transaction commits, so a crash can only orphan objects, never leave a row pointing at a
  missing one. A separate orphan sweep (24h-old-or-more, unreferenced keys only) collects anything that
  slips through (D119).
- **Known gaps.** Editing which document version is linked to an application after applying does not update
  `feature_snapshot` -- it keeps showing the original choice (D116). An applied job's documents cannot be regenerated (D118, by design, not a
  bug). Calendar dates (`applied_at`, `follow_up_at`, and the "today" used for the due list and date-picker
  defaults) are UTC dates on both server (`todayUtc`) and client (`ApplicationPanel`'s module-local `todayUtc` uses
  `toISOString().slice(0, 10)`, not the browser's local calendar day) -- near local midnight, a user in a
  non-UTC timezone can see "today" roll over up to many hours off from their wall clock. The server rejects an
  `appliedAt` after today and a snooze date that is not after today (D123). `packages/ingestion` now nulls
  non-http(s) posting URLs at normalization (D124, closes D113's known gap); `createApplication` and the
  application detail page keep their render guards as defense in depth for rows ingested before that fix.
- **Current document options.** `ApplicationPanel` re-fetches its version options before submitting, on window
  focus and on `DOCUMENTS_CHANGED_EVENT` (which the resume/pitch/cover-letter panels dispatch after a generate or
  edit), so the write-once `feature_snapshot` records the versions actually current at submit time (D123).
- Rationale: `docs/superpowers/specs/2026-09-30-phase-9-application-tracker-design.md`, DECISIONS.md D112–D123.

## 18. Phase 8 as built — Browser Automation (Guarded Autofill)

See §6 for the end-to-end diagram. This section is the as-built inventory; FLOW.md §13 traces the exact
call order and DECISIONS.md D127–D136 the rationale behind each piece.

- **Package.** `packages/browser` — pure logic, no Playwright/BullMQ/ioredis import. Adapters
  (`adapters/{types,greenhouse,lever,index,resolveAutofillTarget}.ts`, D128), the form-snapshot type
  (`types.ts`), the plain-JS in-page extractor (`snapshot/extractSnapshotSource.ts`, D131), deterministic
  value mapping (`values/buildAutofillValues.ts`), field classification (`plan/classifyField.ts`, D129), the
  fill-plan builder (`plan/buildFillPlan.ts`), confirmation detection (`detect/detectSubmission.ts`, D134),
  and the session lifecycle (`sessions/{createSession,transitions,readSessions,support,loadAutofillContext}.ts`,
  all operating through `withUserContext`).
- **Service.** `services/browser-worker` — host-run only (`pnpm --filter @ai-career/browser-worker start`,
  no Dockerfile/compose service: a headed Chrome window needs the user's own desktop). BullMQ consumer at
  concurrency 1 (`worker.ts`); `runSession.ts` is the per-session state machine; `actions.ts` is the sole
  module allowed to mutate the page, behind the stop-before-submit guard (D130); `browser.ts` owns Chrome
  launch, the throwaway per-session profile/attachments directory, and the released-window registry (below);
  `attachments.ts` downloads the session's resume/cover-letter PDFs from MinIO; `snapshot.ts` evaluates the
  extractor and reads back visible text for detection; `main.ts` wires it together, runs the startup
  cleanup/sweep, and logs ids/statuses/error classes only (D136).
- **Table.** `automation_sessions` (migrations `0026_faulty_agent_zero.sql`, `0027_automation_sessions_rls.sql`)
  — RLS-scoped like every other table (D2); a partial unique index enforces at most one active
  (`queued`/`launching`/`filling`/`awaiting_user`) session per user, and a second enforces at most one
  session per linked `application_id` (D132). `field_audit jsonb` holds the array of `FieldAuditEntry`
  (never a value, D136); `stopped_before_submit` stays `true` always, since the worker has no path that sets
  it otherwise.
- **Routes.** `POST /api/automation-sessions` (create + enqueue), `GET /api/automation-sessions?jobId=`
  (support + resume-available + latest-10 sessions, polled by the panel), `GET /api/automation-sessions/[id]`
  (single-session detail), `POST /api/automation-sessions/[id]/cancel`; `POST /api/applications` gained the
  optional `automationSessionId` field (D135). All under `apps/web/src/app/api/automation-sessions` except
  the last, which extends the existing Phase 9 route.
- **UI.** `AutofillPanel` on `/matches/[jobId]` (alongside the Phase 6/7/9 panels): start button (disabled
  without a resume export or while a session is active), live status text, a flagged/filled/skipped field
  audit, Cancel, "Record as applied?", and past sessions for the job.
- **Never-filled categories.** `github`, `website`, `work_authorization`, `eeo` (always flagged when
  required, skipped when optional; `eeo` keeps reason `intentionally_not_filled`), any unrecognized field
  (same required/optional split), and anything behind a combobox widget (`role="combobox"`/
  `aria-autocomplete` — an option can only be chosen by a click, which the worker cannot perform; this is
  why Greenhouse's yes/no sponsorship question, country and EEO fields are always flagged there). Three
  canonicals — `sponsorship`, `salary_expectation`, `resume` — are flagged whenever matched but not filled
  regardless of the field's own `required` attribute (D129).
- **Released-window model.** On `needs_manual` and `submission_detected` the worker does not close the
  browser window — it hands it to the user and returns the BullMQ job immediately, so the next queued
  session is not blocked behind an open window the user hasn't dealt with yet. `ReleasedWindows`
  (`services/browser-worker/src/browser.ts`) closes each released window at its own deadline (the remaining
  session timeout), when the user closes it themselves, or on worker shutdown; a separate "active window"
  slot tracks the one window a session still in progress has open, so shutdown closes that one too instead
  of leaking its temp profile and attachments (D132). Every other ending (`abandoned`, `failed`) closes the
  window immediately.
- **Session ids reserved for this phase's tests.** `00000000-0000-0000-0000-0000000008a1`–`…8a9`,
  `…8b1`–`…8b5` (global-constraints.md), verified unused repo-wide before use.

## 19. Outcome Analytics (Phase 10a)

- **What it is.** `/insights` shows response and interview rates, overall and broken down by role family, company, work mode, country, salary vs floor, match score, ATS score, required keyword coverage, posting age and documents sent, each with its sample size and a 95% Wilson interval, plus spec §16 rejection patterns (recurring missed required terms; results at ≥ 80% keyword coverage). Deterministic: no LLM calls.
- **How.** The pure package `packages/insights` computes everything on each `GET /api/insights` from `applications.feature_snapshot`, `application_events` and confirmed career goals ([D140](../DECISIONS.md)). No new tables: spec §19's `learning_features`/`application_outcomes` are the snapshot plus derived labels.
- **Labels.** Two tiers from stage history and logged events; withdrawn is excluded; open applications count as "no" after `OUTCOME_UNDECIDED_DAYS` (default 30) without activity ([D141](../DECISIONS.md)). Role family = best-matching career-goal target role ([D142](../DECISIONS.md)).
- **Snapshot v2.** New applications record the required terms the sent resume missed ([D143](../DECISIONS.md)); v1 snapshots show those as unknown.
- **Honesty rules.** Below `INSIGHTS_MIN_BUCKET` (default 5) decided applications, counts only; "stands out" only when the interval clears the overall rate; non-causal wording and a chance caveat ([D144](../DECISIONS.md)).
- **Known gaps.** Most groups say "not enough data" until there is real history. No multiple-comparison correction. Role families split if a target role is renamed (beyond case/spacing). Missed terms use the job's requirements at apply time, which follow the current description. External applications contribute only to the overall rates, role family and company. A status change made by mistake and later reverted still counts as evidence and activity -- history wins, and there is no way to retract an event. Label reasons (`TierOutcome.reason`) are computed for every application but not yet shown in the UI; only the aggregate headlines, breakdowns and patterns are displayed today. Not built (10b): a model, predictions, any ranking change.

## 20. Personal Response Model (Phase 10b)

- **What it is.** On top of 10a's response/interview labels, a second-order model learns, from a single user's own decided applications, which of the 9 match factor scores have gone with getting a response. `/matches` can show "likely response X% (low–high%)" on each eligible job and, opt-in, re-sort the list by a blend of the deterministic match score and that prediction; `/insights` explains the model itself. Deterministic: no LLM calls, no randomness, same input always gives the same output.
- **How (fit on read).** `packages/insights/src/model/trainResponseModel.ts` trains a ridge logistic regression, built from the data on every request and retrained only when the training rows or gate settings change — `GET /api/matches`, `GET /api/matches/[jobId]` and `GET /api/insights` all call the shared `apps/web/src/lib/insights/responseModel.ts` helper, which loads 10a's outcome dataset on every request and reuses an in-process cached result while the training rows and gate settings are unchanged; there is no stored model and no new table ([D146](../DECISIONS.md), [D153](../DECISIONS.md)). The fit (Newton-Raphson with an L2 penalty, Laplace covariance for a 95% prediction range) is verified against an independent NumPy computation ([D147](../DECISIONS.md)). Before it is ever shown, the model must clear two gates: enough decided rows in each class, and a leave-one-out check that it predicts held-out applications better than simply predicting the average — a model that doesn't clear both stays `no_pattern` and the deterministic ranking is untouched; any training error is caught and logged by class name only, never application content ([D148](../DECISIONS.md)). An opt-in "Rank with my history" toggle on `/matches` blends the prediction into the ranking at a weight that grows with the data but never exceeds 50% ([D149](../DECISIONS.md)).
- **Honesty rules.** Every prediction is shown with its range, never a bare percentage. A factor is only named as raising or lowering a specific prediction when its effect clears a minimum size, at most two per side. On `/insights`, factors below 1.1× odds either way are grouped as "Little or no link so far" rather than given a direction. Nothing in the copy says "because", "causes", or "predicts you will" — only "has gone with" and "likely", plus a fixed note that this describes the user's own past applications, not a cause or a guarantee ([D151](../DECISIONS.md)).
- **The scoring subpath.** `packages/insights` reaches the 9 factor keys only through `@ai-career/matching/scoring`, a dependency-light barrel of pure scoring functions and factor types with no path to the database, BullMQ or any AI client, enforced by a static import-graph test ([D150](../DECISIONS.md)).
- **Known gaps.**
  - **Performance.** Leave-one-out cross-validation is O(n²·k²): the Task 4 review measured 12 ms at 30 decided applications, 40 ms at 100, 116 ms at 200, and 708 ms at 500 — noticeably worse than the original spec's "tens of milliseconds at n ≤ 500" estimate, which was wrong (corrected in the spec's post-implementation notes). A single-entry in-process cache (keyed by a SHA-256 of the user id, gate settings and training rows) means this cost is paid once per change of the training data, not on every `/matches` load or 3-second run-status poll ([D153](../DECISIONS.md)). Remaining gap: the first request after any new decided outcome still pays the full cost, the cache does not survive a process restart, and the dataset itself (`loadInsightInputs` → `buildOutcomeDataset`) is still loaded on every request to compute the key.
  - **Feedback loop.** Ranking with the model changes which jobs a user is likely to apply to, which becomes the next round of training data. Mitigated by the toggle being opt-in, the 50% weight cap, and the default ranking staying the untouched deterministic score — not eliminated.
  - **Factor drift.** A factor's stored value reflects the matching code's scoring logic at the moment the application was created; if that scoring logic changes later, old and new factor values in the training data are not strictly comparable. No scorer-version field is recorded yet.
  - **Correlated factors.** The ridge penalty keeps the fit numerically stable but splits credit between factors that move together; the direction and rough strength shown for each factor are not a precise, independent effect.
  - **Interview-tier model.** Not built. The response tier was chosen because it has enough positives to gate and evaluate meaningfully at personal scale; an interview-tier model would need far more decided applications than most users will have.

## 21. AI Usage Observability & Cost Control (Phase 11a)

- **What it is.** Every Anthropic `messages.create` and every Voyage embedding request goes through one tracked path that checks a monthly budget first and then records one `ai_calls` row: operation, provider, model, tokens, web searches, latency, estimated cost, outcome (`ok` / `api_error` / `blocked`) and a short error code — never prompt or response text ([D154](../DECISIONS.md), [D157](../DECISIONS.md)). `/usage` shows this month's spend against the ceiling, by feature and by model, plus recent failed and blocked calls; the home page badges its link at the warn threshold and when the budget is reached ([D162](../DECISIONS.md)).
- **How.** `packages/ai/src/usage/` holds the sink interface, the price table, the budget gate, `createAnthropicFor` (a labelled, tracked client per operation) and the Langfuse exporter; `embedTexts` takes a required `{ sink, operation }`. Generators accept only `MessagesClient` (non-streaming `create`), so untracked SDK features do not compile. `packages/db`'s `DbUsageSink` writes and sums `ai_calls` under RLS. Web routes build the sink per request (`apps/web/src/lib/aiUsage/createUsageSink.ts`); the matching worker builds it per job for the job's user.
- **Budget.** `AI_MONTHLY_BUDGET_USD` (default $20, 0 = none) over the UTC month; at or over it every new call is blocked before reaching the provider, user actions answer 429 with a readable message, and the gate fails closed if spend cannot be read ([D155](../DECISIONS.md)). Background work degrades: embeddings keep D56's "degrade, never block" rule, and matching stops explaining but completes the run ([D158](../DECISIONS.md)).
- **Costs are estimates** from `packages/ai/src/usage/prices.ts`; an unknown model is priced at the highest known rate and named on `/usage` ([D156](../DECISIONS.md)). A response that reports no token usage is charged an estimate from the request (`max_tokens` for Anthropic, 4 characters per token for Voyage) and marked `usage_estimated`, never $0 ([D164](../DECISIONS.md)).
- **Langfuse (optional).** With all three `LANGFUSE_*` variables set, each recorded call is also sent as one OpenTelemetry span to Langfuse's OTLP endpoint, metadata only, fire-and-forget; `GET /api/health` reports whether export is on and how many exports this process has failed ([D160](../DECISIONS.md)).
- **Known gaps.** Check-then-call can overshoot the ceiling by the cost of calls already in flight. Prices are a hand-maintained table. The export failure counter is per process and resets on restart. Schema-validation failures are not a separate outcome. Logging (D9 scrubbing) is §22; rate limiting, the index audit and automated E2E in CI are §23.

## 22. Structured Logging, PII Scrubbing & Monitoring (Phase 11b)

- **Logging.** Every process logs through `@ai-career/logging`: one JSON line per event (`ts`, `level`, `service`, `event`, fields), `warn`/`error` on stderr, filtered by `LOG_LEVEL`. Fields are sanitized — strings scrubbed and truncated, errors reduced to class name, a code-shaped `code` and repo-relative stack frames, never their message ([D166](../DECISIONS.md), [D167](../DECISIONS.md)). A test fails on any `console.` call in production code. Workers also log uncaught exceptions, unhandled rejections and BullMQ `error` events message-free instead of letting Node print them; repeated BullMQ errors are logged once and then counted per minute (`worker_error_suppressed`) ([D173](../DECISIONS.md), [D175](../DECISIONS.md)).
- **D9 scrubbing.** The user's own name, email, phone, address and LinkedIn URL (exact, case-insensitive) and any email address are replaced before a line is written. Workers load the values at start and every minute; the web process loads them on its error path ([D168](../DECISIONS.md)).
- **Route errors.** All 40 API routes are wrapped in `withRouteErrors`: an error that escapes a handler is logged as `request_failed` (route, method, path without query string, error) and answered with a 500 carrying a request id, so the raw message never reaches Next.js's default handler or the client. Render errors go through `instrumentation.ts`'s `onRequestError` ([D169](../DECISIONS.md)).
- **Monitoring.** Each worker writes a Redis heartbeat every 30 s and records a clean stop on shutdown; `/status` (via `GET /api/status`) shows each worker as running, stopped, stale (no beat for `STATUS_STALE_AFTER_MS`, default 90 s) or never seen, plus each BullMQ queue's waiting/active/delayed/failed counts and its last failure — the reason only when it is one of our codes ([D170](../DECISIONS.md), [D171](../DECISIONS.md)).
- **Lifecycle.** Workers beat every `HEARTBEAT_INTERVAL_MS` (default 30 s) from right after Redis opens, shut down through `createShutdown` (once, exit 0, or exit 1 after a failing step or an 8 s deadline, inside Docker's 10 s stop grace period), and a saved profile invalidates the web redactor at once ([D174](../DECISIONS.md), [D175](../DECISIONS.md)).
- **Known gaps.** Next.js still prints its own line for render errors. No log shipping, rotation or alerting: stdout/stderr is the contract. Name variants are not redacted (D9). Heartbeat states assume web and workers share one clock. Failed-job counts cover only the jobs each queue retains. Workers pick up profile edits within a minute.

## 23. Security Hardening, Index Audit & CI E2E (Phase 11c–11d)

- **Network exposure.** The web app listens on `APP_HOST` (default `127.0.0.1`). `src/proxy.ts` checks every request: unknown `Host` → 421 (DNS rebinding), a cross-origin write → 403 (CSRF), and — only when `APP_ACCESS_TOKEN` is set — the `/unlock` cookie (an HMAC of the token) or a Bearer header, else 401 / redirect to `/unlock` ([D177](../DECISIONS.md)). Single-user, no accounts ([D1](../DECISIONS.md)).
- **Rate limits.** Fixed 60 s windows in Redis per route on the routes that call a paid API (*ai*) or start background work (*jobs*), and on `/api/unlock`; 429 with `Retry-After`; fail open when Redis is unavailable, since the monthly AI budget is the hard stop ([D178](../DECISIONS.md)).
- **Headers & bodies.** Baseline security headers on every response, no `X-Powered-By`; the proxy may buffer exactly the upload limit ([D179](../DECISIONS.md)).
- **Dependencies & stored errors.** Audit fixes (next, drizzle-orm 0.45, file-type, sharp, source-map-js); what a worker throws is stored by BullMQ only as a code ([D180](../DECISIONS.md)).
- **Indexes.** Every foreign key has its own index, enforced by a catalog test ([D181](../DECISIONS.md)).
- **CI E2E.** `pnpm e2e` (`e2e/`) drives the built app, two workers and local Anthropic/Voyage stand-ins in headless Chrome, isolated to the test database, Redis db 1 and its own user ([D182](../DECISIONS.md), [D183](../DECISIONS.md)).
- **Known gaps.** No script-src CSP (needs nonces). Over plain http the access cookie can be sniffed; use TLS beyond a trusted LAN. Fixed windows allow up to 2x a limit across a boundary, and limits are per route, not per client (anyone on an open LAN can use up the 5 unlock attempts a minute). Read-query plans were not re-profiled under realistic volume. The E2E stand-ins check wiring, not model quality (the `eval:*` scripts do that).

## 24. Broad Job Discovery (Phase 12)

- **More boards.** Ashby, Workable, SmartRecruiters and Recruitee join Greenhouse and Lever: one company per source, added by hand or found by discovery. A company's own posting outranks a user upload and an aggregator's copy when the same job appears in several sources ([D184](../DECISIONS.md)).
- **Search providers.** Remotive, Remote OK, Arbeitnow, The Muse, HN "Who is hiring", Adzuna, Jooble and USAJobs are searched with the active career goal's roles and places (first 5 of each, last 30 days), at most 50 requests a run; their postings close after 14 days unseen ([D187](../DECISIONS.md)).
- **Discovery.** Board links in fetched postings become pending boards; the worker validates them in the background (25 attempts a pass, an hour's backoff after a failure) and adds the real ones as enabled sources, up to 300 enabled; boards that disappear are retired. Users can also paste board links ([D186](../DECISIONS.md), [D190](../DECISIONS.md)).
- **Consent and politeness.** One recorded, revocable standing consent covers discovered and search sources (amends D3); every provider is fetched at most once a second per host ([D185](../DECISIONS.md), [D188](../DECISIONS.md)).
- **Known gaps.** No LinkedIn, Indeed or Glassdoor (bot-protected; not scraped), and no Workday, iCIMS or Taleo boards. Discovery finds only boards that postings link to. HN titles are parsed heuristically. Jooble is verified by fixtures only until a key is configured. Third-party terms (attribution, quotas) are the user's responsibility under the standing consent; the app enforces politeness, not each provider's terms.

## 25. Tailored LaTeX Resume (Phase 13c)

- **Flow.** `POST /api/documents` with `kind: tailored_resume` selects the resume items for one job deterministically ([D207](../DECISIONS.md)), renders them through one escaping function into an ATS-safe single-column template ([D208](../DECISIONS.md)), compiles, trims and recompiles up to 3 times until the PDF has one page ([D211](../DECISIONS.md)), and stores the PDF or the `.tex` with a `details` summary of ids and reasons ([D210](../DECISIONS.md)). No model is called.
- **The `latex-compiler` sidecar** (`services/latex-compiler`, compose profile `latex`, [D209](../DECISIONS.md)):

```
host: web app (route handler) ──HTTP, Bearer LATEX_COMPILER_TOKEN──▶ 127.0.0.1:8090 ─┐
                                                                                      │ trust boundary
┌ container: read-only root, tmpfs /tmp, uid 1000, cap_drop ALL, no-new-privileges,  │
│ 512 MB / 1 CPU / 64 pids, only LATEX_COMPILER_TOKEN in its environment ◀───────────┘
│  node:http → auth → ≤ 256 KB → limiter (2 running + 4 waiting) → per-request temp dir
│  → pdflatex -no-shell-escape -halt-on-error, 20 s wall clock then SIGKILL of the group
└ returns the PDF, page count and TeX version; logs sizes and timings, never resume text
```

  The `.tex` is built from the user's own profile (and, indirectly, from text that came from uploaded resumes), so it is treated as untrusted input. The sidecar is on the default compose network, not an `internal` one, because Docker does not publish ports for internal-only networks; egress is not blocked but pdflatex without shell-escape cannot open connections (R1).
- **Fallbacks.** A PDF needs the compiler (503 with the start command otherwise). A `.tex` export falls back to the estimate fit when the compiler is down (`pageVerified: false`).
- **Autofill.** The newest tailored PDF is the resume the browser worker attaches, else the full-profile resume ([D212](../DECISIONS.md)).
- **Known gaps.** Only Latin characters (no CJK or emoji; the export names where the first one is). One template, A4 or Letter (`RESUME_PAPER_SIZE`). No DOCX for the tailored resume and no manual include/exclude of items. Compilation is synchronous inside the request, bounded by 20 s. The image is large (1.23 GB).
