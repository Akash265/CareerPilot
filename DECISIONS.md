# DECISIONS.md — Rationale Log

Append-only log of meaningful decisions made while designing/building the AI Career Intelligence & Application Platform. Each entry: what was decided, alternatives considered, why this one, and what it affects.

---

## 2026-09-06 — Foundational architecture decisions

### D1. Single-user, not multi-tenant SaaS
**Decision:** The platform is a personal tool for one user, not a multi-account product.
**Alternatives considered:** Full multi-tenant SaaS with signup flow.
**Why:** The spec repeatedly frames this as a "personal AI career operating system." Building multi-tenant auth (signup, password reset, session management, per-tenant billing) is weeks of work that delivers zero product value for a single user, and directly contradicts CLAUDE.md's "avoid unnecessary abstractions" / "avoid premature microservices" guidance.
**What it affects:** Auth strategy (D2), data model (every table still gets `user_id`, see D2), and scope of Phase 1.

### D2. `user_id` column + native PostgreSQL Row-Level Security, auth bypassed for local use
**Decision:** Every user-scoped table carries a `user_id UUID` column, defaulting to a fixed local UUID (`00000000-0000-0000-0000-000000000001`) via `DEFAULT_USER_ID` env var. RLS policies are written as standard SQL (`CREATE POLICY ... USING (user_id = current_setting('app.current_user_id')::UUID)`), enabled with `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
**Alternatives considered:** (a) No `user_id` at all, hardcode single-user assumptions everywhere. (b) Supabase-specific RLS tied to `auth.uid()`.
**Why:** RLS is a native PostgreSQL feature, not a Supabase product — the same policies and `SET app.current_user_id = ...` pattern work identically on local Docker Postgres and Supabase Postgres. This keeps the door open for a second account later without a schema migration, costs nothing today, and keeps the "runs entirely local/OSS" story honest — no feature is silently cloud-only.
**What it affects:** Every table definition; the API layer must `SET app.current_user_id` per request (trivial for single-user, becomes the auth hook if ever multi-tenant).

### D3. Job data sourcing: allowlisted channels only, with explicit consent gate
**Decision:** Ingestion is restricted to: official ATS/job-board APIs (Greenhouse, Lever, Ashby, etc.), RSS/XML feeds, user-provided file uploads (CSV/JSON exports), and Apify actors. A setup-wizard checkbox requires the user to confirm they've reviewed the ToS of each source before it's enabled. A `LEGAL.md` in the repo root states the tool is for use with permitted/authorized sources only.
**Alternatives considered:** Open-ended HTML scraping of arbitrary career pages.
**Why:** Open scraping against arbitrary ToS is a legal liability and an OSS-portfolio red flag. The user has confirmed they hold the necessary permissions for their intended sources ("mostly all of them") — the consent gate and `LEGAL.md` exist so the *system* enforces a check rather than assuming permission is permanent or automatically applies to sources added later.
**What it affects:** Phase 4 (Job Intelligence) scope; ingestion adapter design (each source is a pluggable adapter, not a generic scraper).

### D4. Browser automation downgraded from "autofill" to "Auto-Prep"
**Decision:** For the MVP and beyond, the browser-automation worker does not attempt full DOM autofill against live ATS forms. Instead it generates a structured, pre-mapped application payload (candidate fields mapped to known Workday/Lever/Greenhouse schemas) and surfaces it via clipboard/extension-assisted paste. Per-ATS adapters are versioned plugins (e.g. `adapter-workday-v1.2.3`) with a selector health-check that detects breakage and falls back to manual mode rather than silently mis-filling a field.
**Alternatives considered:** Full Playwright DOM automation with hardcoded selectors per ATS.
**Why:** ATS vendors change DOM structure frequently; hardcoded selectors break silently and risk filling the wrong field with the wrong value (e.g. name into a salary box) with no error surfaced. Payload-generation + assisted paste gets the same time-saving value without the fragility, and versioned adapters let selector fixes ship independently of core logic.
**What it affects:** Phase 8 scope; `automation_sessions` table stores payload + detected/filled-field state rather than raw automation logs; the "stop before submit" invariant still holds, is just enforced structurally (a human pastes it) rather than by a pause step in a DOM script.

### D5. Hallucination guardrail: two-stage verification, not prompt instruction
**Decision:** Every resume-optimizer edit is verified in two stages before acceptance: (1) cosine similarity between `new_text` and its cited `source_fact` embedding must exceed 0.85 (cheap gate, filters unrelated fabrications); (2) a structured NLI-style entailment check via a fast/cheap model — `{entailment: ENTAIL|CONTRADICT|NEUTRAL, contradicting_span}` — must return ENTAIL or NEUTRAL. CONTRADICT is a hard reject.
**Alternatives considered:** Cosine-similarity-only gate. Prompt-only instruction ("don't hallucinate").
**Why:** Cosine similarity measures semantic closeness, not factual entailment — "3 years of Power BI" and "5 years of Tableau" are semantically close (both BI-tool statements) but factually contradictory, so a similarity-only gate would pass this hallucination. A dedicated entailment check catches contradiction that similarity alone misses. Prompt-only instructions are not verifiable and were rejected outright per CLAUDE.md §6 (AI outputs must be structured and validated, not linguistically trusted).
**What it affects:** New ingestion requirement — the candidate profile must be embedded at sentence/bullet granularity into a `profile_facts` table (each bullet = one row, one embedding), not as a single resume-level embedding. This is a schema and ingestion-pipeline change beyond what the original spec's `resume_optimizations` table implies.

### D6. Salary/location parsing is fully deterministic — LLM never touches numbers
**Decision:** Salary extraction uses a rule-based pipeline (regex for numeric+currency patterns, a currency-code library for symbol/ISO mapping, range parsing, normalization to a base currency) with raw + normalized min/max stored. Unparseable values are flagged `is_parsed: false` and surfaced for manual input — never guessed by an LLM, and never defaulted to zero.
**Alternatives considered:** LLM-based extraction from job description text.
**Why:** Numeric hallucination on salary is a correctness failure with real financial consequences for the user (e.g. silently misreading a floor). Deterministic parsing is auditable and either succeeds or explicitly fails; an LLM guess would fail silently and confidently.
**What it affects:** Phase 4/15 ingestion pipeline; `jobs` table needs both `salary_raw` and `salary_normalized_{min,max,currency}` fields plus `is_parsed`.

### D7. LLM provider: Anthropic (generation) + Voyage AI (embeddings), swappable
**Decision:** All generative LLM calls (goal parsing, match reasoning, resume optimization, entailment checks, pitch generation) use Anthropic models, selected by **role/tier** (fast-cheap vs. deep-reasoning) via env var rather than a hardcoded model version string. Embeddings (required for pgvector semantic search — Anthropic has no embeddings endpoint) default to Voyage AI, with an `EMBEDDING_PROVIDER` env var allowing a swap to a self-hosted BGE/E5 model for fully offline/OSS-purist use.
**Alternatives considered:** OpenAI embeddings (rejected — mixes vendor ecosystems unnecessarily once Anthropic-only was chosen for generation). OpenRouter as a cost-control middleman (rejected — adds a vendor for no benefit once committed to two direct providers). Hardcoding specific model version strings (rejected — ages out as new model generations ship).
**Why:** Keeps the vendor surface to two providers (Anthropic + Voyage, both part of the same ecosystem) instead of three. Role-based model selection (not a pinned version) keeps the architecture doc and code from going stale every time a new model generation ships.
**What it affects:** `ai` package adapter design; cost-tracking/Langfuse configuration; `EMBEDDING_PROVIDER` becomes a first-class local-dev toggle alongside the Docker Compose setup.

### D8. Cost control: deterministic-first triage + 3-layer caching + hard budget ceiling
**Decision:** Model/compute selection by task: eligibility filtering is pure deterministic code (no LLM); matching/ranking uses cached embeddings only; match explanations use a fast/cheap model tier; resume rewriting and entailment checks use a deep-reasoning tier, triggered only on explicit user action ("Prepare this job"), never proactively for the whole feed. Three cache layers: embeddings (permanent, keyed on content hash), match-reason (7-day TTL, keyed on job+resume-version), and the optimized resume itself (generated lazily, once, per shortlist action). A monthly spend ceiling is enforced via Langfuse alerting against direct Anthropic + Voyage usage.
**Alternatives considered:** Generating explanations/optimized resumes proactively for every ranked job.
**Why:** Proactive generation across a large job feed multiplies expensive-tier LLM calls by feed size; lazy/on-demand generation ties spend to actual user intent (shortlisting), which is the only point the expensive output is needed.
**What it affects:** Worker design (resume-generation worker triggers on a shortlist event, not an ingestion event); `resume_optimizations`/`ats_evaluations` rows are created on-demand, not batch-precomputed.

### D9. PII log-scrubbing: exact-match on known profile values, not NER/regex heuristics
**Decision:** The logging middleware redacts log output by exact (case-insensitive) substring match against the current user's known profile values — `full_name`, `email`, `phone_number`, `address_line1`, `linkedin_url` — replacing matches with `[REDACTED]`. No NER model or generic PII-detection regex is used.
**Alternatives considered:** spaCy/NER-based generic PII detection; generic regex heuristics for names.
**Why:** Names have no reliable pattern for regex, and NER both misses variants ("Jon" vs. "Jonathan") and false-positives on company/job names. Because this is single-user, the exact values needing redaction are already known from the database — exact-match substring replacement is 100% reliable for those specific values, requires no ML dependency, and updates automatically if the user edits their profile.
**What it affects:** API logging middleware design; does not generalize if the project ever becomes multi-tenant (would need a redaction list per active request context instead of a single global one — noted here so it isn't forgotten if D1 is revisited).

### D10. Package manager/runtime: pnpm workspaces + Node 22.x LTS
**Decision:** The monorepo uses pnpm workspaces (`pnpm-workspace.yaml` covering `apps/*` and `packages/*`) with Turborepo for task orchestration, pinned to Node 22.x LTS via `.nvmrc` and each `package.json`'s `"engines": { "node": ">=22.0.0" }`.
**Alternatives considered:** npm workspaces; Yarn (classic or Berry) workspaces. Other Node LTS lines (18.x, 20.x).
**Why:** pnpm's content-addressable store and strict node_modules symlinking give faster installs and catch phantom-dependency bugs (a package using a dependency it never declared) that npm/Yarn's flatter hoisting allows — valuable once the workspace has several internal packages depending on each other (`@ai-career/config`, `@ai-career/db`, etc.). Node 22.x was the current LTS at project start, so it maximizes support runway without adopting an unreleased/odd-numbered line.
**What it affects:** Root `package.json` (`packageManager`, workspace scripts), `pnpm-workspace.yaml`, `turbo.json` task graph, every workspace package's `package.json` (`engines` field, `workspace:*` internal dependency references), and `.nvmrc`.

### D11. `@types/node` added as a devDependency of `packages/config`
**Decision:** `packages/config` depends on `@types/node` (devDependency only) so that `process.env` in `env.ts`'s default parameter resolves to a known type.
**Alternatives considered:** None viable — TypeScript ships no built-in ambient declarations for Node globals (`process`, `Buffer`, etc.); without `@types/node`, `tsc` fails outright with `Cannot find name 'process'` (not a `strict`-mode-specific error, a hard compile error under any mode).
**Why:** `loadEnv`'s default parameter (`source: Record<string, string | undefined> = process.env`) requires `process` to be typed for the package to compile at all. This is the only way to type Node globals in TypeScript.
**What it affects:** `packages/config` only, as a devDependency — it does not leak into the package's public type surface, since `loadEnv`'s exported signature is typed as `Record<string, string | undefined>`, not `NodeJS.ProcessEnv`.

---

*Entries are appended chronologically. Do not edit or delete past entries when a decision is later reversed — add a new entry that supersedes it and cross-reference the original.*
