# Phase 12 — Broad Job Discovery: Design

Status: Draft for user review (2026-10-07). Combined spec + task list, like Phase 11c–11d. Decisions start at D184.

## 1. Goal and user choices (2026-10-07)

Today the user must add every company board by hand, so the app only knows the companies the user already thought of. The user wants the app to **explore all available opportunities** and confirmed they hold the required permissions. Chosen sources:

1. **Goal-driven search APIs** — queried automatically from the confirmed career goal.
2. **More ATS platforms** — alongside Greenhouse and Lever.
3. **Automatic company discovery** — boards found and enabled without manual entry.

Not in scope: Apify / LinkedIn / Indeed / Glassdoor, and any scraping that circumvents bot protection, logins or CAPTCHAs.

## 2. Verified endpoints (probed live on 2026-10-07)

| Provider | Kind | Endpoint | Auth | Probe |
|---|---|---|---|---|
| Ashby | ATS board | `GET api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` | none | 200 |
| Workable | ATS board | `GET apply.workable.com/api/v1/widget/accounts/{slug}` | none | 200 |
| SmartRecruiters | ATS board | `GET api.smartrecruiters.com/v1/companies/{slug}/postings` (+ `/postings/{id}` for the description) | none | 200 |
| Recruitee | ATS board | `GET {slug}.recruitee.com/api/offers/` | none | 200 |
| Adzuna | search | `GET api.adzuna.com/v1/api/jobs/{country}/search/{page}?app_id&app_key&what&where&max_days_old&results_per_page` | free key | 400 without key (expected) |
| Jooble | search | `POST jooble.org/api/{key}` `{ keywords, location, page }` | free key (form) | not callable without key; shape from Jooble's help centre |
| USAJobs | search | `GET data.usajobs.gov/api/Search?Keyword&LocationName&DatePosted&Page&ResultsPerPage` + headers `Authorization-Key`, `User-Agent` (email) | free key | 401 without key (expected) |
| The Muse | search | `GET www.themuse.com/api/public/jobs?page&category&location` | none (key optional) | 200 |
| Remotive | search | `GET remotive.com/api/remote-jobs?search&limit` | none | 200 |
| RemoteOK | feed | `GET remoteok.com/api` (terms: link back to Remote OK, credit it) | none | 200 |
| Arbeitnow | feed | `GET www.arbeitnow.com/api/job-board-api?page` | none | 200 |
| HN "Who is hiring" | feed | `GET hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring` then the thread's comments | none | 200 |

Every base URL is an operator-controlled env var (`*_API_BASE`, like `GREENHOUSE_API_BASE`), so tests and E2E use local stand-ins.

## 3. Design

### 3.1 New source kinds
`job_source_kind` gains `ashby`, `workable`, `smartrecruiters`, `recruitee` (board kinds, `config.slug`) and `adzuna`, `jooble`, `usajobs`, `themuse`, `remotive`, `remoteok`, `arbeitnow`, `hn_hiring` (search kinds). Each is a `SourceAdapter` in `packages/ingestion/src/adapters/`, with a Zod schema for its payload in `sourceSchemas.ts` and a field mapping in `normalizeRecord`, so everything downstream (raw-first storage, normalization, 3-tier dedup, matching) is unchanged. Untrusted-content rules (NUL/surrogate choke point, length caps, HTML stripping) apply as for today's adapters.

