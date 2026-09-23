# AI Career Intelligence & Application Platform

Personal AI career operating system: natural-language career goal → job
discovery/ranking → factual, ATS-oriented application generation →
human-approved submission → outcome tracking.

See `docs/architecture.md` for system design and `DECISIONS.md` for the
rationale behind each architectural choice.

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
8. Start the matching worker (needed for "Find Matches" runs):
   `pnpm --filter @ai-career/matching-worker start`. Also a plain Node
   process with no scheduler -- matching only ever runs when the `/matches`
   page's "Find Matches" button enqueues it. Run exactly one worker process
   (concurrency is 1 either way).

After adding new migrations, migrate the *test* database once before running
the whole suite:
`MIGRATIONS_DATABASE_URL=postgres://career_intel:career_intel@localhost:5432/career_intel_test pnpm --filter @ai-career/db db:migrate`.
(Suites that start together on an empty database can collide creating the same
enum; CI does this step first for the same reason, see `DECISIONS.md` D38.)

## End-to-end smoke test (optional)

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
