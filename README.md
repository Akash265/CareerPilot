# AI Career Intelligence & Application Platform

Personal AI career operating system: natural-language career goal → job
discovery/ranking → factual, ATS-oriented application generation →
human-approved submission → outcome tracking.

See `docs/architecture.md` for system design and `DECISIONS.md` for the
rationale behind each architectural choice.

## Run everything with one command

Once `.env` exists (step 1 below), start the whole application with:

```bash
./scripts/start.sh        # or: pnpm start
```

It starts Docker Desktop if needed, brings up Postgres/Redis/MinIO, installs dependencies, applies migrations,
builds the web app (cached when nothing changed), starts the LaTeX compiler, the web app and the four workers
(ingestion, matching, maintenance, browser autofill — skipped with a warning if Chrome is missing), waits for the
health check and opens http://127.0.0.1:3000. On its first run it adds `LATEX_COMPILER_URL` and a random
`LATEX_COMPILER_TOKEN` to `.env`; nothing else in `.env` is changed. Each piece logs to `logs/<name>.log`.

**Ctrl-C (or closing the terminal window) stops everything**: the web app, the workers, the compiler and the
Postgres/Redis/MinIO containers. Your data is kept. It refuses to start if port 3000 is taken or a worker is already
running elsewhere, and if any piece dies it names it, shows the end of its log and stops the rest. Note: stopping in
the middle of a job fetch or a match run (each start triggers both) cuts that run off; the job is re-run on the next
start, but its run record stays "running", which can make "Find matching jobs" wait up to about 10 minutes.

The steps below do the same by hand.

## Quick Start (local, no paid services required)

1. Copy env template: `cp .env.example .env`. Two DB URLs are required, per
   the two-role Postgres convention (see `DECISIONS.md` D12):
   - `DATABASE_URL` — the least-privilege `career_intel_app` role, used by
     app runtime code so RLS is actually enforced.
   - `MIGRATIONS_DATABASE_URL` — the superuser `career_intel` role, used only
     by `drizzle-kit generate`/`migrate` (schema DDL needs RLS-bypass).

   Leave `ANTHROPIC_API_KEY` / `VOYAGE_API_KEY` as placeholders until you
   reach a phase that actually calls them — not needed for Phase 0/1.
2. Start infrastructure: `cd infra && docker compose up -d` (Postgres +
   pgvector, Redis, MinIO).
3. Install dependencies: `pnpm install` (from repo root).
4. Run database migrations: `pnpm --filter @ai-career/db db:migrate`.
5. Start the web app: `pnpm dev` (or `pnpm --filter web dev` to run just the
   Next.js app).
6. Verify: `curl http://localhost:3000/api/health` should return
   `{"status":"ok","checks":{"database":true,"redis":true}}`.
7. Start the ingestion worker (needed for scheduled and "Run now" fetches):
   `pnpm --filter @ai-career/job-ingestion start`. It is a plain Node process
   (there is no Dockerfile or compose service for it yet). Enabling a source
   on the Sources page makes the worker's reconcile tick (within about a
   minute) start that source's first fetch automatically; after that the
   source is fetched every `INGEST_INTERVAL_MINUTES` (default 360). Run
   exactly one worker process; two would race on the same source (an advisory
   lock per source is future work).
   The same process also runs the Phase 13a search-run coordinator (queue
   `search-runs`) that the "Find matching jobs" button on `/matches` starts; if
   it is not running, a click stays `queued` and the page says so after 30 s.
8. Start the matching worker (needed for "Find Matches" runs):
   `pnpm --filter @ai-career/matching-worker start`. Also a plain Node
   process with no scheduler. Matching runs when "Find matching jobs" (after
   refreshing sources) or "Find Matches" on `/matches` requests it, and an
   ingestion run that changed jobs triggers a debounced re-match
   (`MATCH_DEBOUNCE_SECONDS`, with a follow-up flag if a run is in progress);
   this worker must be running for either. Run exactly one worker process
   (concurrency is 1 either way).
