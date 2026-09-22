# Phase 5 — Hybrid Matching Engine: Design

Date: 2026-09-22
Status: design, not yet implemented
Spec reference: project specification §8 (Eligibility + Hybrid Matching Engine), §9 (Recommendation System), roadmap Phase 5
Related decisions: D2 (RLS), D6 (deterministic salary/location, LLM never estimates numeric data), D7/D8 (task-to-tier model selection, deterministic before AI), D21/D22 (career_goal_constraints is the single source of truth for search-relevant preferences), D29 (advisory-lock pattern for versioned/active rows), D32 (separate worker process, domain logic out of the worker), D36 (never auto-merge/auto-hide on an unconfirmed signal — carried over here as "never silently drop")

## 1. Scope

**In scope**
- Deterministic eligibility filter over `jobs` × `career_goal_constraints` × `candidate_profiles`.
- Hybrid candidate retrieval: PostgreSQL FTS/`pg_trgm` (lexical) + pgvector cosine similarity (semantic) against job description embeddings.
- Weighted per-factor scoring (skills, experience, location/work-mode, sponsorship, role preference, salary, industry, freshness, semantic fit) per architecture.md §4's initial weights.
- AI match reasoning (fast/cheap model tier): natural-language explanation of the top-N ranked jobs, structured and Zod-validated, grounded in the already-computed factor scores.
- A `matching-worker` BullMQ service (mirrors `services/job-ingestion`) that runs a full recompute for the active career goal on request.
- API + UI: ranked match list, match detail with factor breakdown and explanation, save/dismiss.

