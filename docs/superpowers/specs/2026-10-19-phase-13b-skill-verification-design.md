# Phase 13b — Missing-Skill Verification — Design

Status: implemented and merged to main 2026-10-19 (merge commit a2d7d89; branch phase-13b-skill-verification, deleted). Post-merge fix D206 (route cache cleared on start).
Part of Phase 13 (user's 2026-10-19 refinement request), split by user choice into
13a one-click discovery (merged) → 13b missing-skill verification (this spec) → 13c job-specific LaTeX resume
(depends on 13b).

## 1. Problem

A "missing skill" today is computed deterministically by `computeGapTerms`
(`packages/application-package/src/interviewPrep/computeGapTerms.ts`): a required skill/tool/certification
term (≤ 4 words, D104) from `job_requirements` that does not occur (boundary-aware) in any profile evidence
entry. Gaps feed the cover-letter and interview-prep guards so the model never claims them (D92–D108).

Nothing ever asks the user whether a gap is real. Naming mismatches ("Postgres" vs "PostgreSQL", D92's
known limitation) and skills the user has but never listed stay permanent gaps, and 13c's job-specific
resume could only ever use skills already present in the profile.

Facts found during design that constrain it:

1. `saveProfile` (`apps/web/src/lib/profile/saveProfile.ts`) deletes and re-inserts every `skills` row on
   every save, so skill ids are not stable and anything written into `skills` is lost on the next profile
   edit.
2. Matching's skills factor (`runMatching.ts` → `scoreSkills(constraints.skills, …)`) compares the
   **goal's** skills to the job text, not the profile. Verification therefore does not change match scores.
3. `job_requirements` is extracted lazily (one `ANTHROPIC_MODEL_FAST` call per job, cached by description
   hash) only when a resume is optimized or an application package generated.
4. Gap detection lives in `application-package`, but the verify page and 13c's resume need it too.

## 2. Decisions taken in brainstorming (user choices)

| # | Question | Choice |
|---|---|---|
| 1 | What is a confirmation worth? | **"Yes" requires a short evidence sentence**; the skill then becomes citable evidence. No evidence-free "yes". |
| 2 | Where is the user asked? | **Both**: a batched `/skills` page (primary, gaps ranked by how many top jobs they block) and a per-job panel on the match detail page; same stored answers. |
| 3 | Synonyms | **System suggests, user confirms**: a deterministic built-in alias list proposes "same as your *X*?"; nothing counts as covered until accepted. No AI suggester in 13b. |
| 4 | Approach | **Separate `skill_verifications` table used as a new evidence source**; requirements extracted for top-N jobs after each matching run. |

## 3. Goals and success criteria

- A resume, cover letter or interview prep never claims a required skill the user has not verified with
  evidence (existing guards plus the new `verified_skill` fact type).
- A skill the user has is never stuck as a gap: answering it once removes it from every job's gap list.
- Verifications survive profile edits.
- After "Find matching jobs", the `/skills` page lists gaps for the top matches without further AI waits.
- Unanswered gaps never block resume optimization (notice only).

Out of scope: match-score changes (fact 2), an AI alias suggester, LaTeX rendering (13c).

## 4. Data model — `skill_verifications` (new migration, RLS like every user table)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid | default `current_setting('app.current_user_id')::uuid`, RLS policy as other tables |
| `term_key` | text not null | normalized term (§5.1); unique `(user_id, term_key)` |
| `term_display` | text not null | the term as the (first/latest) job wrote it, used in UI and as the catalog text |
| `status` | enum `skill_verification_status` = `have` \| `dont_have` \| `alias` | |
| `evidence` | text null | required (1–300 chars after trim) iff `status='have'`, else null |
| `alias_skill_name` | text null | required iff `status='alias'`, else null — a **name**, not an id (fact 1) |
| `answered_at` | timestamptz not null default now() | first answer |
| `updated_at` | timestamptz not null default now() | last change |

CHECK constraints enforce the status/field combinations and lengths. Editing an answer updates the row in
place (no versioning); the resume snapshot's `contentHash` changes, so existing resume versions show as
stale exactly as after a profile edit. `DELETE` removes the row (the term becomes unanswered again).

An `alias` row covers its term only while a profile skill with that name (case-insensitive, normalized)
still exists; if the user removes that skill, the gap returns as unanswered with the old alias shown as a
suggestion.

## 5. Gap detection — `packages/resume-optimization/src/gaps/`

### 5.1 Moved code

`computeGapTerms`, `containsTerm`, `isGapCandidate`, `MAX_GAP_TERM_WORDS` and their tests move from
`application-package/src/interviewPrep/computeGapTerms.ts` to `resume-optimization/src/gaps/` unchanged;
`application-package` imports them from `@ai-career/resume-optimization` (it already depends on it). No
behavior change for cover letters and interview prep beyond what the catalog change in §5.3 implies.

`normalizeTermKey(term)`: trim, lowercase, collapse internal whitespace. Used for `term_key` and for alias
lookups.

### 5.2 `computeSkillGaps`

```
computeSkillGaps(requirements, catalog, verifications, profileSkillNames) → SkillGap[]
SkillGap = { termKey, termDisplay, requirementIds[], state, suggestion?: string }
state ∈ covered | declined | unanswered
```

For each gap candidate (same `isGapCandidate` rule):
- **covered** — `containsTerm` finds it in the catalog haystack (the catalog now includes `verified_skill`
  entries, §5.3), or an `alias` verification exists whose `alias_skill_name` is still in `profileSkillNames`.
- **declined** — a `dont_have` verification exists.
- **unanswered** — otherwise. `suggestion` is set when the built-in alias table (§5.4) maps the term to a
  group containing one of the user's profile skill names (or a stale alias's name).