9. Start the maintenance worker (needed for the Phase 9 retention sweep to
   run on its own): `pnpm --filter @ai-career/maintenance-worker start`, or
   in Docker with `docker compose -f infra/docker-compose.yml --profile workers
   up -d --build` (opt-in profile; plain `up -d` still starts only the infra;
   the container reads the repo's `.env` and reaches Postgres/Redis/MinIO by
   service name). It upserts a daily BullMQ scheduler on boot (the first run
   fires immediately) and then deletes generated
   documents for applications that have been in a terminal status
   (accepted/declined/rejected/withdrawn/no_response) for `RETENTION_DAYS`
   (default 30; `0` disables it). To run the sweep once by hand -- e.g. right
   after backdating a `terminal_at` for testing -- use
   `pnpm retention:run` instead of starting the worker; it runs the exact
   same code path a single time and exits. Inside Docker the equivalent is
   `docker compose -f infra/docker-compose.yml --profile workers run --rm
   maintenance-worker node_modules/.bin/tsx src/runOnce.ts`.

10. **Browser autofill (Phase 8)**, needed for the "Open & autofill
    application" button on a match page to do anything:
    - **Prerequisite:** Google Chrome must be installed on this machine (the
      worker launches it with Playwright's `channel: "chrome"`; it does not
      download its own browser). Set `BROWSER_EXECUTABLE_PATH` in `.env` to
      point at a specific Chrome binary instead, if needed.
    - Run `pnpm --filter @ai-career/db db:migrate` first if you haven't
      already (migrations `0026`/`0027` add the `automation_sessions`
      table).
    - Start the worker **on the host, not in Docker**: `pnpm --filter
      @ai-career/browser-worker start`. It needs a real desktop to open a
      headed Chrome window, which a container does not have — there is no
      Dockerfile or compose service for it. Run exactly one worker process
      (concurrency is 1 either way, and the DB also only allows one active
      session per user at a time).
    - What it does: opens the job's Greenhouse or Lever hosted application
      form in Chrome, fills your name, email, phone, LinkedIn, location,
      attaches your exported resume (and cover letter, on Greenhouse), and
      — only where the question is a plain yes/no, never a dropdown/combobox
      widget or worded with a "without"/"not"/"don't"-style negation — visa
      sponsorship and expected salary. GitHub/portfolio links, work
      authorization, EEO/demographic questions and anything it doesn't
      recognize are left for you, shown in the panel's field audit.
    - The resume and cover letter are uploaded under fixed file names
      (`resume.pdf`, `cover_letter.pdf`) regardless of what you named them or
      how CareerPilot stores them internally — that's the file name the
      employer sees attached, and it's also why your own file name or any
      other local text never reaches the page.
    - **You always click Submit yourself.** The worker has no code path
      that can click, press a key, or submit a form — this is enforced by a
      test that scans the worker's source for exactly those calls, not just
      a convention.
    - Three env vars control it (all optional, see `.env.example`):
      `BROWSER_EXECUTABLE_PATH` (override the Chrome binary),
      `BROWSER_HEADLESS` (default `false` — headed, since a human needs to
      see and use the window; `true` is for tests only),
      `BROWSER_SESSION_TIMEOUT_MIN` (default 30 — how long an open window
      waits for you before the worker closes it).