**Out of scope (later phases, deliberate)**
- Structured job-requirement extraction (`job_requirements`, required-vs-preferred split, LLM extraction of a job's skill list) — Phase 6, per the roadmap's own placement of "Requirement extraction" under ATS Resume Optimization.
- "Already applied" as an eligibility exclusion — no applications table exists until Phase 9; only "dismissed" is available as a user-driven exclusion in this phase.
- Automatic recompute triggered by career-goal confirmation or ingestion-run completion — manual "Find Matches" trigger only.
- FX conversion for salary comparison (Phase 4 already deferred this; Phase 5 compares only same-currency amounts and treats a currency mismatch as an unscored/neutral salary factor, not a hard fact).
- Personalized/learned ranking adjustments (outcome-based feature learning) — Phase 10.
- Geo canonicalization beyond what Phase 4 already stores (`country_code`, `location_raw`).

## 2. Decisions taken in brainstorming

| # | Decision | Alternative rejected |
|---|---|---|
| 1 | No job-requirements extraction table; skill match computed from `jobs.descriptionText` (lexical + semantic) | LLM-based structured requirement extraction per job (moved to Phase 6) |
| 2 | Ineligible jobs get a `job_matches` row with `eligible=false` + reason, not silently dropped | Hide ineligible jobs entirely (no eligibility API surface) |
| 3 | Separate `matching-worker` BullMQ process, mirroring `job-ingestion` | Synchronous API route running eligibility + scoring + ~25 LLM calls inline |
| 4 | AI explanation generated for only the top-N ranked eligible jobs per run (default 25) | Explain every eligible job; explain lazily per-view on user click |
| 5 | One `job_matches` row per `(user_id, job_id)`, overwritten on recompute (not versioned) | Version match rows per career-goal version, like `career_goals` |
| 6 | Manual "Find Matches" trigger only | Auto-recompute on goal confirm and/or on ingestion-run completion |
| 7 | `career_goal_constraints.embedding`: one query-side embedding per confirmed goal | Per-job-search-session embedding computed on the fly at request time |

Each becomes a DECISIONS.md entry (D45 onward) when implemented.

## 3. Data model

All new tables carry `user_id` (default `current_setting('app.current_user_id')::uuid`) with RLS (D2).

**`jobs` (extended)**
- `embedding vector(1024)` — nullable; embeds `title + descriptionText` via the existing Voyage wrapper (`packages/ai/embeddings.ts`), same dimensionality as `profile_facts` (`PROFILE_FACT_EMBEDDING_DIMENSIONS`).
- `embedding_content_hash text` — nullable; the `descriptionHash` value the embedding was generated from. Regenerated only when `descriptionHash` changes and no longer matches this column (permanent, content-hash-keyed cache, same pattern D-line52 established for `profile_facts`).
- `embedding_model text` — nullable; records which model produced the stored vector, same convention as `profile_facts.embeddingModel`.

**`career_goal_constraints` (extended)**
- `embedding vector(1024)` — nullable; embeds `targetRoles.join(" ") + skills.join(" ") + careerGoals.rawText` for the goal this constraints row belongs to. Computed once when the goal is confirmed (existing `POST /api/career-goal/confirm` flow gains this step); never recomputed for a given row, since a `career_goals` row is immutable once created (D23) and a new goal version gets its own constraints row.
- `embedding_model text` — nullable.

**`job_matches`** — new table; also the mechanism for "saved/dismissed jobs" (spec §19's original core-table list) until Phase 9's tracker exists.
```
id                    uuid PK
user_id               uuid, RLS default
job_id                uuid FK -> jobs, cascade delete
career_goal_id        uuid FK -> career_goals (the goal version this match was computed against)
eligible              boolean not null
ineligible_reason     text (null when eligible)
skills_score          numeric (null when ineligible)
experience_score      numeric
location_score        numeric
sponsorship_score     numeric
role_score            numeric
salary_score          numeric
industry_score        numeric
freshness_score       numeric
semantic_score        numeric
overall_score         numeric (null when ineligible)
explanation           jsonb  (StructuredExplanation | null)
explanation_model     text (null until generated)
explanation_generated_at  timestamp with time zone (null until generated)
user_action           enum('none','saved','dismissed') not null default 'none'
user_action_at        timestamp with time zone (null when user_action = 'none')
computed_at           timestamp with time zone not null
created_at            timestamp with time zone not null default now()
```
Unique `(user_id, job_id)` — one row per job, overwritten (not appended) on each recompute; `career_goal_id` records which goal version produced the current row, used for staleness detection (section 7). `StructuredExplanation` shape: `{ strongMatches: string[], partialMatches: string[], gaps: string[], summary: string }`, validated with Zod (matches architecture.md §6's "AI-generated results should ... distinguish strong/partial/missing").

**`matching_runs`** — one row per recompute, mirrors `ingestion_runs`.
```
id             uuid PK
user_id        uuid, RLS default
career_goal_id uuid FK -> career_goals
started_at     timestamp with time zone
finished_at    timestamp with time zone (null while running)
status         enum('running','completed','failed')
error_class    text (null unless status = 'failed')
jobs_evaluated integer      -- count of eligible + ineligible jobs scored
jobs_explained integer      -- count that got an AI explanation (<= top-N)
```

Indexes: `ivfflat` (or `hnsw`, decided at implementation based on installed pgvector version) on `jobs.embedding` for the KNN retrieval step; `pg_trgm` GIN already exists on `jobs.title`/`jobs.company_name` from Phase 4, reused here; unique `(user_id, job_id)` on `job_matches`.

## 4. Pipeline

```
services/matching-worker (Node process, BullMQ on the existing Redis — same infra as job-ingestion)
  └─ worker: processes a `run-matching` job for one (user, active career_goal)
```

Per `run-matching` job:

1. **Guard** — reload the active, confirmed `career_goals` row; abort (`error_class = "no_active_goal"`) if none exists.
2. **Ensure query embedding** — if `career_goal_constraints.embedding` is null, generate and store it as a fallback. The primary path is generating it once when the goal is confirmed, via a small addition to Phase 3's existing confirm handler (see section 10's last item); this step exists so a recompute never fails outright if that addition is ever skipped for an older row.
3. **Ensure job embeddings** — for every open job whose `embedding_content_hash` differs from its current `description_hash` (or is null), generate and store an embedding. Batched, rate-limited, same pattern as `profile_facts` embedding generation.
4. **Eligibility filter** — for every open job, evaluate the deterministic rules in section 5. Ineligible jobs get a `job_matches` upsert with `eligible=false` and a reason; nothing further runs for them.
5. **Hybrid retrieval + scoring** — for every eligible job, compute the nine factor scores (section 6) and `overall_score`. Upsert `job_matches` with `eligible=true`, scores set, `explanation` left as whatever it already was (stale check happens in step 6).
6. **AI explanation** — take the top N eligible jobs by `overall_score` (default 25, env-configurable) whose existing explanation is stale (section 7's rule) or absent. For each, call the fast/cheap Anthropic tier with the factor scores + evidence as context; validate the response against the `StructuredExplanation` Zod schema; on success set `explanation` + `explanation_model` + `explanation_generated_at`; on a malformed/failed response, leave the row's deterministic scores intact and `explanation` untouched (never block the ranked list on an explanation failure).
7. **Finalize** — update `matching_runs` with counts and `status = completed` (or `failed` with an `error_class` if step 1/2/3 raised).

**Code layout**
- `packages/matching` — eligibility rules, scoring math, retrieval SQL builders, explanation prompt + schema (pure/testable, no queue code), following the `packages/ingestion` precedent (D32: domain logic stays out of the worker).
- `services/matching-worker` — BullMQ glue only: dequeues `run-matching`, calls `packages/matching`, writes `matching_runs`.
- The web app enqueues "Find Matches" onto the same queue via `POST /api/matches/run`.

## 5. Eligibility filter (deterministic, hard)

A job is ineligible (excluded from scoring, but still recorded) when any of:

- **Excluded company/industry** — `jobs.companyName` (case-insensitive) is in `career_goal_constraints.excludedCompanies`, or a heuristic industry tag overlaps `excludedIndustries`. (Industry tagging has no dedicated job field yet; Phase 5 matches on company name only for the industry exclusion — a labeled `industry` field is a Phase 6+ gap, noted in section 9.)
- **Work-mode hard mismatch** — `career_goal_constraints.workMode = 'remote'` and `jobs.workMode` is `onsite` or `hybrid`.
- **Experience hard mismatch** — `jobs.minExperienceYears` is not null and exceeds `candidateProfiles.yearsOfExperience` (also not null) by more than a configurable grace (default 1 year). If either side is null/unknown, this rule does not fire (spec §6's "never guess" — an unknown doesn't become a hard block).
- **Sponsorship hard mismatch** — `career_goal_constraints.visaSponsorshipRequired = true` and `jobs.sponsorship = 'not_offered'`.
- **Previously dismissed** — an existing `job_matches` row for this job has `user_action = 'dismissed'`.

Each rule that fires sets `ineligible_reason` to a fixed, evidence-carrying string (e.g. `"onsite; remote required"`, `"requires 6+ years, profile states 3"`) — never a bare boolean, per CLAUDE.md §6.

## 6. Hybrid retrieval + scoring

Runs only over jobs that passed section 5, so "retrieval" here is a ranking/scoring pass over the eligible set, not a top-K filter that discards jobs before they're scored — the spec's "candidate set" step exists to bound the *explanation* cost (section 4 step 6), not to hide jobs from the user.

- **Lexical** — `ts_rank`/`similarity()` of `career_goal_constraints.targetRoles` + `skills` against `jobs.title` + `jobs.descriptionText` (reusing the existing `pg_trgm` GIN index).
- **Semantic** — `1 - (career_goal_constraints.embedding <=> jobs.embedding)` cosine similarity.
- **`skills_score`** — a deterministic blend of the lexical hit rate (fraction of stated skills found verbatim/fuzzy in the description) and the semantic similarity score; exact formula and blend weight fixed during implementation and covered by unit tests with fixed fixtures.
- **`experience_score`** — full credit if `minExperienceYears` is at or below the profile's years of experience; degrades linearly for a soft gap within the grace window (the hard case was already filtered in section 5); full credit if either side is unknown (never penalize an unknown).
- **`location_score`** — full credit for a work-mode match (`remote`/`hybrid`/`onsite`/`any`); partial credit when `career_goal_constraints.locations` overlaps `jobs.locationRaw`/`countryCode` loosely; the hard remote-vs-onsite case never reaches here (filtered in section 5).
- **`sponsorship_score`** — full credit when not required or when `offered`; partial credit for `unknown` (flagged, not assumed); the hard `not_offered`-when-required case never reaches here.
- **`role_score`** — lexical/semantic similarity of `jobs.title` to `career_goal_constraints.targetRoles`.
- **`salary_score`** — compares `jobs.salaryMin`/`salaryMax` to `career_goal_constraints.salaryFloorNormalized`/`salaryTargetNormalized` **only when currencies match and both sides are parsed** (D6: never estimate); otherwise the factor is neutral (scored as "unknown," not zero) and the explanation says why.
- **`industry_score`** — same company-name heuristic as section 5's soft version (`preferredIndustries`), degraded weight given the missing structured field noted there.
- **`freshness_score`** — decay curve off `jobs.postedAt` (fallback `firstSeenAt`, labeled per Phase 4's own convention); configurable half-life, full credit under 24h per spec §9.
- **`semantic_score`** — the raw semantic similarity from above, kept as its own factor per architecture.md §4's weight table (distinct from its role inside `skills_score`).
- **`overall_score`** — the architecture.md §4 weighted sum (skills 30 / experience 15 / location 15 / sponsorship 10 / role 10 / salary 5 / industry 5 / freshness 5 / semantic 5), with a factor's weight redistributed proportionally across the remaining factors when that factor is "unknown" rather than silently treated as zero.

## 7. AI match reasoning

- Fast/cheap Anthropic tier (architecture.md §7's task-tier table), triggered "on ranking" for the top N (default 25) eligible jobs by `overall_score`.
- Input to the model: the nine factor scores + their evidence strings (skill hits/misses, experience numbers, location/sponsorship state, salary comparison) — never the raw job description or raw resume text directly; the model's job is to narrate already-computed, already-trustworthy facts into readable prose, not to re-derive them (same "LLM explains, doesn't decide" boundary as D6).
- Output: `{ strongMatches: string[], partialMatches: string[], gaps: string[], summary: string }`, Zod-validated. A schema failure is logged with an error class (never job content) and leaves `explanation` as-is — the ranked list and its deterministic per-factor breakdown are always available even if every explanation call fails.
- **Staleness / cache invalidation** — an explanation is regenerated when any of: the job's `descriptionHash` changed since `explanation_generated_at`, the active `career_goal_id` differs from the row's stored `career_goal_id`, or `explanation_generated_at` is more than 7 days old (D-line52's TTL). This is a superset of a pure TTL cache: content or goal changes invalidate immediately rather than waiting out the week.

## 8. API and UI

Route handlers follow the Phase 2–4 conventions: `readJsonBody`, 400 on malformed JSON, 409 on invalid state, RLS via `app.current_user_id`.

- `POST /api/matches/run` — enqueues a `run-matching` job for the active career goal; 409 if no active/confirmed goal exists, or a run is already in progress (BullMQ job id keyed on `user_id`, same "already queued" pattern as Phase 4's `ingestion_runs`).
- `GET /api/matches?eligible=&sort=&page=` — ranked list, default `eligible=true` sorted by `overall_score desc`; `eligible=false` lets the UI show excluded jobs with their reasons.
- `GET /api/matches/[jobId]` — full factor breakdown + explanation + job detail.
- `PATCH /api/matches/[jobId]` — `{ userAction: 'saved' | 'dismissed' | 'none' }`; setting `dismissed` takes effect on the *next* recompute (section 5), not retroactively.
- `GET /api/matches/runs/latest` — status of the most recent `matching_runs` row, for the UI's "Find Matches" polling.
- Pages: `/matches` (ranked cards: score + per-factor chips + explanation summary, save/dismiss actions, "Find Matches" button with run-status polling, toggle to view ineligible jobs with reasons), `/matches/[jobId]` (full breakdown). Linked from home alongside `/jobs`, `/sources`.

## 9. Testing, security, process

**Testing**
- Unit (`packages/matching`): table-driven fixtures for each eligibility rule (including the "unknown never hard-blocks" cases) and each scoring factor (including the "unknown redistributes weight, never zeroes" case); retrieval SQL builders tested against a real Postgres with `pg_trgm`/pgvector fixtures, not mocked.
- Integration (real Postgres + Redis): full worker run end to end against seeded jobs + a confirmed goal; explanation staleness triggers on description-hash change and on goal-version change; a malformed LLM response doesn't block the run or clear existing scores; RLS enforced.
- AI evaluation (CLAUDE.md §10): a labeled fixture set of (factor-scores → expected explanation content) pairs, checked for the explanation naming the right strong/partial/gap items, not just schema validity.
- E2E: real Chrome against the built app + a fake Anthropic server (same recipe as Phases 2/3), driving "confirm goal → run ingestion → Find Matches → see ranked list → dismiss a job → recompute reflects it."

**Security**
- Explanation prompts carry only pre-computed factor scores and short evidence strings, never raw job description text — bounds prompt-injection surface from untrusted job content (CLAUDE.md §9) without needing per-field nonce handling, since the untrusted text never enters the prompt.
- Logs carry error classes and counts, never job content, profile content, or explanation text.

**Process**
- DECISIONS.md D45+, FLOW.md, `docs/architecture.md` §4/§10 updated to reflect what's actually built.
- CLAUDE.md §21 explain-back step after implementation (no blanket waiver granted for this phase).
- No commits without an explicit request (CLAUDE.md §15).

## 10. Assumptions to verify during planning

- **Skills-score blend formula** (lexical hit-rate vs. semantic similarity weighting) is deliberately left unspecified above a "deterministic blend" — the first plan task should fix the exact formula and cover it with fixed-fixture unit tests, the same way Phase 4 fixed its salary regex against real samples before trusting it.
- **Industry tagging gap** — both the eligibility exclusion and the `industry_score` factor rely on company-name-only heuristics because no job has a structured `industry` field. This is a known weaker signal, not a blocker; a real `industry` field (from a taxonomy or a light LLM tag in Phase 6) would strengthen it later.
- **ivfflat vs. hnsw** for the `jobs.embedding` index depends on the pgvector version actually installed in `infra/docker-compose.yml`'s Postgres image; confirmed at implementation time.
- **Default top-N (25) and freshness half-life** are starting guesses, both env-configurable; no labeled data exists yet to tune them (mirrors Phase 4's "conservative default, tunable" stance on its trigram threshold).
- **`career_goal_constraints.embedding` generation on confirm** touches Phase 3's existing `POST /api/career-goal/confirm` handler — a small, additive change (compute + store one embedding), not a redesign of that flow; called out explicitly since it's the one place this phase edits already-shipped Phase 3 code.