A suggestion never makes a term covered. Output is deterministically sorted (term key, then requirement id).

### 5.3 New evidence source type

`EvidenceSourceType` gains `"verified_skill"`. `buildResumeSnapshot` reads `skill_verifications` where
`status='have'` and appends `{ sourceFactId: row.id, sourceType: "verified_skill", text: "<term_display>:
<evidence>", context: "Verified by you" }`. Because the catalog is the single source for the guard's
fact-id check (D60/D61), `applyDeterministicGuard` accepts a cited `verified_skill` with no rule change, and
`computeGapTerms`' haystack then contains the term, so it stops being a gap for cover letters and interview
prep as well.

Evidence is user-written text and goes to the model inside the same delimited, untrusted-data treatment as
other profile facts.

### 5.4 Built-in alias table — `gaps/aliases.ts`

A static list of ~60 equivalence groups of common names (e.g. `postgres|postgresql|psql`,
`js|javascript`, `ts|typescript`, `k8s|kubernetes`, `aws|amazon web services`, `gcp|google cloud|google cloud
platform`, `ml|machine learning`, `ci/cd|continuous integration`…), keys normalized with
`normalizeTermKey`. Pure data plus one lookup function; unit-tested for no key appearing in two groups.

## 6. Flows

### 6.1 Requirements for top matches (process-driven)

After `runMatching` completes (including 13a's debounced re-match), `services/matching-worker` — not
`packages/matching`, so matching takes no dependency on resume extraction — selects the top
`SKILL_GAP_TOP_N` (new env, default 25, 1–200) eligible `job_matches` by `overall_score` and calls the
existing `ensureJobRequirements` for each one whose cache is missing or stale. Sequential; uses the
existing cache, `anthropicFor("job_requirements_extraction")` and the AI budget (Phase 11a). One job's
failure (validation error, API error, budget exceeded) is logged without description text and skipped;
the step never fails the matching run. A budget-exceeded error stops the remaining jobs in that step.

### 6.2 API (apps/web, behind the existing proxy gate and rate limits)

| Route | Behavior |
|---|---|
| `GET /api/skill-gaps` | Top `SKILL_GAP_TOP_N` eligible matches + their requirements + verifications + profile skill names → `computeSkillGaps` per job → unanswered gaps grouped by `term_key` with `jobCount` and job list (id, title, company), sorted by `jobCount` desc then term; plus `answered` (all verification rows) and `jobsWithoutRequirements` count. |
| `GET /api/skill-gaps/[jobId]` | Same for one job: its covered / declined / unanswered gaps, or `requirementsStatus: "missing"` when not extracted yet. 404 for a job without a match row. |
| `POST /api/skill-gaps/[jobId]/requirements` | Runs `ensureJobRequirements` for that job now ("Check requirements"); AI rate-limit bucket. |
| `PUT /api/skill-verifications/[termKey]` | Body (zod): `{ status: "have", evidence, termDisplay }` \| `{ status: "dont_have", termDisplay }` \| `{ status: "alias", aliasSkillName, termDisplay }`. Upsert by `term_key` (last write wins). 400 on invalid body/JSON; 422 when `aliasSkillName` is not a current profile skill. |
| `DELETE /api/skill-verifications/[termKey]` | Removes the answer; 404 if none. |

`termKey` in the path is the normalized key, URL-encoded; the server re-normalizes and rejects a mismatch
with 400.

## 7. UI

- **`/skills` ("Verify skills")** — linked from the navigation and from `/matches`. Unanswered gaps sorted by
  how many top jobs they block ("Required by 7 of your top 25", expandable job list). Each row: *I have it*
  (evidence textarea, required, 300-char counter), *I don't have it*, *Same as…* (select of profile skills;
  the suggested one pre-selected and labeled "suggested"). Below: answered list with edit and undo. Shows
  "N top jobs have no requirements checked yet" when `jobsWithoutRequirements > 0`.
