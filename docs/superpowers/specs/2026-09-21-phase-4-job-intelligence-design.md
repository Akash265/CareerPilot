# Phase 4 — Job Intelligence: Design

Date: 2026-09-21
Status: implemented; see the plan's "Refinements" R1–R16 (`docs/superpowers/plans/2026-09-21-phase-4-job-intelligence.md`) for where verification against real APIs changed the design, and section 9 below
Spec reference: project specification §7 (Job Intelligence), §15 (salary/freshness), roadmap Phase 4
Related decisions: D3 (allowlisted sources + consent), D6 (deterministic salary), D8 (deterministic before AI), D2 (RLS), D17 (sync vs worker), D29 (error class, not message)

## 1. Scope

**In scope**
- Source adapters: **Greenhouse** and **Lever** public board APIs, plus **CSV/JSON file upload**.
- A separate ingestion worker process (BullMQ on the existing Redis) with scheduled and on-demand runs.
- Normalization to a persistent `jobs` schema; deterministic extraction of salary, work mode, minimum experience and sponsorship signal.
- Three-tier job identity / deduplication; closing of jobs that disappear from a source; posted-date tracking.
- UI: Sources page, read-only Jobs list, Job detail.

**Out of scope (later phases, deliberate)**
- Ashby, RSS, Apify adapters (new adapters slot into the same interface).
- Any LLM call and any embedding at ingest time (D8: they run in Phase 5/6 on jobs that survive eligibility).
- Skill/requirement extraction (`job_requirements`) — Phase 6.
- Eligibility filtering, hybrid retrieval, ranking, match explanations, FX conversion, geo canonicalization, fuzzy company matching — Phase 5.
- Merging duplicate candidates from the UI; deleting a source (disabling suffices).

## 2. Decisions taken in brainstorming

| # | Decision | Alternative rejected |
|---|---|---|
| 1 | Sources: Greenhouse + Lever + file upload | Add Ashby/RSS; upload + one API; Apify-first |
| 2 | Separate worker process, BullMQ + repeatable jobs | Inline API route; worker hosted inside Next.js |
| 3 | Rules-only enrichment, "unknown" is first-class | Embed every job; LLM extraction per job |
| 4 | UI: Sources page + read-only Jobs browser | Sources only; API/CLI only |
| 5 | Raw-first staged pipeline, 3-tier identity, fuzzy matches flagged not merged | Normalize-on-fetch + fingerprint only; auto-merge fuzzy |
| 6 | Duplicate candidates are read-only in the detail view | "same/different" resolution buttons |

Each becomes a DECISIONS.md entry (D31 onward) when implemented.

Consequence of decision 1 worth keeping visible: Greenhouse and Lever expose **one board per company**. "Discovery" in Phase 4 means the user curates a watch-list of company boards. Keyword-driven market-wide discovery is only available through Apify and is deferred.

## 3. Data model

All tables carry `user_id` (default `current_setting('app.current_user_id')::uuid`) with RLS (D2).

**`job_sources`** — the watch-list.
`kind` (`greenhouse | lever | upload`), `label`, `config` jsonb (board slug), `enabled`, `consent_confirmed_at`, `last_run_at`, `last_run_status`, `last_error_class`. The worker refuses to run a source whose `consent_confirmed_at` is null (D3), enforced in worker code, not only in the UI.

**`ingestion_runs`** — one row per fetch.
`source_id`, `started_at`, `finished_at`, `status`, counts (`fetched`, `new`, `updated`, `closed`, `failed`), `error_class`, `complete` boolean. Only `complete = true` runs may close jobs.

**`raw_job_postings`** — latest source payload only (not a history).
`source_id`, `external_id`, `payload` jsonb, `content_hash`, `fetched_at`; unique `(source_id, external_id)`.

