# Phase 13a — One-Click Discovery ("Find Matching Jobs") — Design

Status: approved in conversation 2026-10-19; awaiting written-spec review.
Part of Phase 13 (user's 2026-10-19 refinement request), split by user choice into
13a one-click discovery (this spec) → 13b missing-skill verification → 13c job-specific LaTeX resume.

## 1. Problem (audit, 2026-10-19)

Everything needed for broad discovery exists (Phase 4/12: 6 ATS board kinds, 8 search providers,
board discovery from posting links, validation, freshness, dedup; Phase 5 ranking; Phase 9 applied
exclusion). The user still experiences discovery as manual because:

1. **"Find matching jobs" only re-ranks stored jobs.** `MatchesClient.tsx` → `POST /api/matches/run` →
   matching queue. No ingestion is triggered; the notice tells the user to start a worker.
2. **Discovery is not seeded by the goal.** New companies are found only from board links inside
   postings already fetched (D186). Nothing searches for employers that fit the goal.
3. **First use needs `/sources` setup** (standing consent + enabling each provider).

Out of scope here: skill verification (13b), resume/LaTeX (13c), Apify (user chose search APIs in
Phase 12; Apify can be added later as another adapter behind the existing interface).

## 2. Goals and success criteria

- One click on `/matches` → fresh-enough listings from every enabled source → goal-seeded company
  discovery → matching → ranked results, with per-source progress and plain failure reasons.
- First click without standing consent shows an inline consent panel; accepting it is the only setup.
- Applied jobs stay excluded (unchanged eligibility rule).
- Closing the tab never loses a run; a slow or failing source never blocks results.
- No change to adapters, normalization, dedup, eligibility, or scoring.

## 3. Architecture

### 3.1 Search runs

New table `search_runs` (migration `0033_search_runs.sql` + `0034_search_runs_rls.sql`, RLS like every
user table):

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid | RLS default as elsewhere |
| status | enum `search_run_status` `queued`/`running`/`matching`/`completed`/`failed` | |
| goal_constraints_id | uuid fk career_goal_constraints (set null) | goal the run used |
| created_at, started_at, heartbeat_at, finished_at | timestamptz | |
| deadline_at | timestamptz | `started_at + FIND_JOBS_MAX_WAIT_SECONDS` |
| sources | jsonb | array of `{sourceId, name, kind, state, reason?, newCount?}`; state ∈ `reused`/`queued`/`running`/`done`/`failed`/`late` |
| seeding | jsonb | `{probe:{names, boardsQueued, state, reason?}, webSearch:{state, reason?, boardsQueued, unsupported}}`; webSearch.state ∈ `ran`/`skipped_recent`/`skipped_budget`/`failed` |
| error_code | text | code-like only (`no_active_goal`, `consent_missing`, `stalled`, …) |

At most one non-terminal run per user: a partial unique index on `(user_id) WHERE status IN
('queued','running','matching')`. `reason` values are fixed codes (the existing `errorClass` values or the
new ones in this spec), never provider text — no PII, no raw responses.

New columns on `discovered_boards` (migration 0033):
- `found_via` enum `board_found_via` `posting_link`/`pasted`/`name_probe`/`web_search`, NOT NULL,
  backfilled `posting_link` where `found_via_source_id` is not null, else `pasted`.
- `expected_company` text, nullable (set for `name_probe`/`web_search`).
- `reject_reason` text, nullable (records `company_mismatch` and existing rejection classes).

New column on `discovery_settings`: `last_web_search_at` timestamptz, `last_web_search_goal_id` uuid.

### 3.2 Request flow

```
/matches "Find matching jobs" → POST /api/search-runs                     apps/web
   409 consent_required  (no discovery_settings.consented_at)  → inline consent panel
   409 no_active_goal    (no active confirmed goal)             → link to /career-goal
   200 existing run      (a non-terminal run exists)            → idempotent
   202 new run: insert search_runs(queued) → enqueue coordinator job (queue "search-runs", jobId = run id)
/matches polls GET /api/search-runs/latest every 3 s while non-terminal; then reloads matches.
POST /api/discovery/settings/accept-and-enable (inline panel): sets consented_at + auto_discover, enables
   every keyless provider and each keyed provider whose env key is set (same rules as setProvider).
```

### 3.3 Coordinator (services/job-ingestion, its own BullMQ Worker on queue `search-runs`, concurrency 1)

It must be a separate Worker from the ingest worker: the ingest worker runs one job at a time
(concurrency 1), so a coordinator waiting inside it would deadlock.

`coordinateSearchRun(deps, runId)` in `packages/ingestion/src/searchRun/`:

1. Mark `running`; re-check consent and active goal (else `failed` with the code).
2. **Plan sources** (pure `planSourceRefresh`): every enabled, consented, non-upload source. A source is
   `reused` when its last ingestion run finished `succeeded` within `FIND_JOBS_FRESH_MINUTES` (default 360)
   **and** — for search-kind sources — the goal has not changed since that run; otherwise queued via the
   the worker's own ingest `Queue` with the same fixed `ingestJobId(sourceId)` dedupe as the web's
   `enqueueIngestion` (a source already waiting/active — by id or its scheduler — is waited on, not
   duplicated; completion is read from `ingestion_runs`, so either way is observed).
3. **Seed** (both steps isolated; a failure is recorded, never thrown):
   - `probeEmployerNames` (§4.1) → pending boards.
   - `maybeWebSearch` (§4.2) → pending boards.
   - Then starts `validatePendingBoards` in the background, same as today (budgets unchanged).
4. **Wait**: every 2 s update `heartbeat_at` and each queued source's state from `ingestion_runs` rows with
   `source_id` = it and `started_at >= run.started_at` (finished → `done` with `newCount`, or `failed` with
   `errorClass`). Stop when all are terminal or `deadline_at` passes; still-running sources become `late`.
5. Status `matching`; enqueue matching (shared producer, §3.4). Wait for the matching run started after
   this point to finish (bounded by `FIND_JOBS_MATCH_WAIT_SECONDS`, default 300), then `completed`
   (or `failed` with `matching_failed` / `matching_timeout`; sources/seeding data kept either way).

Crash/stall: `GET /api/search-runs/latest` and `POST /api/search-runs` treat a non-terminal run with
`heartbeat_at` (or `created_at` if never started) older than 10 minutes as `failed`/`stalled` (written
under the row lock), so the next click starts fresh.

### 3.4 Matching after ingestion (debounced re-match)

- `enqueueMatching` moves from `apps/web/src/lib/matching/enqueue.ts` to `packages/matching/src/enqueue.ts`
  (same behaviour); the web route imports it from there.
- After any ingestion run that finishes with `newCount + updatedCount + closedCount > 0` and no
  non-terminal search run (scheduled runs, late sources, newly validated boards), the ingest worker's
  `afterRun` calls `requestRematch(userId)`: Redis `SET careerpilot:rematch:<user> 1 EX 3600`, then
  enqueues a matching job delayed `MATCH_DEBOUNCE_SECONDS` (default 120). If a matching job is already
  waiting or active, the flag stays set.
- Matching worker, after a run completes: if the flag is set, `DEL` it and enqueue one delayed match.
  The fixed matching job id keeps this to at most one queued run at a time.

## 4. Goal seeding

### 4.1 Name probing (free, every run)

- Employer names: distinct `jobs.company` from jobs first seen in the last 14 days whose postings come
  from search-origin sources, ordered by their `job_matches.role_score` for the active goal
  (unmatched last), whose `company_key` has no existing `discovered_boards` row with that
  `expected_company` key and no enabled board source already. Up to `DISCOVERY_PROBE_MAX_NAMES`
  (default 30) per run.
- `slugGuesses(name)` (pure): from `companyKey(name)` tokens — joined (`acmerobotics`) and hyphenated
  (`acme-robotics`); one guess if they coincide; each must pass the existing per-kind slug validation.
  Inserted for each of the 6 board kinds as `pending`, `found_via = name_probe`, `expected_company = name`,
  via `insertPendingBoards` (`ON CONFLICT DO NOTHING` — a slug already tried, even rejected, is never
  retried).

### 4.2 Capped web search

- Runs when `discovery_settings.last_web_search_goal_id` ≠ the active goal constraints id, or
  `last_web_search_at` is older than `DISCOVERY_WEB_SEARCH_INTERVAL_DAYS` (default 7); else
  `skipped_recent`. `DISCOVERY_WEB_SEARCH=false` disables it.
- One call via the worker's `createAnthropicFor(...)("discovery_web_search")` (new entry in
  `AI_OPERATIONS`, packages/ai; existing budget gate and `ai_calls` recording;
  a budget block → `skipped_budget`) on `ANTHROPIC_MODEL_RESEARCH` with the basic `web_search_20250305`
  tool, `max_uses = DISCOVERY_WEB_SEARCH_MAX_USES` (default 5), `pause_turn` followed up to 2 times.