- **`SkillGapsPanel`** on `/matches/[jobId]` — this job's unanswered gaps with the same three controls, plus
  covered and declined counts; "Check requirements" button when requirements are missing.
- **`ResumeOptimizationPanel`** — non-blocking notice when the job has unanswered gaps: "2 required skills
  are unanswered — answer them so the resume can use them", linking to the panel.

## 8. Downstream changes required for safety

- `applyDeterministicGuard` / evidence index: `verified_skill` is a valid fact type (no rule change, §5.3).
- `document-export` `buildResumeModel`: a selected `verified_skill` is rendered in the Skills section using
  `term_display`; without this the current "applied fact unknown → throw" path would crash the export. The
  export's profile-hash check uses the same snapshot, so it stays consistent.
- Cover letter and interview prep: no code change beyond the moved import; a `have` term is no longer a gap,
  a `dont_have` term keeps today's protections (D100–D108).

## 9. Error handling and privacy

- Evidence text is never logged; logs carry status and term-key length only (Phase 11b scrubbing applies).
- Unknown/expired jobs, missing goal, or no matches → empty lists, not errors, on `GET /api/skill-gaps`.
- Concurrent answers to the same term: upsert, last write wins.
- An alias whose profile skill was removed degrades to unanswered + suggestion (§4).

## 10. Testing

- **Unit:** `normalizeTermKey`; `computeSkillGaps` for every state, including stale alias, suggestion-not-
  covered, dedup across requirements, deterministic order; alias table integrity; moved `computeGapTerms`
  tests unchanged.
- **Integration (test DB):** migration + CHECK constraints + RLS; `buildResumeSnapshot` includes
  `verified_skill`; guard accepts a cited verified skill and still rejects unknown ids; matching-worker
  post-step (top-N selection, cache reuse, one-job failure, budget stop); every route incl. 400/404/422.
- **Export:** `buildResumeModel` with a selected `verified_skill`.
- **UI (vitest/RTL):** `/skills` page and `SkillGapsPanel` — answer, edit, undo, suggestion pre-selection,
  evidence required.
- **E2E (`e2e/`):** answer a gap on `/skills` → it disappears on the page and on the job panel → optimize the
  resume → the result cites the verified fact.
- **AI eval:** none needed — 13b adds no new model calls or prompts (only earlier use of the cached
  extraction).

## 11. Configuration

`SKILL_GAP_TOP_N` (packages/config env, optional, default 25, int 1–200).

## 12. Limits stated to the user

- Verifying a skill does not change match scores (scores use the goal's skills).
- The alias table only covers common names; other synonyms need "Same as…" by hand.
- Gaps are listed only for the top `SKILL_GAP_TOP_N` matches and jobs whose requirements were extracted.
- Phrase-shaped or "other"-typed requirements are never gaps (unchanged D104 limitation).

## 13. Planning refinements (2026-10-19)

- **R1 — Write routes are keyed by body / id, not by term in the path.** Terms like `ci/cd` or `c#` do not survive a path segment reliably. `PUT /api/skill-verifications` (body carries `termDisplay`; the server computes `term_key`) and `DELETE /api/skill-verifications/[id]` (uuid) replace the spec's `[termKey]` routes.
- **R2 — A live alias is a catalog entry too.** `buildResumeSnapshot` adds `{ sourceType: "verified_skill", text: "<term> (same as <profile skill>)" }` for an alias whose profile skill still exists. Without it, the cover-letter and interview-prep gap checks (`computeGapTerms`, which only sees the catalog) would still treat an aliased term as missing.
- **R3 — The requirements step runs after the matching job completes, not inside it.** It is fired from the worker's `completed` event (single-flight per user), so 13a's search run — which waits for matching to finish — is never delayed by up to 25 extraction calls.
- **R4 — Every verified skill is rendered in the resume's Skills section** (selected ones first), not only those the optimizer selected — consistent with D82 (every profile item is rendered).
- **R5 — E2E stops at the verification API and pages.** "Optimize resume → cites the verified fact" is pinned by a `runResumeOptimization` integration test with a fake Anthropic client (Task 5), because the E2E stand-in has no optimizer answer.
- **R6 — The alias table has ~50 groups**, not ~60: only unambiguous equivalents (e.g. `tf`, `cv`, `dl` are left out).