**`jobs`** — canonical job with persistent identity.
- Identity: `company_name`, `company_key`, `title`, `title_key`, `seniority`, `fingerprint`.
- Location: `location_raw`, `country_code` (only when the source states it structurally, else null), `work_mode` (`remote | hybrid | onsite | unknown`).
- Content: `employment_type`, `description_text` (sanitized plain text), `description_hash`.
- Salary (D6): `salary_raw`, `salary_min`, `salary_max`, `salary_currency`, `salary_period`, `salary_is_parsed`.
- Rule-derived: `min_experience_years` + `min_experience_evidence`; `sponsorship` (`offered | not_offered | unknown`) + `sponsorship_evidence` + `sponsorship_conflict` boolean.
- Dates: `posted_at` (source-reported, nullable), `first_seen_at`, `last_verified_at`.
- Lifecycle: `status` (`open | closed`), `closed_at`.

**`job_postings`** — one row per source appearance of a job.
`job_id`, `source_id`, `external_id`, `url`, `last_seen_at`, `status`, per-field provenance (which posting supplied which canonical field).

**`job_duplicate_candidates`** — trigram near-matches.
`job_id_a`, `job_id_b`, `similarity`, `status` (`pending | same | different`). Phase 4 only writes `pending`.

Indexes: unique `(source_id, external_id)` on raw and postings; btree on `fingerprint`; `pg_trgm` GIN on `jobs.title` and `jobs.company_name` (for the list filter only; tier-3 matching is not index-accelerated, see D36).

## 4. Pipeline and worker

```
services/job-ingestion (Node process)
  ├─ scheduler: on boot, upserts one BullMQ repeatable job per enabled source
  │             (default every 6h, env-configurable)
  └─ worker: processes `ingest-source` jobs, concurrency limited per source
```

Per `ingest-source` job:

1. **Guard** — reload source; abort if disabled or `consent_confirmed_at` is null.
2. **Fetch** — adapter implements `fetch(source): AsyncIterable<RawRecord>` (`{externalId, payload}`). Greenhouse/Lever: HTTPS JSON with timeout and response-size cap. Upload: triggered by the upload API, not the schedule.
3. **Store raw** — upsert `raw_job_postings`. Unchanged `content_hash` → skip the rest, bump `last_seen_at` only.
4. **Normalize** — pure `normalize(kind, payload) → NormalizedJob`, no I/O (section 5).
5. **Identify + upsert** — the three tiers below, one transaction per job. A record that fails normalization is counted in `failed` and skipped; it never aborts the run.
6. **Close** — only for a `complete` run of a Greenhouse/Lever source: postings not seen this run become `closed`; a job with no open postings becomes `closed`.

**Upload sources never close anything.** A file is a one-shot snapshot with no notion of a complete board, so absence from a later upload is not evidence a job expired. Re-uploading an updated export creates a new upload source; overlap with earlier uploads is resolved by the identity tiers.

**Identity tiers**
1. **Exact key** — same `(source_id, external_id)` → same posting.
2. **Deterministic fingerprint** — hash of `company_key + title_key + location key + description_hash` → postings from different sources merge into one canonical job. Field conflicts resolved by source precedence (ATS API over upload), then recency; provenance recorded per field.
3. **Fuzzy** — `pg_trgm` similarity on `company_key + title_key` with matching location key above a threshold → a `job_duplicate_candidates` row (`pending`). **Never auto-merged**: a false merge hides a real job, a false split shows one extra row.

**Failure handling**
- Transient errors (network, 5xx, 429): retry with exponential backoff.
- Non-retryable (404 bad slug, response schema mismatch): fail the run immediately; error class stored on the source and shown in the UI.
- Partial fetch: run recorded `complete = false`, closes nothing.

**Code layout**
- `packages/ingestion` — adapters, `normalize`, identity logic (pure, unit-testable).
- `services/job-ingestion` — BullMQ + scheduling glue only. Domain logic stays out of the worker (spec §4).
- The web app enqueues "Run now" onto the same queue.
- Docker Compose gains the worker service.

## 5. Normalization rules