- Prompt input: only the goal's structured target roles (≤5), locations (≤5), remote preference and
  skills (≤10). No job text, no profile data.
- Output used: **only URLs of cited web search results** (`web_search_tool_result` blocks), run through
  the existing `extractBoardLinks`. Each board link → pending board, `found_via = web_search`,
  `expected_company` = the result's title up to its first separator (` - `, ` | `, ` at `). Cited URLs
  that are not a supported board count as `unsupported` (shown, never fetched). The model's own text is
  ignored, so injected instructions in pages cannot change what is fetched.
- Stamps `last_web_search_at`/`last_web_search_goal_id` after any completed call (even with 0 boards).

### 4.3 Company check during validation

`validatePendingBoards`: for a board with `found_via ∈ {name_probe, web_search}` and an
`expected_company`, the first record's normalized company name must satisfy
`companyKey(found) === companyKey(expected)` or one key's token sequence starts with the other's
(`acme` vs `acme robotics`); otherwise status `rejected`, `reject_reason = company_mismatch`, no source
created. Boards from posting links/paste are unchanged.

## 5. UI (`/matches`)

- Button "Find matching jobs" → POST; states: consent panel / goal missing / progress / results.
- Progress panel: one row per source (name, state, new jobs or failure reason in plain words via a
  fixed code→text map), seeding line ("Checked N employer names, queued M boards; web search: ran /
  skipped (searched 3 days ago) / skipped (AI budget reached)"), "N sources still running — results will
  update automatically" when `late` > 0.
- The old "make sure the worker is running" notice is replaced by `stalled` messaging.
- Results list unchanged.

## 6. Configuration (packages/config env, all optional with defaults)

`FIND_JOBS_FRESH_MINUTES` 360 · `FIND_JOBS_MAX_WAIT_SECONDS` 180 · `FIND_JOBS_MATCH_WAIT_SECONDS` 300 ·
`MATCH_DEBOUNCE_SECONDS` 120 · `DISCOVERY_PROBE_MAX_NAMES` 30 · `DISCOVERY_WEB_SEARCH` true ·
`DISCOVERY_WEB_SEARCH_INTERVAL_DAYS` 7 · `DISCOVERY_WEB_SEARCH_MAX_USES` 5. Documented in `.env.example`.

## 7. Error handling summary

| case | result |
|---|---|
| no consent / no goal | 409 with code, UI explains |
| second click during a run | 200 with the existing run |
| one source fails / is rate limited | row `failed` + reason; others continue |
| source slower than deadline | `late`; its later completion triggers the debounced re-match |
| seeding or web search fails | recorded in `seeding`; run continues |
| AI budget reached | web search `skipped_budget`; run continues |
| coordinator/worker dies | `stalled` after 10 min; next click starts fresh |
| Redis down | 503 fixed message (as existing routes) |
| matching fails | run `failed` (`matching_failed`), sources data shown |

## 8. Testing

- Unit: `planSourceRefresh` (fresh/stale/goal-changed/upload excluded), `slugGuesses`, company check,
  web-search due rule, source-state rollup, re-match decision.
- Integration (real Postgres/Redis, existing harness, unique test user ids): coordinator with fake
  adapters — one fresh (reused), one failing, one slower than the deadline (late → re-match); consent and
  goal refusals; idempotent second click (partial unique index); stall recovery; name probing inserts and
  skip-on-conflict; web search against a fake Anthropic server whose results include a supported board,
  a non-ATS career page, and an injection-style string — only the board is queued; company mismatch
  rejection; migration backfill of `found_via`.
- Route tests for `/api/search-runs` (POST, latest) and the accept-and-enable route; component test for
  the progress panel.
- E2E (existing Playwright recipe + fake Anthropic): consent → click → progress → ranked results; an
  applied job is absent.

## 9. Limits stated to the user

- No crawler reaches every job: coverage = enabled providers + validated ATS boards on 6 platforms.
  Companies on other platforms or custom career sites are counted as `unsupported`, not scraped.
- Newly discovered boards are validated in the background (≤25 per pass); their jobs arrive on later
  ingestion runs and appear through the automatic re-match, not necessarily in the first click's results.
- Adzuna/Jooble/USAJobs need keys; web search needs a working Anthropic key and budget.
