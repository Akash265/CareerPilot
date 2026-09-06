# Architecture — AI Career Intelligence & Application Platform

Status: **design finalized, no application code written yet.** This document describes the agreed architecture as of 2026-09-06. See `DECISIONS.md` for the rationale behind each choice. Update this file as implementation reveals deviations — it must describe what's actually built, not an aspiration.

## 1. Product framing

Single-user personal tool ([D1](../DECISIONS.md)). Not a job board, not multi-tenant SaaS. Core loop: candidate profile + natural-language career goal → job discovery/ranking → factual, evidence-bound application generation → human-approved submission → outcome tracking → improved future ranking.

## 2. System diagram

```
USER
 │
 ▼
NEXT.JS WEB APP (TypeScript, Tailwind, shadcn/ui)
 │
 ▼
API / DOMAIN SERVICES (business logic lives here — workers only execute)
 ├─ Candidate Profile          ├─ Resume Optimization
 ├─ Career Goal Parser         ├─ ATS Evaluation
 ├─ Job Intelligence           ├─ Application Tracker
 ├─ Matching Engine            └─ Browser Automation Control (Auto-Prep)
 │
 ▼
POSTGRESQL + pgvector + pg_trgm     (RLS-enabled, user_id-scoped — D2)
 ├─ structured data
 ├─ full-text / trigram lexical search
 └─ vector embeddings (profile_facts, jobs)
 │
 ▼
REDIS + BULLMQ
 ├─ job ingestion workers        ├─ evaluation workers
 ├─ resume generation workers    └─ browser automation (Auto-Prep) workers
 │
 ▼
MINIO (local) / R2 (optional cloud) — encrypted object storage
 │
 ▼
ANTHROPIC (generation) + VOYAGE AI (embeddings)   — D7
 │
 ▼
LANGFUSE — observability + cost/budget alerting   — D8
```

## 3. Data sourcing boundary ([D3](../DECISIONS.md))

Ingestion adapters are pluggable, one per source type:
- Official ATS/job-board APIs (Greenhouse, Lever, Ashby, …)
- RSS/XML career-page feeds
- User-uploaded files (CSV/JSON exports)
- Apify actors

Each source must be explicitly enabled via a consent checkbox ("I confirm I have reviewed the ToS of my data sources and am legally permitted to ingest them") before its adapter runs. `LEGAL.md` at repo root documents this boundary. No generic/open-ended HTML scraper exists in this system.

## 4. Matching pipeline

```
Career Goal + Candidate Profile
        │
        ▼
Deterministic Eligibility Filter   (disallowed countries, hard experience mismatch,
        │                           already-applied/dismissed, onsite-when-remote-required)
        ▼
Full-Text/Trigram Retrieval  +  pgvector Semantic Retrieval  (hybrid — neither alone is sufficient)
        │
        ▼
Weighted Hybrid Candidate Set
        │
        ▼
AI Match Reasoning   (fast/cheap model tier — explanation only, not filtering)
        │
        ▼
Final Personalized Ranking + Explanation
```

Ranking weights (initial, tunable, see spec §8): skills/requirements 30%, experience 15%, location/work mode 15%, sponsorship 10%, role preference 10%, salary 5%, industry/company 5%, freshness 5%, semantic fit 5%.

Salary and location values entering this pipeline are always deterministically parsed ([D6](../DECISIONS.md)) — the LLM never extracts or estimates numeric salary data.

## 5. Application generation & hallucination guardrail ([D5](../DECISIONS.md))

```
profile_facts (one row per resume bullet/fact, each with its own embedding)
        │
        ▼
Resume Optimizer proposes: { new_text, source_fact, source_embedding_id }
        │
        ▼
Stage 1 — cosine_similarity(new_text, source_fact) > 0.85 ?  ──No──▶ reject
        │ Yes
        ▼
Stage 2 — NLI entailment check (fast model):
          { entailment: ENTAIL | CONTRADICT | NEUTRAL, contradicting_span }
        │
   CONTRADICT ──▶ reject
        │ ENTAIL or NEUTRAL
        ▼
Accepted change (NEUTRAL results are flagged requires_review: true)
```