`normalize()` is deterministic. Every derived value carries an evidence snippet or an explicit "unknown". Nothing is guessed, and nothing defaults to zero.

**Salary** (new parser, separate from `parseSalaryFloor`; they may share utilities, decided at implementation)
- Structured source fields first (Greenhouse/Lever pay fields, upload columns).
- Otherwise a regex pass over the description: currency + amount patterns (`€60k–€80k`, `$120,000 – $150,000 per year`, `£45/hr`), ISO codes, `k` suffix, ranges, period (hour/month/year).
- Stores the matched span as `salary_raw`. Hourly/monthly normalized to annual only when the period is explicit.
- Multiple conflicting ranges, or equity/bonus figures mixed in → `salary_is_parsed = false`, raw span kept. No salary → null (spec §15).
- No FX conversion in Phase 4; comparison with the goal's floor is Phase 5.

**Work mode** — structured fields first, then title/location keywords (Remote, Hybrid, On-site); otherwise `unknown`.

**Minimum experience** — phrases like "3+ years", "at least 5 years of experience", "2–4 years"; lowest stated figure kept with its snippet. Only numbers tied to "experience" count ("10 years in business" does not). No match → null.

**Sponsorship** — small phrase list sets `offered` ("visa sponsorship available", "we sponsor") or `not_offered` ("no sponsorship", "must be authorized to work"). Both present → `unknown` with `sponsorship_conflict = true`. The UI shows it with its evidence, never as a bare fact (CLAUDE.md §8).

**Identity keys** — `company_key`/`title_key` lowercased, punctuation and legal suffixes (Inc, GmbH, Ltd) stripped; seniority words removed from the title key and stored separately.

**Dates** — `posted_at` only from a source's explicit posted/created field, else null. Greenhouse `updated_at` is **not** treated as posted. `first_seen_at` is always set; Phase 5 freshness falls back to it, labeled as such.

## 6. API and UI

Route handlers follow the Phase 2–3 conventions: `readJsonBody`, 400 on malformed JSON, 409 on invalid state, RLS via `app.current_user_id`.

- `GET /api/job-sources`, `POST /api/job-sources` (kind + slug; slug validated `^[a-z0-9-]{1,64}$`).
- `PATCH /api/job-sources/[id]` — enable/disable. Enabling requires `consentConfirmed: true`, which sets `consent_confirmed_at`; otherwise 400.
- `POST /api/job-sources/[id]/run` — enqueue; 409 if disabled, no consent, or already running.
- `POST /api/job-sources/upload` — CSV/JSON with type and size validation (reusing the `fileDetection` approach); creates an upload-kind source and enqueues.
- `GET /api/jobs?q=&status=&sourceId=&page=` — text filter on title/company via the `pg_trgm` index. No ranking.
- `GET /api/jobs/[id]` — postings, evidence snippets, duplicate candidates (read-only).
- Pages: `/sources` (add board/upload, consent checkbox, enable/disable, last-run status/error, Run now), `/jobs`, `/jobs/[id]` (raw vs normalized fields, evidence). Linked from home.

## 7. Testing, security, process

**Testing**
- Unit: table-driven fixtures per rule, including adversarial cases (conflicting salaries, "10 years in business", "no sponsorship" + "sponsorship available"); identity tiers; adapters against recorded fixtures (no live network in CI).
- Integration (real Postgres + Redis): incomplete run closes nothing; null-consent source never runs; upload sources never close; RLS enforced; worker end to end.
- Extraction eval: labeled fixture set for salary/experience/sponsorship/work-mode with reported precision and recall (CLAUDE.md §10).
- E2E: real Chrome against a small fake ATS server (same recipe as the fake Anthropic server).

**Security**
- Adapters call only fixed hosts, built from the validated slug, never a user-supplied URL (SSRF).
- Size and timeout caps on every fetch and upload.
- HTML stripped to text; job content is untrusted input (CLAUDE.md §9) and, when Phase 5/6 puts it in prompts, goes through the D20 nonce mechanism.
- Logs carry error classes and counts, never posting content.