### 3.2 Goal-driven search
A search source has no stored query: at fetch time the adapter reads the **active confirmed career goal** and builds queries from `targetRoles` (≤ 5) × `locations` (≤ 5; remote-only goals use the provider's remote filter), posted within `DISCOVERY_MAX_DAYS_OLD` (default 30), at most `DISCOVERY_MAX_PAGES` (default 2) pages each. No confirmed goal → the run records `no_active_goal` and fetches nothing. Search sources are created automatically, one per provider, when the user enables it on `/sources`. A provider whose key is not configured shows "key missing" and cannot be enabled. Adzuna countries come from `ADZUNA_COUNTRIES` (default `us,gb`) unless the goal's locations name a supported country.

Search results include postings whose source closes or hides them later; they follow the existing close-on-missing rule per source.

### 3.3 Automatic company discovery
After every successful ingestion run, `discoverBoards` scans that run's new postings — the apply / redirect URL and the description text — for ATS board URLs (`boards.greenhouse.io/{slug}`, `job-boards.greenhouse.io/{slug}`, `jobs.lever.co/{slug}`, `jobs.ashbyhq.com/{slug}`, `apply.workable.com/{slug}`, `jobs.smartrecruiters.com/{slug}`, `{slug}.recruitee.com`). New slugs are recorded in `discovered_boards` (`kind`, `slug`, `first_seen_from` source, `status`). A candidate is **validated** by one fetch of its board (exists, at least one open job), then created as a `job_sources` row with `origin = 'discovered'`, enabled, consent copied from the standing consent below. Limits: `DISCOVERY_MAX_SOURCES` total discovered sources (default 300), `DISCOVERY_MAX_NEW_PER_RUN` (default 25). The HN "Who is hiring" feed is the richest seed (hundreds of companies a month, many on these ATSs).

The user can also **paste a list of board URLs** on `/sources` (bulk import) — same validation path.

### 3.4 Consent (amends D3)
D3's per-source consent stays for manual sources. Discovery adds one **standing consent**: a checkbox on `/sources` — "I have permission to collect job postings from the providers I enable and the boards discovered from them" — stored with its timestamp in a new `discovery_settings` row (`auto_discover`, `consented_at`). Without it nothing in this phase runs. Every discovered/search source records `consent_confirmed_at` = that timestamp and `origin`, so the audit trail stays per source. Turning discovery off disables every discovered source (data kept).

### 3.5 Politeness and failure
One ingestion worker, concurrency 1 (unchanged). Per-host spacing `DISCOVERY_MIN_INTERVAL_MS` (default 1000) between requests, `Retry-After` honoured on 429, existing retry/backoff for 5xx. A board that 404s twice is marked `gone` and disabled. RemoteOK and others that ask for attribution: the job page already links to the original posting; the source label shows the provider name.

### 3.6 Volume
Matching evaluates every open job; embeddings are cached per description hash (voyage-3.5 at $0.06 per million tokens and roughly 500–800 tokens a job: about $0.03–0.05 per 1,000 new jobs), and explanations stay limited to the top `MATCHING_EXPLAIN_TOP_N`. Expected scale: thousands to low tens of thousands of open jobs — within today's design. `/sources` shows per-source job counts and the discovery totals.

### 3.7 UI (`/sources`)
A "Discovery" panel: standing-consent checkbox; one toggle per search provider (with key status); auto-discover toggle with counts (discovered, validated, enabled, gone); bulk-import textarea; the discovered boards listed with their origin. Manual sources unchanged.

## 4. Tasks (TDD; each ends green: lint 0 warnings, typecheck, build, affected tests)
1. Schema: enum values, `job_sources.origin`, `discovered_boards`, `discovery_settings` (+ RLS, FK indexes, migration via drizzle-kit); env vars (`*_API_BASE`, keys, `DISCOVERY_*`, `ADZUNA_COUNTRIES`).
2. ATS board adapters: Ashby, Workable, SmartRecruiters, Recruitee — schemas, adapters, normalization, recorded-fixture tests.
3. Search adapters: Remotive, RemoteOK, Arbeitnow, The Muse, HN Who's Hiring (no key).
4. Search adapters with keys: Adzuna, Jooble, USAJobs; goal-driven query builder.
5. Politeness: per-host spacing, 429 handling, `gone` detection.
6. `discoverBoards` + validation + bulk import; worker hook after each run.
7. API: discovery settings, provider toggles, bulk import, discovered list; rate limits (*jobs* bucket).
8. UI: Discovery panel on `/sources`.
9. E2E: stand-ins for the new endpoints; smoke extended (enable a provider → jobs ingested → a board discovered from a posting link → auto-created and fetched → matched).
10. Docs (README, development, api, architecture §24, FLOW §19, DECISIONS), full verification, fresh final review, fix pass, merge, push.

## 5. Risks / known gaps
- Provider terms vary (attribution, rate limits); the user has confirmed permission — the app records consent but does not enforce third-party terms beyond politeness.
- Jooble's request shape is from its help centre and secondary sources; it is only verified against a live key once the user adds one.
- Discovery quality depends on links appearing in postings; companies on other ATSs (Workday, iCIMS, Taleo) are not discovered — those need separate adapters later.
- Aggregator postings duplicate board postings; the existing 3-tier identity merges exact/fingerprint matches and flags fuzzy ones.
