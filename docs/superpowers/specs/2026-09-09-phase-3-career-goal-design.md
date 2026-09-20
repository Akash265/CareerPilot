# Phase 3 Design — Career Goal Intelligence

Status: **implemented** (Phase 3 complete). The design below is kept as approved; section 12 lists where the built system differs from it or goes beyond it. Plan: `docs/superpowers/plans/2026-09-15-phase-3-career-goal-intelligence.md`. Rationale for each choice: `DECISIONS.md` D21–D30.

## 1. Scope

This phase implements the spec's §6.2 "Career Goal Statement — Replace Rigid Preference UI" step of the user journey (§5): `Enter Career Goal Statement → AI parses goal → structured constraints → user confirms/edits`. It covers:

- A free-text Career Goal Statement input, parsed by AI into structured, editable constraints, with a mandatory human review/confirm step before anything becomes the deterministic matching contract (spec §6.2's closing line: "the structured object remains the deterministic matching contract").
- The `career_goals` / `career_goal_constraints` data model (spec §19), versioned so a new confirm never destroys the previous goal's history.
- A deterministic salary-floor parser, extending D6's "the LLM never extracts/estimates numeric salary" principle from job postings to this input.
- Retiring the Phase 2 preference fields that duplicate this phase's concerns (see §2 below and the design-approval discussion this doc supersedes).
- Full-stack: database schema/migration, API routes, and the Next.js UI to exercise enter → parse → review → confirm → view/edit-as-new-version.

**Explicitly out of scope** (later phases): wiring `career_goal_constraints` into the matching engine (§8, Phase 5); any canonical geo-normalization of `locations` or fuzzy company-name matching (Phase 5's hybrid lexical+semantic retrieval is what's meant to reconcile free-text goal constraints against free-text job postings — building a taxonomy here would be premature); Job Intelligence/ingestion (§7, Phase 4).

## 2. Relationship to Phase 2's candidate profile

Phase 2 put several matching-relevant preference fields directly on `candidate_profiles` (`work_mode_preference`, `salary_expectation_min/max/currency`, `visa_sponsorship_required`, `preferred_role_titles`, `preferred_industries`, `excluded_industries`) plus a standalone `company_preferences` table (`preferred`/`excluded`). These are exactly the rigid, form-configured filters spec §6.2 says the natural-language Career Goal Statement should replace, and architecture.md §4's matching pipeline diagram treats "Career Goal" and "Candidate Profile" as two distinct inputs — not one field duplicated in two tables.

**Decision:** `career_goal_constraints` becomes the single source of truth for all search-relevant preferences going forward. The overlapping Phase 2 columns and the `company_preferences` table are dropped in this phase's migration, along with their UI fields in `ReviewForm.tsx` and their handling in `confirmedProfileSchema.ts` / `saveProfile.ts` / `serializeProfile.ts`. `candidate_profiles` keeps only true candidate facts: name/contact fields, `years_of_experience`, `work_authorization_notes`. This is scoped, targeted cleanup of code this phase's design directly obsoletes — not unrelated refactoring.

## 3. Data model

All tables are `packages/db/src/schema/*.ts` Drizzle definitions, RLS-enabled per D2/D12 (`user_id UUID NOT NULL DEFAULT current_setting('app.current_user_id')::uuid`, `ENABLE ROW LEVEL SECURITY`, app-role grants — never the migration superuser role), each carrying its own `user_id` column rather than relying on a join-based check, consistent with how `work_experience_bullets` already does this for a child-of-child table (D14).

### `career_goals`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid | RLS |
| raw_text | text | the user's original natural-language statement, preserved verbatim (spec §6.2, §7) |
| version | integer | sequential per user, starting at 1 |
| parse_status | enum: `pending`, `parsed`, `failed` | mirrors `resume_documents.extraction_status` (D15/D17 precedent) |
| parse_error | text, nullable | set when `failed` |
| confirmation_status | enum: `draft`, `confirmed` | a row starts `draft`; becomes `confirmed` only via the confirm endpoint |
| is_active | boolean | exactly one `true` confirmed row per user at a time |
| created_at | timestamptz | |
| confirmed_at | timestamptz, nullable | |

### `career_goal_constraints` (1:1 with a *confirmed* `career_goals` row)
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid | RLS |
| career_goal_id | uuid, unique fk → career_goals.id | written only at confirm time |
| target_roles | text[] | role titles/keywords, freeform |
| seniority | text, nullable | e.g. "senior", "mid" |
| locations | text[] | freeform country/city strings — no canonical geo taxonomy in this phase |
| work_mode | enum: `remote`, `hybrid`, `onsite`, `any` | reuses the existing `work_mode_preference` pg enum type |
| min_experience_years | integer, nullable | direct LLM extraction — low hallucination risk for a bare integer, unlike salary |
| employment_type | text, nullable | e.g. "full-time", "contract" — freeform, no fixed enum yet |
| salary_floor_raw | text, nullable | the phrase as the LLM found it, e.g. "minimum €60k" |
| salary_floor_normalized | numeric, nullable | deterministically parsed (§4 below) |
| salary_currency | text, nullable | ISO 4217 code where determinable |
| salary_is_parsed | boolean | false when the deterministic parser couldn't confidently resolve `salary_floor_raw` |
| salary_target_raw | text, nullable | the preferred/ideal-pay phrase, when the user gives one (spec §6.2 "preferred compensation", D28) |
| salary_target_normalized | numeric, nullable | deterministically parsed, same rules as the floor |
| salary_target_currency | text, nullable | |
| salary_target_is_parsed | boolean | |
| visa_sponsorship_required | boolean, nullable | tri-state: `null` = not mentioned in the goal statement, distinct from an explicit `false` |
| skills | text[] | priority skills called out in the goal statement |
| preferred_industries | text[] | |
| excluded_industries | text[] | |
| preferred_companies | text[] | |
| excluded_companies | text[] | |
| hard_constraints | text[] | freeform must-have/exclusion phrases that don't fit a structured field (spec §6.2 "priority terms and hard constraints") |

## 4. Parse → review → confirm pipeline

```
POST /api/career-goal/parse  { rawText }
  │
  ▼
Validate: rawText non-empty, reasonable max length
  │
  ▼
Compute next version = (max(version) for this user) + 1
Insert career_goals row (parse_status='pending', confirmation_status='draft',
                          is_active=false)
  │
  ▼
Anthropic call (fast/cheap tier, per D8/architecture.md §7), forced tool call,
Zod-validated output. Same prompt-injection defense as extractProfile.ts:
a per-request random delimiter tag wraps rawText, and the system prompt frames
it as untrusted data to extract-from, never instructions to follow (CLAUDE.md
§9) -- the user's own goal text can still contain pasted third-party content.
Extracts: target_roles, seniority, locations, work_mode, min_experience_years,
employment_type, salary_floor_raw and salary_target_raw (strings, NOT numbers;
the target was added later, see section 12), visa_sponsorship_
required, skills, preferred/excluded industries, preferred/excluded
companies, hard_constraints.
  │
  ├─ Zod validation fails / Anthropic error →
  │     career_goals.parse_status='failed', parse_error set,
  │     API returns an error response (handled outcome, not a 500 if it's
  │     a validation failure; the row already exists for audit purposes
  │     per CLAUDE.md §6 "track model failures")
  │
  ▼ (success)
Deterministic salary parser: salary_floor_raw → { amount, currency } or
  { amount: null, currency: null, isParsed: false } if it can't confidently
  resolve the phrase (ambiguous units, missing currency, unparseable range).
  Extends D6's "the LLM never extracts/estimates numeric salary" from job
  postings to this input, and reuses the same salary_raw/normalized/currency/
  is_parsed shape architecture.md §8 already defines for jobs.salary_*.
career_goals.parse_status='parsed'
Response: { goalId, version, rawText, draft: <structured fields + parsed
  salary> }  (career_goal_constraints not written yet)
```

```
User reviews `draft` in the UI: raw_text shown read-only for context, every
structured field editable, including plain amount+currency inputs for salary
so an unparsed phrase can always be fixed by hand.
  │
  ▼
POST /api/career-goal/confirm  { goalId, constraints: <edited draft> }
  │
  ▼
Validate constraints via Zod
  │
  ▼
Transaction (withUserContext):
  1. Insert career_goal_constraints row referencing goalId
  2. Update this career_goals row: confirmation_status='confirmed',
     confirmed_at=now(), is_active=true
  3. Set is_active=false on this user's previously active career_goals row,
     if any (their career_goal_constraints row is untouched -- it's history)
  │
  ▼
Response: the persisted goal + constraints
```

Editing an already-confirmed goal is not a `PATCH` — it re-enters the same flow from a new `POST /parse` call (the UI prefills the textarea with the current `raw_text`), producing a new version. Old versions are immutable, read-only history; nothing before the newest confirmed row is ever deleted or mutated.

## 5. Deterministic salary parser

A small function, `parseSalaryFloor(text: string): { amount: number | null; currency: string | null; isParsed: boolean }`, applied to the LLM's extracted `salary_floor_raw` phrase (not to the whole goal statement). Handles: currency symbols (`€`, `£`, `$`) and ISO codes, `k`/`K` thousands suffix, simple ranges (takes the lower bound as the floor), and common phrasing ("minimum", "at least", "€60k+"). Anything it can't confidently resolve leaves `isParsed=false` with `amount`/`currency` null — the raw phrase is preserved either way so the user sees what the parser saw. This is deliberately narrow (single-value extraction from short, user-authored phrases) rather than the fuller job-posting salary parser Phase 4 will need for messier third-party listing text; the two may end up sharing utility code, but that's an implementation-time decision, not a design one.

## 6. API surface

| Route | Method | Purpose |
|---|---|---|
| `/api/career-goal/parse` | POST | Submit raw text, get back an AI-parsed draft (not persisted as constraints yet) |
| `/api/career-goal/confirm` | POST | Persist the edited draft as `career_goal_constraints`, activate this version |
| `/api/career-goal` | GET | Fetch the active confirmed goal + constraints, plus a lightweight version history list (id, version, raw_text, confirmed_at) |

All routes operate under `withUserContext(db, env.DEFAULT_USER_ID, ...)` — no auth/session logic, per D1/D2.

## 7. UI flow (`apps/web/src/app/career-goal`)

Mirrors the `/profile` structure (`page.tsx` → a client orchestrator component):

- No confirmed goal yet → `GoalForm`: a textarea for the free-text statement, submit calls `/parse`.
- After a successful parse → `GoalReviewForm`: raw text shown read-only above an editable form for every structured field (including plain salary amount+currency inputs); "Confirm" calls `/confirm`.
- A confirmed goal exists → `GoalDashboard`: read-only display of the active constraints and raw text, version number, confirmed date, a short version-history list, and an "Edit Goal" button that reopens `GoalForm` prefilled with the current `raw_text`.
- A failed parse shows the error inline on `GoalForm` with the raw text still in the textarea, so the user can adjust and resubmit without retyping.

## 8. Security & privacy

- The goal statement is user-authored, first-person text, not third-party content, but CLAUDE.md §9's prompt-injection guidance is applied anyway (§4 above) since a user may paste text copied from elsewhere (a recruiter email, a job ad) into the box.
- No goal text or parsed constraints appear in application logs beyond a request id and error class on failure, consistent with D9/Phase 2's logging discipline — career goal content is career-related personal data same as resume content.

## 9. Error handling

- Empty/oversized `rawText` → `400` before any DB row is created or any Anthropic call is made.
- Anthropic call or Zod validation failure → handled outcome: `career_goals.parse_status='failed'`, `parse_error` set, response carries enough detail for the UI to show a retry affordance (not a 500 for a validation failure specifically).
- Deterministic salary-parse failure is not an error at all — `salary_is_parsed=false` flows through to a normal, fully reviewable draft; the user fixes it (or leaves it blank) in the review form like any other field.
- Confirm-time Zod validation failure → `400`, nothing written; the `career_goals` row stays `parsed`/`draft` so the user can retry confirming without re-parsing.

## 10. Testing strategy

- **Unit:** `parseSalaryFloor` against a fixture table (symbols, `k` suffix, ranges, per-year/per-month phrasing, ambiguous/unparseable input → `isParsed=false`); the Zod extraction-output and constraints schemas (valid input, missing fields, malformed arrays); version-increment logic.
- **Integration:** `POST /api/career-goal/parse` and `/confirm` against a real test database (RLS isolation verified the same way `packages/db/src/rls.test.ts` / `profileTables.rls.test.ts` do), Anthropic client mocked; a confirm-then-edit-then-confirm-again sequence asserting the old `career_goal_constraints` row survives untouched and `is_active` moves correctly.
- **Regression:** Phase 2 tests touching the retired `candidate_profiles` columns and `company_preferences` table updated to drop those fields/assertions (`ReviewForm.test.tsx`, `profileTables.rls.test.ts`, `confirmedProfileSchema` tests, `saveProfile`/`serializeProfile` tests).
- **AI evaluation** (CLAUDE.md §10): a small fixture set of 8–10 sample goal statements (varied phrasing, languages of currency, missing fields, deliberately ambiguous salary phrasing) with hand-verified expected structured output, scored for field-level extraction accuracy — same proportionate, fixture-based approach as Phase 2's resume-extraction eval.

## 11. Open items deferred to implementation time (not design-blocking)

- Exact `parseSalaryFloor` currency/format coverage (which symbols and phrasings are in v1 vs. deferred) — will be nailed down during TDD.
- Whether the migration drops `company_preferences` outright or the table is renamed/repurposed at the SQL level — either achieves the same end state; a clean drop is simpler given Phase 2 is not yet in production use.
- Exact max length / basic content validation for `rawText` beyond non-empty.

## 12. Post-implementation amendments

Recorded after a completeness audit against the original spec (§6.2, §19, §21) and this document. The design above is kept as approved; this section lists where the built system differs or goes beyond it.

**Added because the original spec required it and this design omitted it**
- **Preferred compensation.** Spec §6.2 lists "salary floor **and preferred compensation**"; §3 only had the floor. Four `salary_target_*` columns, a `salaryTargetRaw` extraction field, parallel deterministic parsing, a second amount/currency block in the review form, and a confirm-time rule that a preferred salary below the minimum (same currency) is rejected — D28. The constraints row therefore has 21 structured fields, not 17.

**Added because §7 and the user journey called for it**
- The dashboard renders the confirmed date and dated history (§7 promised it; the first build only typed the field).
- The home page links to `/profile` and `/career-goal`; without it neither step of the journey was reachable except by typing the URL.
- "Edit my statement" on the review screen returns to the form with the text intact and saves nothing.

**Integrity and error handling beyond §3/§4/§9**
- A per-user transaction-scoped advisory lock serializes version allocation and activation, since the schema has no unique index for either (D29). Without it, parallel parses shared a version and parallel confirms left two goals active.
- Confirm requires a goal that parsed successfully and is not yet confirmed; otherwise `409` (D26). A malformed JSON body is `400`, never a bare `500` (D27).
- `parse_error` stores the validation message for a schema failure but only the error class for anything else (§8 asked for "error class on failure"); a network/SDK message can echo the goal text.
- `GET /api/career-goal` throws if an active goal has no constraints row instead of reporting "no goal".

**Differences from the text above, kept deliberately**
- `POST /confirm` returns `{ status: "confirmed" }`, not the persisted goal; the client re-fetches `GET /api/career-goal`.
- Confirm's statement order is lock → check → deactivate the old active goal → insert constraints → activate, not the order listed in §4.
- Version numbers can skip: a parse that fails or is abandoned before confirm still consumes one (D24), so the history can read 1, 3.
- `salaryFloorRaw`/`salaryTargetRaw` are the phrase the user wrote, possibly with its qualifier ("minimum €60k"); scoring compares what the parser makes of them, not the strings.

**Interpretations of spec §6.2 worth stating**
- "Minimum/target experience" is captured as `min_experience_years` plus the free-text `seniority`; there is no separate "target years" field.
- "Remote/hybrid/onsite preference" is a single value. A statement such as "remote or hybrid" has to pick one (or `any`); a multi-select is a possible later change.
- "Role families" are free text in `target_roles`; no taxonomy exists yet (out of scope, §1).

