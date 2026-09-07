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

## Status

Foundation phase (Phase 0/1) complete: monorepo, Docker Compose
infrastructure, validated env config, single-user RLS pattern, Next.js
shell, health-check route, CI. No product features implemented yet.

Phase 2 (Candidate Profile) complete: resume upload (PDF/DOCX/LaTeX) to
MinIO, AI-assisted structured extraction with mandatory user review,
normalized candidate-profile schema, and profile_facts generation +
Voyage embeddings. Visit /profile after `pnpm dev` to use it.