Output structured per spec §11 (`modified_bullet_points`, `added_terms`, `justifications`, `unsupported_claims_detected`, `requires_review`), validated with Zod.

ATS/Machine Readability evaluation runs after optimization, scoring keyword coverage, required-skill coverage, semantic similarity, action-verb quality, format readability, experience alignment, factual consistency — reported transparently as an internal signal, never claimed as a guarantee of real-world ATS behavior (spec §10.2).

## 6. Application automation — "Auto-Prep", not autofill ([D4](../DECISIONS.md))

```
Prepare → Generate Resume + Pitch → Build structured application payload
   (candidate fields mapped to Workday/Lever/Greenhouse schema)
        ↓
Open Application Portal
        ↓
Per-ATS adapter (versioned plugin) attempts field mapping + runs selector health-check
        ↓
   Healthy? ──No──▶ fall back to manual mode, flag for user, log which fields are unmapped
        │ Yes
        ▼
Assisted paste (clipboard / extension helper) — never a silent auto-submit
        ↓
USER REVIEWS AND CLICKS FINAL SUBMIT MANUALLY
```

The "stop before submit" invariant (spec §4, §13) is structural here — a human performs the paste and the click — not merely a pause step inside a DOM automation script.

## 7. AI/model layer ([D7](../DECISIONS.md), [D8](../DECISIONS.md))

Task-to-tier mapping (model **version resolved by role via env var, not hardcoded**):

| Task | Approach | Tier |
|---|---|---|
| Eligibility filtering | Deterministic code | none |
| Matching / ranking | Voyage embeddings + pgvector | cached permanently |
| Match explanation | Anthropic, fast/cheap tier | on ranking |
| Resume optimization + entailment check | Anthropic, deep-reasoning tier | on-demand (shortlist action) |
| Hiring Manager Pitch | Anthropic, fast/cheap tier | on-demand (shortlist action) |

Caching: embedding cache (permanent, content-hash keyed), match-reason cache (7-day TTL, job+resume-version keyed), optimized resume/pitch (generated once, lazily, only when the user acts). Monthly spend ceiling enforced via Langfuse alerting.

`EMBEDDING_PROVIDER` env var: `voyage` (default) or a self-hosted BGE/E5 endpoint for fully offline operation.

## 8. Data model additions beyond spec §19

- `profile_facts` — sentence/bullet-level candidate facts, each with its own embedding. Required by the entailment guardrail ([D5](../DECISIONS.md)); not present in the original spec, which only implied resume-level embedding.
- All tables carry `user_id UUID` with RLS policies ([D2](../DECISIONS.md)), defaulting to a fixed local UUID via `DEFAULT_USER_ID`.
- `jobs` salary fields: `salary_raw`, `salary_normalized_min`, `salary_normalized_max`, `salary_currency`, `is_parsed` ([D6](../DECISIONS.md)).
- `automation_sessions` stores the generated payload and per-field mapped/unmapped state rather than raw DOM-automation logs ([D4](../DECISIONS.md)).

Everything else (career_goals, career_goal_constraints, job_requirements, resume_optimizations, ats_evaluations, application_pitches, application_outcomes, learning_features, plus the original core tables) follows spec §19 as written.

## 9. Security & privacy

- Uploaded files: scanned/stripped of macros and EXIF, renamed with UUID, stored encrypted (MinIO local / R2 optional).
- Log scrubbing: exact-match substring redaction of known profile values ([D9](../DECISIONS.md)) — no NER/generic-regex PII detection.
- Retention: resume text and generated documents auto-deleted 30 days after an application reaches a terminal status (Rejected/Hired).
- Structured logging only; no resume/profile content in production logs regardless of scrubbing (defense in depth).

## 10. What's still open

- Confirm `EMBEDDING_PROVIDER=voyage` as the actual default vs. self-hosted BGE for the first implementation pass (leaning Voyage per [D7](../DECISIONS.md); revisit only if offline operation becomes a near-term requirement).
- Concrete job-identity/dedup algorithm (fuzzy-match thresholds, conflict resolution when sources disagree on a field) is not yet specified — needed before Phase 4 implementation, not before.