**Process**
- DECISIONS.md D31+, FLOW.md, `docs/architecture.md` (including §10's dedup item), README updated.
- CLAUDE.md §21 explain-back step after implementation.
- No commits without an explicit request (CLAUDE.md §15).

## 8. Assumptions to verify during planning

- **Real API response shapes.** Which of Greenhouse's and Lever's fields expose a posted/created date, structured location/country, and pay ranges is assumed, not confirmed. The first plan task records real (or documentation-derived) fixtures and adjusts section 5 accordingly. If a source has no posted date, `posted_at` stays null.
- **Tier-3 similarity threshold** has no labeled data yet; it starts conservative and is tunable, and since nothing auto-merges the cost of a wrong value is review noise, not data loss.
- **Default 6h schedule** is a guess at a polite polling interval; it is env-configurable.

## 9. Implementation notes

Written after the build. Where sections 3–5 disagree with this list, this list is what was built; the rationale for each item is in DECISIONS.md D31–D39 and the plan's "Refinements" table.

- **Structured pay fields are not implemented.** Section 5's "structured source fields first" step was dropped: none of about 1,430 sampled real postings carried a pay field, so salary is read from description text (and an upload's `salary` column) only (D34).
- **Fingerprint and content hash live on `job_postings`**, not on `jobs`. Each posting stores its `normalized` snapshot; `jobs` is recomputed from all of its postings by a pure merge and `jobs.field_provenance` records which posting supplied each field group (D35).
- **`jobs.location_key`** is a stored column (the identity tiers needed a location key the data model did not list).
- **Posted date:** Greenhouse `first_published` and Lever `createdAt` (epoch milliseconds) are the posted dates; Greenhouse `updated_at` is never treated as one. Only Lever gives a structured country and work-mode field; Greenhouse `country_code` is always null.
- **Slug pattern is widened** to `^[A-Za-z0-9_-]{1,64}$`: real board tokens are mixed-case and underscored, and the set still cannot alter the host or path (D37).
- **An empty fetch is incomplete.** A fetch that returns zero records is recorded as `complete = false` (`empty_result`) and closes nothing, in addition to section 4's partial-fetch rule (D36).
- **No compose service.** `infra/docker-compose.yml` still runs only Postgres, Redis and MinIO; the worker is started with `pnpm --filter @ai-career/job-ingestion start`. Section 4's "Docker Compose gains the worker service" is not implemented (D32).
- **Scheduling.** The worker reconciles one repeatable scheduler per enabled, consented, non-upload source every 60 seconds; creating a scheduler fires its first run immediately, so enabling a source starts a fetch within about a minute. "Already queued" (409) is decided by BullMQ job id (`ingest-<sourceId>`), not by an `ingestion_runs` status.
- **Untrusted-input hardening** beyond section 7's security list (bounded text and salary/experience/sponsorship scans, identity-field length caps, upload row caps, a fail-fast queue producer, error classes that carry no content) was added during code review; see D39.
- **Unchanged raw records are still normalized.** Section 4 step 3 ("skip the rest") is only partly true: an unchanged record is still normalized on every run and only the job write is skipped (persist sees the same content hash and just bumps `last_seen_at`).
- **The shipped E2E is an HTTP-level smoke test, not an automated Chrome test.** `services/job-ingestion/e2e/smoke.ts` drives the real web app, queue and worker against a fake ATS over HTTP; the browser pass (Chrome against the same fake ATS) was done manually.
- **Upload type checking is by file extension plus NUL-byte detection** (`.csv` / `.json`, and any NUL byte means binary), not the `fileDetection` approach section 5 names.
- **Known limitation:** a posting whose content changes stays attached to the job it was first linked to; there is no cross-job re-linking, no fuzzy re-flagging on edit, and no unmerge UI (D36).