10. Optional: the LaTeX compiler for the job-tailored one-page resume PDF
    (Phase 13c; the `.tex` download works without it). Set
    `LATEX_COMPILER_TOKEN` and `LATEX_COMPILER_URL` in `.env`, then
    `docker compose -f infra/docker-compose.yml --env-file .env --profile latex up -d latex-compiler`;
    see [docs/development.md](docs/development.md#tailored-latex-resume-phase-13c).

After adding new migrations, migrate the *test* database once before running
the whole suite:
`MIGRATIONS_DATABASE_URL=postgres://career_intel:career_intel@localhost:5432/career_intel_test pnpm --filter @ai-career/db db:migrate`.
(Suites that start together on an empty database can collide creating the same
enum; CI does this step first for the same reason, see `DECISIONS.md` D38.)

## End-to-end tests

`pnpm build && pnpm e2e` runs the browser smoke suite (`e2e/`) against the
test database — see [docs/development.md](docs/development.md#e2e-suite). It
is what CI runs. The older ingestion smoke below is kept for its fake ATS.

### Ingestion smoke (fake ATS)

`services/job-ingestion/e2e/smoke.ts` drives the real web app, queue and worker
against a fake ATS server (see its header comment). It expects a **fresh
database** (fixed board `fakeco`, absolute job counts), so point it at a scratch
database, never the dev database. Create one with the extensions and app-role
grants that `infra/postgres/init.sql` gives the dev database, then migrate it:

```bash
docker exec infra-postgres-1 psql -U career_intel -d postgres -c "CREATE DATABASE career_intel_e2e"
docker exec infra-postgres-1 psql -U career_intel -d career_intel_e2e \
  -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;" \
  -c "GRANT CONNECT ON DATABASE career_intel_e2e TO career_intel_app; GRANT USAGE ON SCHEMA public TO career_intel_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO career_intel_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO career_intel_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO career_intel_app;"
MIGRATIONS_DATABASE_URL=postgres://career_intel:career_intel@localhost:5432/career_intel_e2e pnpm --filter @ai-career/db db:migrate
export DATABASE_URL=postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_e2e
```

(`docker exec infra-postgres-1` assumes the compose project name `infra`;
check `docker ps` if yours differs.) Then, with that `DATABASE_URL` exported,
run these in four terminals from the repo root (a variable set before a
`dotenv`-wrapped script wins over the value in `.env`):

```bash
pnpm --filter @ai-career/job-ingestion e2e:fake-ats
GREENHOUSE_API_BASE=http://localhost:4011 LEVER_API_BASE=http://localhost:4011 pnpm --filter @ai-career/job-ingestion start
pnpm --filter web build && pnpm --filter web exec dotenv -e ../../.env -- next start -p 3100
WEB_URL=http://localhost:3100 pnpm --filter @ai-career/job-ingestion e2e:smoke
```

Every line should print `PASS`, ending with `All checks passed.`. Afterwards
stop the three processes, delete the `bull:job-ingestion*` keys it left in Redis
(delete exact keys; do not flush), and drop the scratch database.

## Status

Foundation phase (Phase 0/1) complete: monorepo, Docker Compose
infrastructure, validated env config, single-user RLS pattern, Next.js
shell, health-check route, CI.

Phase 2 (Candidate Profile) complete: resume upload (PDF/DOCX/LaTeX) to
MinIO, AI-assisted structured extraction with mandatory user review,
normalized candidate-profile schema, and profile_facts generation +
Voyage embeddings. Visit /profile after `pnpm dev` to use it.

Phase 3 (Career Goal Intelligence) complete: natural-language Career Goal
Statement parsing with mandatory user review, deterministic parsing of the
minimum and preferred salary, and versioned career_goal_constraints —
replacing the Phase 2 rigid-preference fields it superseded. After
`pnpm dev`, the home page links to both steps (/profile, /career-goal).

Phase 4 (Job Intelligence) complete: Greenhouse, Lever and CSV/JSON sources
behind a consent gate, a BullMQ ingestion worker, deterministic normalization
(salary, work mode, experience, sponsorship, posted date), three-tier
deduplication and a Sources page and read-only Jobs browser.

Phase 5 (Hybrid Matching) complete: deterministic eligibility filtering,
hybrid retrieval blending a JS-side lexical keyword hit-rate with pgvector
semantic similarity, nine weighted match factors with an explainable
per-factor breakdown, and AI
match reasoning (top-ranked jobs only, evidence-grounded, never given raw
job text) via a separate matching-worker. The home page links every step
(/profile, /career-goal, /sources, /jobs, /matches). Not built yet: an
`industry` field (industry matching is a company-name heuristic), and
auto-triggered recomputes.

Phase 6 (ATS Resume Optimization) complete: structured job-requirement
extraction cached per job (`job_requirements`), an evidence-bound resume
optimizer whose selected/reworded bullets must each trace back to a real
row in the candidate's own profile data (a deterministic guard, not the
model's self-report, is the sole authority), and a deterministic ATS
scorecard (`ats_evaluations`) covering keyword coverage, semantic
similarity, factual consistency and action-verb/readability heuristics.
Runs synchronously inside the API route -- no new worker. Available from
the "Optimize Resume" button on a job's match detail page
(`/matches/[jobId]`). `job_requirements` deliberately does not yet feed
Phase 5's matching factors (see docs/architecture.md §13).

Phase 7a (Company Research & Hiring Manager Pitch) complete: on an eligible
match, "Generate Pitch" researches the company with Anthropic web search
(only API-cited facts are kept; no personal data is sent), then writes a
three-bullet pitch whose every bullet must cite real evidence. Pitches are
versioned and editable. Requires `ANTHROPIC_MODEL_RESEARCH` in `.env`
(see `.env.example`).

**Upgrading an existing checkout:** `ANTHROPIC_MODEL_RESEARCH` is required
by `loadEnv` — without it, every web API route returns a 500 (the app itself
starts), and both workers and `db:migrate` fail to start. Add
`ANTHROPIC_MODEL_RESEARCH=claude-sonnet-5` to `.env`.

Phase 7b (Document Export) complete: on a match page, the selected optimized
resume or pitch version downloads as PDF or DOCX (single-column, ATS-readable,
Unicode font embedded). Files are stored in MinIO and listed under "Documents";
export is refused if your profile changed since the optimization or a generated
pitch still has an unsupported bullet.

Phase 7c (Cover Letter & Interview Preparation) complete: on an eligible match,
"Generate Cover Letter" writes an optional 4–5 paragraph letter whose
opening, company and evidence paragraphs must each cite real evidence
(versioned, editable, PDF/DOCX export), and "Generate Interview Prep" builds a
read-only, exportable pack of likely questions with answer outlines, honest
framings for required skills missing from your profile (the gap list is
computed deterministically, not by the model), company talking points and
questions to ask. Existing checkouts: run `pnpm --filter @ai-career/db
db:migrate` to add the two new tables.

Phase 9 (Application Tracker) complete: "Mark as applied" on any match
page (or "Add external application" on `/applications`) records which
resume/pitch/cover-letter versions you actually sent, a one-time snapshot of
the match/ATS scores at that moment, and puts the job on a `/applications`
tracker with a status timeline, follow-up dates, and a log of notes,
recruiter contact and interview events. An applied job leaves the ranked
`/matches` feed ("already applied") but its generated documents stay
viewable on `/matches/[jobId]` until retention deletes them; the
application's detail page lists the versions sent and links there.
Phase 8 (Browser Autofill) adds an automation session to that same tracker;
see "Browser autofill" below. Existing checkouts: run
`pnpm --filter @ai-career/db db:migrate` to add the two new tables, and see
below to run the retention sweep.

Phase 8 (Browser Autofill) complete: on a job sourced from Greenhouse or
Lever, "Open & autofill application" on the match page opens a real, headed
Chrome window on your computer, fills the fields it can identify with high
confidence (name, email, phone, LinkedIn, location, resume/cover-letter
attachments, and — only where the question is a plain yes/no, not a
dropdown widget — visa sponsorship and salary expectation), and shows a
field-by-field audit of what was filled, flagged for you, or intentionally
skipped (EEO/demographic questions, GitHub/portfolio links, work
authorization, anything it doesn't recognize). **You always review the
window and click Submit yourself — the worker has no code path that can
submit a form.** Once you've submitted (or decided not to), "Record as
applied?" on the panel creates the application entry with the same
resume/cover-letter versions the session attached, in one click.

Phase 10a (Outcome Analytics) complete: `/insights` shows how often your
applications get a response and an interview, overall and by role family,
company, work mode, match score, keyword coverage, posting age and the
documents you sent — each with its sample size and a likely range, and only
once a group has enough decided applications (`INSIGHTS_MIN_BUCKET`, default
5). Applications count as "no response" after `OUTCOME_UNDECIDED_DAYS`
(default 30) without activity. No AI calls; nothing changes your rankings
yet (that is Phase 10b).

Phase 10b (Personal Response Model) complete: on top of Phase 10a's labels,
a model learns from your own decided applications which match factors have
gone with getting a response, and shows "likely response X% (low–high%)"
on matches once you have at least 30 decided applications — at least 8 with
a response and 8 without (`OUTCOME_MODEL_MIN_DECIDED`/`OUTCOME_MODEL_MIN_PER_CLASS`,
both env-configurable) — and the model beats your average on a held-out
check. An opt-in "Rank with my history" toggle on `/matches` blends the
prediction into the ranking, at a weight that grows with your history but
never exceeds 50%. The model, its honesty check and which factors it found
are explained on `/insights`. No AI calls; the model is rebuilt from your
data on read and retrained only when that data or its settings change
(an in-process cache), never stored.

Phase 11a (AI Usage & Cost Control) complete: every Anthropic and Voyage call
is recorded (feature, model, tokens, estimated cost, outcome — never prompt
or response text) and checked against a monthly budget first.
`AI_MONTHLY_BUDGET_USD` (default $20; 0 = no ceiling) caps estimated spend
per UTC month: past it, new AI calls are blocked and AI actions say so until
the month resets or you raise the ceiling. `/usage` shows spend by feature
and model and recent failed or blocked calls; the home page flags the link
from `AI_BUDGET_WARN_PERCENT` (default 80%). Costs are estimates from a
built-in price table, not your invoice. Optionally set `LANGFUSE_HOST`,
`LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (all three) to also send that
metadata to Langfuse Cloud or a self-hosted Langfuse.

Phase 11b (Logging & Monitoring) complete: every process writes structured
JSON log lines through one logger that never prints an error's message and
redacts your own name, email, phone, address and LinkedIn URL (and any email
address) — set `LOG_LEVEL` to `debug`, `info` (default), `warn` or `error`.
An unexpected server error now answers "Something went wrong (request
<id>)" and the same id appears in the server log. `/status` shows whether
each worker is running, stopped or stale (no heartbeat for
`STATUS_STALE_AFTER_MS`, default 90 s; it must be longer than
`HEARTBEAT_INTERVAL_MS`, the 30 s beat) and what is waiting or failed in
each queue.

Phase 11c (Security Hardening) complete: the web app listens on 127.0.0.1
only (`APP_HOST`), refuses requests for unknown host names (`ALLOWED_HOSTS`) and
writes coming from other websites, and — if you set `APP_ACCESS_TOKEN` to open
it to your network — asks for that token once per browser at `/unlock`. Routes
that spend AI money or start background work are rate limited per minute
(`RATE_LIMIT_AI_PER_MINUTE`, default 10; `RATE_LIMIT_JOBS_PER_MINUTE`, default
20). Security headers are set, every foreign key is indexed, and the
dependency audit's critical and high findings are fixed. Run
`pnpm --filter @ai-career/db db:migrate` for migration `0030`.

Phase 11d (E2E & Docs) complete: `pnpm build && pnpm e2e` runs a headless
browser through the whole flow (unlock → profile → goal → jobs → matching →
application → status pages) against the test database with local stand-ins
for Anthropic and Voyage; CI is set up to run it on every push, after the tests. See
[docs/development.md](docs/development.md), [docs/api.md](docs/api.md) and
[docs/ai-system.md](docs/ai-system.md).

Phase 12 (Broad Job Discovery) complete: besides Greenhouse and Lever, you can
follow Ashby, Workable, SmartRecruiters and Recruitee boards. On `/sources`,
give permission once and switch on search providers — Remotive, Remote OK,
Arbeitnow, The Muse and HN "Who is hiring" need no key; Adzuna, Jooble and
USAJobs need free keys in `.env` — which are searched with your career goal's
roles and places. With automatic discovery on, company boards linked from
those postings are checked and added for you (up to 300), and you can paste
board links too. The ingestion worker must be running. Run
`pnpm --filter @ai-career/db db:migrate` for migrations `0031`–`0032`.
