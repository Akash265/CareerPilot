# Phase 4 — Job Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest jobs from Greenhouse, Lever and uploaded CSV/JSON files into a deduplicated, normalized `jobs` store (salary, work mode, minimum experience, sponsorship signal, posted date), run by a separate BullMQ worker, with a Sources page and a read-only Jobs browser.

**Architecture:** A new pure-logic package `packages/ingestion` (adapters, `normalizeRecord`, identity/merge, and the DB pipeline) is driven by a thin BullMQ process `services/job-ingestion`. The pipeline is raw-first: fetch → store raw → normalize (pure, rules only, no LLM) → identify (exact key / fingerprint auto-merge / trigram flagged, never auto-merged) → upsert per-source `job_postings` → recompute the canonical `jobs` row with a pure `mergePostings`. The web app manages sources, enqueues runs, and reads jobs.

**Tech Stack:** TypeScript (strict, ESM), pnpm + Turborepo, Drizzle ORM + Postgres (pg_trgm, RLS), BullMQ + ioredis, Zod, csv-parse, Vitest, Next.js 16 (App Router), React 19, Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-21-phase-4-job-intelligence-design.md` (read it first; this plan refines it in the "Refinements" section below, where real API responses contradicted a spec assumption).

## Global Constraints

Every task's requirements implicitly include this section.

- **No LLM call and no embedding anywhere in Phase 4.** Enrichment is rules-only; "unknown" is a first-class value (spec §1, D8).
- **Salary is never guessed and never zero** (D6). Missing salary is `null`; unparseable/ambiguous is `salary_is_parsed = false` with the raw span kept.
- **Consent gate (D3):** the worker refuses to run any source whose `consent_confirmed_at` is null, in worker code (not only in the UI).
- **Fixed hosts only (SSRF):** adapters build URLs from an operator-configured base (`GREENHOUSE_API_BASE` / `LEVER_API_BASE`) plus a slug validated against `^[A-Za-z0-9_-]{1,64}$`. Never fetch a user-supplied URL. Redirects are not followed.
- **Untrusted input:** posting content is stored as sanitized plain text and never rendered as HTML (React text nodes only). Uploaded files are validated by extension *and* content, size-capped (10 MB) and row-capped (5,000).
- **Logging / errors:** log and store *error classes and counts only*, never posting content or exception messages that may contain it (CLAUDE.md §9, D29).
- **Every user-scoped table** carries `user_id uuid NOT NULL DEFAULT current_setting('app.current_user_id')::uuid` plus a `user_isolation` RLS policy (D2, migration `0007_career_goal_rls.sql` pattern). Every DB access goes through `withUserContext` (`packages/db/src/rls.ts`).
- **Workspace conventions:** packages are `"type": "module"` with `"main": "src/index.ts"` (raw TS, no build step); tests are Vitest; `apps/web` files that a Vitest test imports use **relative imports, not the `@/` alias** (D19).
- **Next.js 16 is not the Next.js you know.** Before writing any code under `apps/web`, read `apps/web/AGENTS.md` and the relevant guide in `apps/web/node_modules/next/dist/docs/`. Verified for this plan: in route handlers and pages, dynamic `params` is a **`Promise`** (`{ params }: { params: Promise<{ id: string }> }`, then `await params`).
- **Test database:** DB-touching tests use `career_intel_test` via the app role (`career_intel_app`) for behavior and the superuser only to migrate/seed/wipe, scoped to a per-file fixed user id (existing pattern in `packages/db/src/careerGoalTables.rls.test.ts`). Test files that migrate must run serially (`fileParallelism: false`).
- **Commits (CLAUDE.md §15): do not commit unless the user has explicitly authorized it.** Every task ends with a **Checkpoint** step: run the named verification, then `git status`. Commit *only if* the user has authorized commits for this phase; if so use the message shown (Conventional Commits, with the repo's standard attribution trailer). Otherwise leave the tree as is and report.
- **Shared test database.** All suites, in all packages, migrate and use one `career_intel_test` database concurrently. Two simultaneous `migrate()` calls on an *empty* database collide (`duplicate key ... pg_type_typname_nsp_index`, observed in 1 of 3 fresh runs before the fix). So: every NEW test helper migrates under a Postgres advisory lock (Tasks 10 and 13), and CI migrates once before the tests (Task 20). Turborepo runs tasks with a *strict* environment, so `TEST_MIGRATIONS_DATABASE_URL` / `TEST_APP_DATABASE_URL` overrides are NOT seen by `pnpm test` — a scratch run that sets them silently falls back to `career_intel_test` and migrates it. If you need to point the whole suite elsewhere, use `pnpm exec turbo run test --env-mode=loose`, and check which database was touched afterwards.
- **Environment:** work in a fresh git worktree (superpowers:using-git-worktrees). Copy the repo-root `.env` into it. Run `pnpm install`, and run `pnpm --filter web build` once before the first `typecheck` (Next generates ambient types during build). Start infra with `docker compose -f infra/docker-compose.yml up -d` (postgres/redis/minio) if it is not running.

## Refinements to the spec (verified against real APIs on 2026-09-21)

The spec (§8) said the real Greenhouse/Lever response shapes were unverified. They were checked against live public boards (Greenhouse: airbnb, stripe, gitlab; Lever: spotify, palantir; ~1,430 postings), and the extraction rules were prototyped against that corpus. The following differ from, or refine, the spec. Task 20 folds them into the spec and DECISIONS.md.

| # | Finding | Consequence |
|---|---|---|
| R1 | Greenhouse `content` is **HTML-entity-escaped** (`&lt;div&gt;…`). | Decode first, then strip tags (`escapedHtmlToText`). |
| R2 | Greenhouse exposes `first_published` (true posted date) and separately `updated_at`. Lever exposes `createdAt` (epoch **milliseconds**). | `posted_at` = `first_published` / `createdAt`. `updated_at` is never treated as posted (as the spec said). |
| R3 | Lever exposes structured `country` (ISO-2) and `workplaceType` (`remote`/`hybrid`/`onsite`). Greenhouse exposes only free-text `location.name` (often multi-location: `"Remote, Canada; Remote, United Kingdom"`). | `country_code` from Lever only; Greenhouse `country_code = null`. Work mode from `workplaceType` first, then location/title keywords. |
| R4 | Lever splits requirements into `lists[]` (`{text, content(HTML)}`) and `additionalPlain`; `descriptionPlain` alone misses them. | Lever description text = `descriptionPlain` + every list (`text` + stripped `content`) + `additionalPlain`. |
| R5 | **No structured pay fields** appeared in any sampled posting (0 of ~1,430: no `pay_input_ranges`, no `salaryRange`). Pay appears only in description text. | Structured-pay parsing is **not implemented** (unverified shapes). Salary is text-scan only for all kinds. Revisit if a real board exposes pay fields. |
| R6 | Real salary text is messy: trailing ISO code overrides the symbol (`$43,500 — $48,333 MXN`, monthly); `R$14.000 — R$17.500 BRL`; European dot-thousands (`€71.000 — €84.000`); repeated code (`296,000 PLN — 350,000 PLN`); no separator (`$184,050 $262,928`); per-unit suffix between amounts (`$28/hour to $47/hour`); and market-size figures (`$100B`, `$20M–$50M`, `$1.4T`) that must **not** be read as pay. | Prototype-validated regex design (Task 3): 505 of 1,427 real postings parse, 0 market-size false positives, 0 implausible values, 4 genuine multi-range conflicts left unparsed. |
| R7 | "Sponsorship" appears in unrelated senses (event sponsorship, "executive sponsor", "financial sponsor"). | Sponsorship phrases must involve visa/work/employment/immigration; bare "sponsorship" is ignored. |
| R8 | "Lowest stated years of experience" picks up `2+ years … (nice to have)`. | Lines containing preferred/nice-to-have markers, and company-boast phrases, are ignored. |
| R9 | Slug: spec said `^[a-z0-9-]{1,64}$`; real board tokens can be mixed-case/underscored. | Widened to `^[A-Za-z0-9_-]{1,64}$` (still cannot alter host or path). |
| R10 | Canonical-job construction: spec said "per-field provenance, source precedence then recency." | Implemented as: each `job_postings` row stores its `normalized` snapshot; the canonical `jobs` row is *recomputed* by a pure `mergePostings` (first known value in precedence order per field group), and `jobs.field_provenance` records which posting supplied each group. `fingerprint` and `content_hash` live on `job_postings`. `jobs.location_key` is added (spec used a location key without a column). |
| R11 | Salary period: spec says normalize to annual only when the period is explicit. | Explicit period wins. No period and amount ≥ 10,000 → treated as annual (deterministic magnitude rule, documented). No period and < 10,000 → not parsed. |
| R12 | Currency: a bare `$` is ambiguous across dollars. | Bare `$` = USD, except when the posting's `country_code` is CA/AU/NZ/SG/HK → `is_parsed = false` (ambiguous). Explicit `US$/C$/A$/CAD/AUD/…` and trailing ISO codes are honoured. |
| R13 | A fetch that returns **zero** records for a source with open postings is more likely an API glitch than an empty board. | Zero-record fetch = `complete = false` (closes nothing). |
| R14 | `docker-compose.yml` runs only infrastructure (postgres/redis/minio); the web app is not containerized either. | The worker is started with `pnpm --filter @ai-career/job-ingestion start` (documented in the README). **No Dockerfile / compose service in Phase 4** — flagged for the user. |
| R15 | Duplicate-candidate search requires same `location_key` and `similarity(company_key || ' ' || title_key) >= 0.8`. | Threshold is a named constant `FUZZY_DUPLICATE_THRESHOLD`; nothing auto-merges at this tier. |
| R16 | CSV parsing by hand is error-prone (quotes, embedded newlines). | One new dependency: `csv-parse` (sync API), used only in the upload parser. |

## File Structure

```
packages/ingestion/                       NEW  (@ai-career/ingestion) — pure logic + DB pipeline
  package.json  tsconfig.json  eslint.config.mjs  vitest.config.ts
  src/
    types.ts                 domain types, IngestError
    sourceSchemas.ts         zod schemas for Greenhouse / Lever / upload-row shapes
    fixtures.ts              real-shape fixtures used across tests
    queue.ts                 queue/job-name constants + job options (no bullmq import)
    normalize/
      text.ts                decodeEntities, htmlToText, escapedHtmlToText
      keys.ts                companyKey, titleKey, locationKey, descriptionHash, fingerprint
      salary.ts              extractSalary
      experience.ts          extractMinExperience
      sponsorship.ts         extractSponsorship
      workMode.ts            detectWorkMode
      normalizeRecord.ts     normalizeRecord(source, record) -> NormalizedJob
    adapters/
      slug.ts  http.ts  greenhouse.ts  lever.ts  upload.ts  index.ts
    identity/
      merge.ts               mergePostings (pure)
      serialize.ts           NormalizedJob <-> jsonb
    pipeline/
      recomputeJob.ts  persistPosting.ts  closeMissing.ts  hashPayload.ts
      storeUpload.ts  runIngestion.ts
    testing/                 db.ts, factories.ts   (test helpers only)
    index.ts
  eval/                      cases.ts  score.ts  scoreExtraction.ts  extractionEval.test.ts
services/job-ingestion/                   NEW  (@ai-career/job-ingestion) — BullMQ glue only
  package.json tsconfig.json eslint.config.mjs vitest.config.ts
  src/ schedule.ts reconcile.ts worker.ts main.ts (+ tests)
  e2e/ fakeAts.ts
packages/db/src/schema/                   MODIFY — jobSources, ingestionRuns, rawJobPostings, jobs, jobPostings, jobDuplicateCandidates
packages/db/migrations/                   NEW migrations (generated + custom RLS/index SQL)
packages/config/src/env.ts                MODIFY — GREENHOUSE_API_BASE, LEVER_API_BASE, INGEST_INTERVAL_MINUTES
apps/web/src/lib/job-ingestion/enqueue.ts NEW
apps/web/src/lib/job-sources/ …           NEW (schemas, serialization)
apps/web/src/lib/jobs/ …                  NEW (list/detail queries)
apps/web/src/app/api/job-sources/**       NEW routes
apps/web/src/app/api/jobs/**              NEW routes
apps/web/src/app/sources/** jobs/**       NEW pages
apps/web/src/app/page.tsx                 MODIFY — links
pnpm-workspace.yaml                       MODIFY — add services/*
DECISIONS.md FLOW.md README.md docs/architecture.md  MODIFY (Task 20)
```

---

### Task 1: `@ai-career/ingestion` package scaffold, domain types, source schemas, fixtures

**Files:**
- Create: `packages/ingestion/package.json`, `packages/ingestion/tsconfig.json`, `packages/ingestion/eslint.config.mjs`, `packages/ingestion/vitest.config.ts`
- Create: `packages/ingestion/src/types.ts`, `packages/ingestion/src/sourceSchemas.ts`, `packages/ingestion/src/fixtures.ts`, `packages/ingestion/src/index.ts`
- Test: `packages/ingestion/src/sourceSchemas.test.ts`, `packages/ingestion/src/types.test.ts`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):
  - `SourceKind`, `WorkMode`, `SponsorshipValue`, `SalaryPeriod`, `SourceRef`, `RawRecord`, `SourceAdapter`, `SalaryResult`, `NormalizedJob`, `IngestErrorClass`, `IngestError` (with `.errorClass`, `.retryable`), `NormalizeError`.
  - Zod: `GreenhouseBoardResponseSchema`, `GreenhouseJobSchema`, `LeverPostingsResponseSchema`, `LeverPostingSchema`, `UploadRowSchema`, type `UploadRow`.
  - Fixtures: `greenhouseJobFixture`, `leverPostingFixture` (real field names/shapes; trimmed, synthetic text).

- [ ] **Step 1: Scaffold the package**

Add `services/*` to the workspace now (used from Task 12):

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
  - "services/*"
```

`packages/ingestion/package.json`:

```json
{
  "name": "@ai-career/ingestion",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@ai-career/config": "workspace:*",
    "@ai-career/db": "workspace:*",
    "csv-parse": "^5.6.0",
    "drizzle-orm": "^0.36.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "eslint": "^9.0.0",
    "postgres": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/ingestion/tsconfig.json` (same as `packages/storage/tsconfig.json`, plus `eval` for Task 18):

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "eval"]
}
```

`packages/ingestion/eslint.config.mjs`:

```js
import baseConfig from "../../eslint.config.base.mjs";

export default baseConfig;
```

`packages/ingestion/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests call drizzle's migrate() against the shared
    // career_intel_test database; concurrent migrate() calls race on
    // `CREATE SCHEMA IF NOT EXISTS drizzle` (same reason as packages/db).
    fileParallelism: false,
  },
});
```

Run: `pnpm install`
Expected: workspace links `@ai-career/ingestion`; no errors.

- [ ] **Step 2: Write the failing tests**

`packages/ingestion/src/sourceSchemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  GreenhouseBoardResponseSchema,
  GreenhouseJobSchema,
  LeverPostingsResponseSchema,
  LeverPostingSchema,
  UploadRowSchema,
} from "./sourceSchemas";
import { greenhouseJobFixture, leverPostingFixture } from "./fixtures";

describe("Greenhouse schemas", () => {
  it("accepts the board envelope and a real-shaped job", () => {
    expect(GreenhouseBoardResponseSchema.safeParse({ jobs: [greenhouseJobFixture], meta: { total: 1 } }).success).toBe(true);
    const job = GreenhouseJobSchema.parse(greenhouseJobFixture);
    expect(job.id).toBe(8556658002);
    expect(job.location?.name).toBe("Remote, United States");
  });

  it("rejects an envelope without a jobs array", () => {
    expect(GreenhouseBoardResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });

  it("rejects a job without a title", () => {
    expect(GreenhouseJobSchema.safeParse({ ...greenhouseJobFixture, title: "" }).success).toBe(false);
  });
});

describe("Lever schemas", () => {
  it("accepts an array envelope and a real-shaped posting", () => {
    expect(LeverPostingsResponseSchema.safeParse([leverPostingFixture]).success).toBe(true);
    const posting = LeverPostingSchema.parse(leverPostingFixture);
    expect(posting.country).toBe("GB");
    expect(posting.categories?.allLocations).toEqual(["London", "Stockholm"]);
  });

  it("rejects the {ok:false} error body Lever returns for an unknown site", () => {
    expect(LeverPostingsResponseSchema.safeParse({ ok: false, error: "Document not found" }).success).toBe(false);
  });
});

describe("UploadRowSchema", () => {
  it("requires title and company, everything else optional", () => {
    expect(UploadRowSchema.safeParse({ title: "Data Engineer", company: "Acme" }).success).toBe(true);
    expect(UploadRowSchema.safeParse({ title: "Data Engineer" }).success).toBe(false);
    expect(UploadRowSchema.safeParse({ company: "Acme", title: "  " }).success).toBe(false);
  });
});
```

`packages/ingestion/src/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { IngestError } from "./types";

describe("IngestError", () => {
  it("marks transient classes retryable and permanent ones not", () => {
    for (const c of ["rate_limited", "server_error", "network", "timeout", "unknown"] as const) {
      expect(new IngestError(c).retryable).toBe(true);
    }
    for (const c of ["consent_missing", "source_disabled", "invalid_slug", "not_found", "http_error", "response_too_large", "schema_mismatch"] as const) {
      expect(new IngestError(c).retryable).toBe(false);
    }
  });

  it("exposes only the class in its message, never free-form detail", () => {
    expect(new IngestError("not_found").message).toBe("not_found");
    expect(new IngestError("not_found").errorClass).toBe("not_found");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @ai-career/ingestion test`
Expected: FAIL — cannot resolve `./sourceSchemas`, `./fixtures`, `./types`.

- [ ] **Step 4: Write the implementation**

`packages/ingestion/src/types.ts`:

```ts
export type SourceKind = "greenhouse" | "lever" | "upload";
export type WorkMode = "remote" | "hybrid" | "onsite" | "unknown";
export type SponsorshipValue = "offered" | "not_offered" | "unknown";
export type SalaryPeriod = "year" | "month" | "hour";

export interface SourceRef {
  id: string;
  kind: SourceKind;
  label: string;
  config: { slug?: string; companyName?: string };
}

/** One record as the source gave it. `payload` is validated later, per record. */
export interface RawRecord {
  externalId: string;
  payload: unknown;
}

export interface SourceAdapter {
  fetch(source: SourceRef): AsyncIterable<RawRecord>;
}

export interface SalaryResult {
  /** The matched span, kept even when it could not be parsed. */
  raw: string | null;
  /** Annualized when the period is hour/month; null when unparsed. */
  min: number | null;
  max: number | null;
  currency: string | null;
  /** The period the source stated (or "year" inferred for amounts >= 10,000). */
  period: SalaryPeriod | null;
  isParsed: boolean;
}

export interface NormalizedJob {
  externalId: string;
  url: string | null;
  companyName: string;
  companyKey: string;
  title: string;
  titleKey: string;
  seniority: string | null;
  locationRaw: string | null;
  locationKey: string;
  countryCode: string | null;
  workMode: WorkMode;
  employmentType: string | null;
  descriptionText: string;
  descriptionHash: string;
  salary: SalaryResult;
  minExperience: { years: number | null; evidence: string | null };
  sponsorship: { value: SponsorshipValue; evidence: string | null; conflict: boolean };
  postedAt: Date | null;
}

export type IngestErrorClass =
  | "consent_missing"
  | "source_disabled"
  | "invalid_slug"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "network"
  | "timeout"
  | "http_error"
  | "response_too_large"
  | "schema_mismatch"
  | "unknown";

const RETRYABLE: ReadonlySet<IngestErrorClass> = new Set([
  "rate_limited",
  "server_error",
  "network",
  "timeout",
  "unknown",
]);

/**
 * The only failure type that crosses the adapter/pipeline/worker boundary.
 * The message is the class alone -- never posting content, URLs with tokens,
 * or a wrapped exception message (CLAUDE.md §9, D29).
 */
export class IngestError extends Error {
  constructor(public readonly errorClass: IngestErrorClass) {
    super(errorClass);
    this.name = "IngestError";
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.errorClass);
  }
}

/** A single record could not be normalized. Counted and skipped, never fatal to a run. */
export class NormalizeError extends Error {
  constructor() {
    super("record could not be normalized");
    this.name = "NormalizeError";
  }
}
```

`packages/ingestion/src/sourceSchemas.ts`:

```ts
import { z } from "zod";

// Shapes verified against live boards on 2026-09-21 (see plan "Refinements").
// Schemas are deliberately lenient (`passthrough`, optional fields): they pin
// only what normalization reads, so an upstream field addition never breaks a run.

export const GreenhouseBoardResponseSchema = z.object({
  jobs: z.array(z.unknown()),
});

export const GreenhouseJobSchema = z
  .object({
    id: z.number(),
    title: z.string().trim().min(1),
    absolute_url: z.string().nullable().optional(),
    company_name: z.string().nullable().optional(),
    location: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
    // HTML, entity-escaped ("&lt;div&gt;...") -- see normalize/text.ts.
    content: z.string().nullable().optional(),
    first_published: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
  })
  .passthrough();

export const LeverPostingsResponseSchema = z.array(z.unknown());

export const LeverPostingSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().trim().min(1),
    hostedUrl: z.string().nullable().optional(),
    // Epoch milliseconds.
    createdAt: z.number().nullable().optional(),
    // ISO-3166 alpha-2 when Lever knows it.
    country: z.string().nullable().optional(),
    // "remote" | "hybrid" | "onsite" | "unspecified"
    workplaceType: z.string().nullable().optional(),
    openingPlain: z.string().nullable().optional(),
    descriptionPlain: z.string().nullable().optional(),
    descriptionBodyPlain: z.string().nullable().optional(),
    additionalPlain: z.string().nullable().optional(),
    categories: z
      .object({
        commitment: z.string().nullable().optional(),
        location: z.string().nullable().optional(),
        allLocations: z.array(z.string()).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    lists: z
      .array(z.object({ text: z.string().nullable().optional(), content: z.string().nullable().optional() }))
      .nullable()
      .optional(),
  })
  .passthrough();

/** The canonical row the upload parser produces from any CSV/JSON header spelling. */
export const UploadRowSchema = z.object({
  title: z.string().trim().min(1),
  company: z.string().trim().min(1),
  location: z.string().trim().nullable().optional(),
  description: z.string().nullable().optional(),
  url: z.string().trim().nullable().optional(),
  postedAt: z.string().trim().nullable().optional(),
  employmentType: z.string().trim().nullable().optional(),
  salary: z.string().trim().nullable().optional(),
});
export type UploadRow = z.infer<typeof UploadRowSchema>;
```

`packages/ingestion/src/fixtures.ts`:

```ts
// Field names and shapes match live responses from
//   https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true
//   https://api.lever.co/v0/postings/spotify?mode=json
// (verified 2026-09-21). Text content is trimmed and synthetic.

export const greenhouseJobFixture = {
  id: 8556658002,
  internal_job_id: 6417799002,
  title: "AI Engineer",
  company_name: "GitLab",
  absolute_url: "https://job-boards.greenhouse.io/gitlab/jobs/8556658002",
  location: { name: "Remote, United States" },
  first_published: "2026-05-22T09:16:29-04:00",
  updated_at: "2026-09-14T16:01:39-04:00",
  requisition_id: "6401",
  language: "en",
  // Entity-escaped HTML, exactly as Greenhouse returns it.
  content:
    "&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;GitLab is the intelligent orchestration platform.&lt;/p&gt;&lt;/div&gt;" +
    "&lt;h3&gt;What You&#39;ll Do&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Build agents.&lt;/li&gt;&lt;/ul&gt;" +
    "&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;5+ years of experience in software engineering&lt;/li&gt;" +
    "&lt;li&gt;2+ years of experience with LLMs (nice to have)&lt;/li&gt;&lt;/ul&gt;" +
    "&lt;p&gt;The base salary range for this role is $150,000 - $200,000 per year. Visa sponsorship is not available.&lt;/p&gt;",
};

export const leverPostingFixture = {
  id: "2193db3f-77c5-43b8-b030-8f92c9882bf1",
  text: "Senior Data Engineer",
  hostedUrl: "https://jobs.lever.co/acme/2193db3f-77c5-43b8-b030-8f92c9882bf1",
  applyUrl: "https://jobs.lever.co/acme/2193db3f-77c5-43b8-b030-8f92c9882bf1/apply",
  createdAt: 1782214185805,
  country: "GB",
  workplaceType: "hybrid",
  categories: {
    commitment: "Permanent",
    department: "Engineering",
    location: "London",
    team: "Data",
    allLocations: ["London", "Stockholm"],
  },
  descriptionPlain: "We build the data platform.",
  lists: [
    {
      text: "Who You Are",
      content: "<li>3+ years of experience with SQL</li><li>Kotlin is a plus</li>",
    },
  ],
  additionalPlain: "Acme is an equal opportunity employer.",
};
```

`packages/ingestion/src/index.ts` (grows in later tasks):

```ts
export * from "./types";
export * from "./sourceSchemas";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/ingestion test && pnpm --filter @ai-career/ingestion typecheck && pnpm --filter @ai-career/ingestion lint`
Expected: PASS (2 files, 8 tests), typecheck and lint clean.

- [ ] **Step 6: Checkpoint**

Run: `git status --short`. Only if commits are authorized:
`git add pnpm-workspace.yaml pnpm-lock.yaml packages/ingestion && git commit -m "feat(ingestion): scaffold @ai-career/ingestion with domain types and source schemas"`

---

### Task 2: Text utilities and identity keys

**Files:**
- Create: `packages/ingestion/src/normalize/text.ts`, `packages/ingestion/src/normalize/keys.ts`
- Test: `packages/ingestion/src/normalize/text.test.ts`, `packages/ingestion/src/normalize/keys.test.ts`
- Modify: `packages/ingestion/src/index.ts`

**Interfaces:**
- Consumes: `NormalizedJob` (type only, for `computeFingerprint`).
- Produces:
  - `decodeEntities(input: string): string`
  - `htmlToText(html: string): string`
  - `escapedHtmlToText(content: string): string`  (Greenhouse: decode, then strip)
  - `companyKey(name: string): string`
  - `titleKey(title: string): { titleKey: string; seniority: string | null }`
  - `locationKey(location: string | null | undefined): string`
  - `descriptionHash(text: string): string`  (sha256 hex of whitespace/case-normalized text)
  - `computeFingerprint(job: Pick<NormalizedJob, "companyKey" | "titleKey" | "locationKey" | "descriptionHash">): string`

- [ ] **Step 1: Write the failing tests**

`packages/ingestion/src/normalize/text.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decodeEntities, htmlToText, escapedHtmlToText } from "./text";
import { greenhouseJobFixture } from "../fixtures";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities and leaves unknown ones alone", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41; &nbsp;f")).toBe('a & b <c> "d" \'e\' A  f');
    expect(decodeEntities("&bogus; &#99999999999;")).toBe("&bogus; &#99999999999;");
  });
});

describe("htmlToText", () => {
  it("turns block tags into newlines and list items into dashes", () => {
    expect(htmlToText("<p>One</p><p>Two</p><ul><li>a</li><li>b</li></ul>")).toBe("One\nTwo\n\n- a\n- b");
  });

  it("drops script and style content entirely", () => {
    expect(htmlToText("<style>p{color:red}</style><script>alert(1)</script><p>Hi</p>")).toBe("Hi");
  });

  it("collapses runs of spaces, and runs of blank lines down to one paragraph break", () => {
    expect(htmlToText("<p>a   b</p>\n\n\n\n<p>c</p>")).toBe("a b\n\nc");
  });
});

describe("escapedHtmlToText (Greenhouse content is entity-escaped HTML)", () => {
  it("decodes then strips, keeping apostrophes and list structure", () => {
    const text = escapedHtmlToText(greenhouseJobFixture.content);
    expect(text).toContain("What You'll Do");
    expect(text).toContain("- 5+ years of experience in software engineering");
    expect(text).not.toMatch(/[<>]|&lt;|&gt;/);
  });
});
```

`packages/ingestion/src/normalize/keys.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { companyKey, titleKey, locationKey, descriptionHash, computeFingerprint } from "./keys";

describe("companyKey", () => {
  it("lowercases, strips punctuation, diacritics, a leading 'the' and legal suffixes", () => {
    expect(companyKey("Acme, Inc.")).toBe("acme");
    expect(companyKey("The Boston Consulting Group")).toBe("boston consulting group");
    expect(companyKey("Müller GmbH")).toBe("muller");
    expect(companyKey("AT&T")).toBe("at and t");
    expect(companyKey("Volvo AB")).toBe("volvo");
  });

  it("never strips the name down to nothing", () => {
    expect(companyKey("Inc")).toBe("inc");
  });
});

describe("titleKey", () => {
  it("strips seniority words from the key and reports them separately", () => {
    expect(titleKey("Senior Software Engineer (Backend)")).toEqual({ titleKey: "software engineer backend", seniority: "senior" });
    expect(titleKey("Sr. Data Engineer")).toEqual({ titleKey: "data engineer", seniority: "senior" });
    expect(titleKey("Staff Platform Manager, Loyalty")).toEqual({ titleKey: "platform manager loyalty", seniority: "staff" });
    expect(titleKey("Lead - Advanced Analytics")).toEqual({ titleKey: "advanced analytics", seniority: "lead" });
  });

  it("keeps level numerals, and returns null seniority when there is none", () => {
    expect(titleKey("Software Engineer II")).toEqual({ titleKey: "software engineer ii", seniority: null });
  });

  it("falls back to the plain key when stripping would leave nothing", () => {
    expect(titleKey("Lead")).toEqual({ titleKey: "lead", seniority: "lead" });
  });
});

describe("locationKey", () => {
  it("normalizes and sorts multi-location strings so order does not matter", () => {
    expect(locationKey("Remote, Canada; Remote, United Kingdom; Remote, United States")).toBe(
      "remote canada|remote united kingdom|remote united states"
    );
    expect(locationKey("Remote, United States; Remote, Canada")).toBe("remote canada|remote united states");
  });

  it("returns an empty key for missing locations", () => {
    expect(locationKey(null)).toBe("");
    expect(locationKey("   ")).toBe("");
  });
});

describe("descriptionHash / computeFingerprint", () => {
  it("ignores case and whitespace differences but not word differences", () => {
    expect(descriptionHash("Build  the\nPlatform")).toBe(descriptionHash("build the platform"));
    expect(descriptionHash("build the platform")).not.toBe(descriptionHash("build the product"));
  });

  it("fingerprints are stable and sensitive to every component", () => {
    const base = { companyKey: "acme", titleKey: "data engineer", locationKey: "london", descriptionHash: "h1" };
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }));
    expect(computeFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
    for (const k of Object.keys(base) as (keyof typeof base)[]) {
      expect(computeFingerprint({ ...base, [k]: "x" })).not.toBe(computeFingerprint(base));
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ai-career/ingestion test -- normalize`
Expected: FAIL — cannot resolve `./text` / `./keys`.

- [ ] **Step 3: Write the implementation**

`packages/ingestion/src/normalize/text.ts`:

```ts
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint =
        entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * HTML -> plain text. The output is only ever stored and rendered as text
 * (React escapes it), never interpreted as HTML, so regex tag-stripping is
 * sufficient here; this is text extraction, not sanitization for an HTML sink.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\s*(?:br|\/p|\/div|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
      // <li> opens its own line ("- item"); no newline on </li>, or items get blank lines between them.
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Greenhouse returns `content` as entity-escaped HTML ("&lt;p&gt;..."): decode first, then strip the tags. */
export function escapedHtmlToText(content: string): string {
  return htmlToText(htmlToText(content));
}
```

`packages/ingestion/src/normalize/keys.ts`:

```ts
import { createHash } from "node:crypto";
import type { NormalizedJob } from "../types";

const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "ltd", "limited", "gmbh", "ag", "plc",
  "corp", "corporation", "co", "sa", "bv", "nv", "oy", "ab", "pty", "srl", "spa", "kg", "se",
]);

function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

function words(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function companyKey(name: string): string {
  let tokens = words(name).split(" ").filter(Boolean);
  if (tokens[0] === "the" && tokens.length > 1) tokens = tokens.slice(1);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

const SENIORITY: [string, RegExp][] = [
  ["intern", /\binterns?(?:hip)?\b/g],
  ["junior", /\b(?:junior|jr)\b/g],
  ["senior", /\b(?:senior|sr)\b/g],
  ["staff", /\bstaff\b/g],
  ["principal", /\bprincipal\b/g],
  ["lead", /\blead\b/g],
  ["director", /\bdirector\b/g],
  ["vp", /\b(?:vp|vice president)\b/g],
  ["head", /\bhead of\b/g],
];

export function titleKey(title: string): { titleKey: string; seniority: string | null } {
  const plain = words(title);
  let stripped = plain;
  let seniority: string | null = null;
  for (const [name, pattern] of SENIORITY) {
    if (pattern.test(stripped)) {
      seniority ??= name;
      stripped = stripped.replace(pattern, " ");
    }
    pattern.lastIndex = 0;
  }
  stripped = stripped.replace(/\s+/g, " ").trim();
  return { titleKey: stripped || plain, seniority };
}

export function locationKey(location: string | null | undefined): string {
  if (!location) return "";
  return location
    .split(";")
    .map((part) => words(part))
    .filter(Boolean)
    .sort()
    .join("|");
}

function normalizeForHash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function descriptionHash(text: string): string {
  return createHash("sha256").update(normalizeForHash(text)).digest("hex");
}

export function computeFingerprint(
  job: Pick<NormalizedJob, "companyKey" | "titleKey" | "locationKey" | "descriptionHash">
): string {
  return createHash("sha256")
    .update([job.companyKey, job.titleKey, job.locationKey, job.descriptionHash].join("\u0001"))
    .digest("hex");
}
```

Add to `packages/ingestion/src/index.ts`:

```ts
export * from "./normalize/text";
export * from "./normalize/keys";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/ingestion test && pnpm --filter @ai-career/ingestion typecheck`
Expected: PASS. (`SENIORITY` patterns are global regexes reused across calls: each is reset with `lastIndex = 0` after `.test`; `.replace` with a global regex resets it itself.)

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(ingestion): add text utilities and job identity keys"`

---

### Task 3: Deterministic salary extractor

The most fragile rule set. It was prototyped against ~1,430 real postings (505 parsed, 0 market-size false positives, 0 implausible values); the regression cases below are the real formats that broke earlier drafts.

**Files:**
- Create: `packages/ingestion/src/normalize/salary.ts`
- Test: `packages/ingestion/src/normalize/salary.test.ts`
- Modify: `packages/ingestion/src/index.ts`

**Interfaces:**
- Consumes: `SalaryResult`, `SalaryPeriod` from `../types`.
- Produces: `extractSalary(text: string, ctx?: { countryCode?: string | null }): SalaryResult`

- [ ] **Step 1: Write the failing tests**

`packages/ingestion/src/normalize/salary.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractSalary } from "./salary";

const parsed = (text: string, ctx?: { countryCode?: string | null }) => {
  const r = extractSalary(text, ctx);
  return { min: r.min, max: r.max, currency: r.currency, period: r.period, isParsed: r.isParsed };
};

describe("extractSalary — formats seen in real postings", () => {
  it("parses a plain annual range", () => {
    expect(parsed("The base salary range for this role is $150,000 - $200,000 per year.")).toEqual({
      min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true,
    });
  });

  it("honours a trailing ISO code over the symbol, and annualizes an explicit monthly period (Airbnb Mexico)", () => {
    const text = "The base pay range shown below is monthly.\n\nMexico Monthly Pay Range\n$43,500 — $48,333 MXN\n\nReasonable Accommodations";
    expect(parsed(text)).toEqual({ min: 43500 * 12, max: 48333 * 12, currency: "MXN", period: "month", isParsed: true });
  });

  it("reads R$ as BRL with dot thousands (Airbnb Brazil)", () => {
    expect(parsed("Brazil Monthly Pay Range\nR$14.000 — R$17.500 BRL")).toEqual({
      min: 14000 * 12, max: 17500 * 12, currency: "BRL", period: "month", isParsed: true,
    });
  });

  it("reads European dot-thousands (€71.000 — €84.000)", () => {
    expect(parsed("The annual salary range is €71.000 — €84.000 EUR")).toEqual({
      min: 71000, max: 84000, currency: "EUR", period: "year", isParsed: true,
    });
  });

  it("handles a repeated trailing code (296,000 PLN — 350,000 PLN)", () => {
    expect(parsed("The salary range is 296,000 PLN — 350,000 PLN per year")).toEqual({
      min: 296000, max: 350000, currency: "PLN", period: "year", isParsed: true,
    });
  });

  it("handles a range with no separator (Spotify: '$184,050 $262,928 plus equity')", () => {
    expect(parsed("The United States base range for this position is $184,050 $262,928 plus equity.")).toEqual({
      min: 184050, max: 262928, currency: "USD", period: "year", isParsed: true,
    });
  });

  it("handles a per-unit suffix between the amounts (Palantir: '$28/hour to $47/hour')", () => {
    expect(parsed("The salary range for this position is estimated to be $28/hour to $47/hour.")).toEqual({
      min: 28 * 2080, max: 47 * 2080, currency: "USD", period: "hour", isParsed: true,
    });
  });

  it("expands a k suffix and infers a year for amounts >= 10,000 with no stated period", () => {
    expect(parsed("Compensation: $120k - $150k")).toEqual({
      min: 120000, max: 150000, currency: "USD", period: "year", isParsed: true,
    });
  });

  it("keeps the raw span and treats one explicit CAD range as CAD", () => {
    const r = extractSalary("Pay Range\n$83,000 — $98,000 CAD");
    expect(r.currency).toBe("CAD");
    expect(r.raw).toBe("$83,000 — $98,000 CAD");
  });

  it("counts a range repeated with a trailing code once, not as a conflict", () => {
    expect(parsed("Pay Range\n$123,000 — $145,000 USD")).toMatchObject({ min: 123000, max: 145000, isParsed: true });
  });
});

describe("extractSalary — things that are NOT pay", () => {
  it("ignores market-size and volume figures (Stripe)", () => {
    const text =
      "Our commercial segment includes businesses processing $20M–$50M in annual payment volume. " +
      "We are attacking a $100B market opportunity. Stripe moved $1.4T in annual volume.";
    const r = extractSalary(text);
    expect(r.raw).toBeNull();
    expect(r.isParsed).toBe(false);
  });

  it("ignores bonus and equity amounts", () => {
    const r = extractSalary("This role is also eligible for a signing bonus of $10,000 and equity.");
    expect(r.raw).toBeNull();
  });

  it("requires salary context: a bare dollar figure elsewhere is not pay", () => {
    expect(extractSalary("We offer a $500 learning stipend and free lunch.").raw).toBeNull();
  });

  it("does not guess a period for small amounts", () => {
    expect(extractSalary("Pay: $5,000 - $6,000").raw).toBeNull();
  });

  it("rejects implausible annualized values", () => {
    expect(extractSalary("annual volume of $1.9 processed").raw).toBeNull();
  });
});

describe("extractSalary — ambiguity and absence", () => {
  it("does not parse conflicting regional ranges, but keeps the first span", () => {
    const r = extractSalary(
      "US: the base salary range is $150,000 - $200,000. UK: the base salary range is £100,000 - £130,000."
    );
    expect(r.isParsed).toBe(false);
    expect(r.min).toBeNull();
    expect(r.raw).toContain("$150,000");
  });

  it("does not parse a bare $ when the posting is in a non-US dollar country", () => {
    const r = extractSalary("Salary: $90,000 - $110,000 per year", { countryCode: "CA" });
    expect(r.isParsed).toBe(false);
    expect(r.raw).not.toBeNull();
    expect(extractSalary("Salary: $90,000 - $110,000 per year", { countryCode: "US" }).isParsed).toBe(true);
  });

  it("returns all-null (never zero) when there is no salary", () => {
    expect(extractSalary("We are hiring a data engineer.")).toEqual({
      raw: null, min: null, max: null, currency: null, period: null, isParsed: false,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ai-career/ingestion test -- salary`
Expected: FAIL — cannot resolve `./salary`.

- [ ] **Step 3: Write the implementation**

`packages/ingestion/src/normalize/salary.ts`:

```ts
import type { SalaryPeriod, SalaryResult } from "../types";

// Design (validated against ~1,430 real postings, see plan "Refinements" R6/R11/R12):
//  1. Find currency+amount candidates (prefix form "$1 - $2", suffix form "1 - 2 EUR").
//  2. A trailing ISO code overrides the symbol ("$43,500 MXN" is pesos).
//  3. Reject magnitude figures ($100B), bonus/equity amounts, and anything with no salary context nearby.
//  4. Period: explicit wins; no period + >= 10,000 -> year; no period + < 10,000 -> not a salary.
//  5. Several *different* candidates (regional ranges) -> unparsed, first span kept. Never guess.

const ISO =
  "USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|INR|SGD|HKD|JPY|CNY|KRW|MXN|BRL|ARS|COP|CLP|ZAR|AED|SAR|ILS|TRY";
const CUR = `(?:US\\$|CA\\$|MX\\$|HK\\$|NZ\\$|AU\\$|R\\$|S\\$|C\\$|A\\$|\\$|€|£|${ISO})`;
const NUM = "(?:\\d{1,3}(?:[.,]\\d{3})+|\\d+)(?:\\.\\d{1,2})?";
// The k suffix must not swallow the trailing space, or "$1 $2" (no separator) cannot match.
const AMT = `${NUM}(?:\\s?[kK]\\b)?`;
const SEP = "\\s?(?:-|–|—|to|and)\\s?";
const UNIT = "(?:\\s?(?:\\/\\s?(?:hr|hour|yr|year|mo|month)|per\\s(?:hour|year|month|annum)))?";

const PREFIX = new RegExp(
  `(?<![A-Za-z])(${CUR})\\s?(${AMT})${UNIT}(?:${SEP}(?:${CUR})?\\s?(${AMT})|\\s+${CUR}\\s?(${AMT}))?`,
  "g"
);
const SUFFIX = new RegExp(`(${AMT})(?:\\s?(?:${ISO}|€|£))?(?:${SEP}(${AMT}))?\\s?(${ISO}|€|£)`, "g");
const TRAILING_ISO = new RegExp(`^\\s?(${ISO})\\b`);

const MAGNITUDE_AFTER = /^\s?(?:M\b|MM\b|B\b|T\b|bn\b|tn\b|million|billion|trillion)/i;
const CONTEXT =
  /(salary|compensation|pay\b|base\b|ote\b|on-target|wage|remuneration|per (?:year|annum|hour|month)|annual|annually|hourly|monthly|\/\s?(?:yr|year|hr|hour|mo|month)\b|a year|an hour|p\.a\.)/i;
const NEGATIVE_BEFORE =
  /(equity|bonus|stock|rsu|options|signing|commission|revenue|funding|raised|valuation)[^.$€£]{0,25}$/i;

const ANNUALIZE: Record<SalaryPeriod, number> = { year: 1, month: 12, hour: 2080 };
const AMBIGUOUS_DOLLAR_COUNTRIES = new Set(["CA", "AU", "NZ", "SG", "HK"]);

const NONE: SalaryResult = { raw: null, min: null, max: null, currency: null, period: null, isParsed: false };

function currencyOf(symbol: string): string {
  const s = symbol.toUpperCase();
  const table: Record<string, string> = {
    "€": "EUR", "£": "GBP", "US$": "USD", "C$": "CAD", "CA$": "CAD", "A$": "AUD", "AU$": "AUD",
    "R$": "BRL", "MX$": "MXN", "S$": "SGD", "HK$": "HKD", "NZ$": "NZD", "$": "USD",
  };
  return table[s] ?? s;
}

function toNumber(raw: string): number {
  let s = raw.trim();
  const thousands = /k$/i.test(s);
  s = s.replace(/k$/i, "").trim();
  // European "60.000" / "1.234.567" (dot thousands, no decimals) vs "45.50".
  s = /^\d{1,3}(?:\.\d{3})+$/.test(s) ? s.replace(/\./g, "") : s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (thousands ? n * 1000 : n) : NaN;
}

function periodNear(text: string, start: number, end: number): SalaryPeriod | null {
  const around = text.slice(Math.max(0, start - 40), end + 40).toLowerCase();
  if (/(per hour|\/\s?hr|\/\s?hour|hourly|an hour)/.test(around)) return "hour";
  if (/(per month|\/\s?mo\b|\/\s?month|monthly|a month)/.test(around)) return "month";
  if (/(per year|per annum|\/\s?yr|\/\s?year|annual|annually|yearly|a year|p\.a\.)/.test(around)) return "year";
  return null;
}

interface Candidate {
  raw: string;
  symbol: string;
  lo: number;
  hi: number;
  period: SalaryPeriod;
  start: number;
  end: number;
}

export function extractSalary(text: string, ctx: { countryCode?: string | null } = {}): SalaryResult {
  const candidates: Candidate[] = [];

  for (const re of [PREFIX, SUFFIX]) {
    re.lastIndex = 0;
    const isPrefix = re === PREFIX;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      let end = m.index + m[0].length;
      let symbol = isPrefix ? m[1] : m[3];
      const first = toNumber(isPrefix ? m[2] : m[1]);
      const secondRaw = isPrefix ? (m[3] ?? m[4]) : m[2];
      const second = secondRaw ? toNumber(secondRaw) : first;
      if (!Number.isFinite(first) || !Number.isFinite(second)) continue;

      // "$43,500 - $48,333 MXN": the trailing code is the real currency; the symbol is a hint.
      if (isPrefix) {
        const trailing = TRAILING_ISO.exec(text.slice(end));
        if (trailing) {
          symbol = trailing[1];
          end += trailing[0].length;
        }
      }

      if (MAGNITUDE_AFTER.test(text.slice(end))) continue;
      if (NEGATIVE_BEFORE.test(text.slice(Math.max(0, start - 60), start))) continue;
      if (!CONTEXT.test(text.slice(Math.max(0, start - 120), end + 60))) continue;
      // The suffix pattern re-matches the tail of a range the prefix pattern already took.
      if (candidates.some((c) => start < c.end && c.start < end)) continue;

      const period = periodNear(text, start, end);
      const lo = Math.min(first, second);
      const hi = Math.max(first, second);
      if (!period && lo < 10000) continue;
      if (hi * ANNUALIZE[period ?? "year"] < 1000) continue;

      candidates.push({ raw: text.slice(start, end).trim(), symbol, lo, hi, period: period ?? "year", start, end });
    }
  }

  if (candidates.length === 0) return { ...NONE };
  candidates.sort((a, b) => a.start - b.start);
  const head = candidates[0];
  const currency = currencyOf(head.symbol);

  const allAgree = candidates.every(
    (c) => currencyOf(c.symbol) === currency && c.lo === head.lo && c.hi === head.hi && c.period === head.period
  );
  const ambiguousDollar = head.symbol === "$" && AMBIGUOUS_DOLLAR_COUNTRIES.has(ctx.countryCode ?? "");
  if (!allAgree || ambiguousDollar) return { ...NONE, raw: head.raw };

  const factor = ANNUALIZE[head.period];
  return { raw: head.raw, min: head.lo * factor, max: head.hi * factor, currency, period: head.period, isParsed: true };
}
```

Add to `packages/ingestion/src/index.ts`: `export * from "./normalize/salary";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/ingestion test -- salary && pnpm --filter @ai-career/ingestion typecheck`
Expected: PASS (all cases). If a real-format case fails, fix the regex, do not weaken the test — each case is a format observed in live data.

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(ingestion): add deterministic salary extractor validated on real postings"`

---

### Task 4: Experience, sponsorship and work-mode extractors

**Files:**
- Create: `packages/ingestion/src/normalize/experience.ts`, `packages/ingestion/src/normalize/sponsorship.ts`, `packages/ingestion/src/normalize/workMode.ts`
- Test: `packages/ingestion/src/normalize/experience.test.ts`, `packages/ingestion/src/normalize/sponsorship.test.ts`, `packages/ingestion/src/normalize/workMode.test.ts`
- Modify: `packages/ingestion/src/index.ts`

**Interfaces:**
- Consumes: `SponsorshipValue`, `WorkMode` from `../types`.
- Produces:
  - `extractMinExperience(text: string): { years: number | null; evidence: string | null }`
  - `extractSponsorship(text: string): { value: SponsorshipValue; evidence: string | null; conflict: boolean }`
  - `detectWorkMode(input: { structured?: string | null; location?: string | null; title?: string | null }): WorkMode`

- [ ] **Step 1: Write the failing tests**

`packages/ingestion/src/normalize/experience.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractMinExperience } from "./experience";

describe("extractMinExperience", () => {
  it("reads 'N+ years of experience' and keeps the sentence as evidence", () => {
    const r = extractMinExperience("Requirements\n- 5+ years of experience in software engineering");
    expect(r.years).toBe(5);
    expect(r.evidence).toContain("5+ years of experience");
  });

  it("allows a few words between 'years' and 'experience' ('8+ years of sales experience')", () => {
    expect(extractMinExperience("8+ years of sales experience").years).toBe(8);
    expect(extractMinExperience("Minimum 2years post-qualification experience").years).toBe(2);
  });

  it("takes the lower bound of a range and reads 'experience: N years'", () => {
    expect(extractMinExperience("2-4 years of experience with SQL").years).toBe(2);
    expect(extractMinExperience("Experience: at least 3 years").years).toBe(3);
  });

  it("keeps the lowest stated requirement (conservative: avoids false exclusion)", () => {
    expect(extractMinExperience("- 6+ years of experience in sales\n- 3+ years of experience in SaaS").years).toBe(3);
  });

  it("ignores optional lines: '(nice to have)', 'is a plus', '(preferred)', and 'Preferably N years'", () => {
    expect(extractMinExperience("- 6+ years of experience in sales\n- 2+ years of hospitality experience (nice to have)").years).toBe(6);
    expect(extractMinExperience("- 2+ years of experience with LLMs is a plus").years).toBeNull();
    expect(extractMinExperience("- 3+ years of experience with Go (preferred)").years).toBeNull();
    expect(extractMinExperience("- Preferably 3+ years of experience with Go").years).toBeNull();
  });

  it("does not treat 'preferably' AFTER the years as making them optional (real Stripe wording)", () => {
    const r = extractMinExperience("- 8+ years of sales experience, preferably selling a technical product");
    expect(r.years).toBe(8);
    expect(extractMinExperience("- 4+ years of experience, ideally in fintech").years).toBe(4);
  });

  it("only counts years tied to experience, and ignores company boasts", () => {
    expect(extractMinExperience("We have been in business for 10 years.").years).toBeNull();
    expect(extractMinExperience("We have over 15 years of experience serving customers.").years).toBeNull();
  });

  it("returns nulls when nothing matches", () => {
    expect(extractMinExperience("Great team, great product.")).toEqual({ years: null, evidence: null });
  });
});
```

`packages/ingestion/src/normalize/sponsorship.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractSponsorship } from "./sponsorship";

describe("extractSponsorship", () => {
  it("detects not_offered phrasings", () => {
    for (const text of [
      "Visa sponsorship is not available.",
      "We are unable to offer visa sponsorship for this role.",
      "No visa sponsorship will be provided.",
      "We cannot sponsor work visas at this time.",
      "Candidates must have the right to work in Ireland by the start date.",
      "You must be able to work without sponsorship.",
    ]) {
      expect(extractSponsorship(text).value).toBe("not_offered");
    }
  });

  it("detects offered phrasings", () => {
    for (const text of [
      "Visa sponsorship is available for this position.",
      "We offer visa sponsorship to qualified candidates.",
      "We can sponsor your visa and help you relocate.",
    ]) {
      expect(extractSponsorship(text).value).toBe("offered");
    }
  });

  it("does not treat unrelated 'sponsor' senses as visa sponsorship (real Stripe text)", () => {
    for (const text of [
      "activating Stripe's global sponsorship portfolio to deliver premium experiences",
      "serving as executive sponsor with key relationships",
      "Represent Stripe in the financial sponsor ecosystem",
      "We do not do event sponsorship.",
    ]) {
      expect(extractSponsorship(text)).toEqual({ value: "unknown", evidence: null, conflict: false });
    }
  });

  it("a negated sentence is not also counted as an offer", () => {
    const r = extractSponsorship("We cannot sponsor work visas.");
    expect(r.value).toBe("not_offered");
    expect(r.conflict).toBe(false);
  });

  it("flags a genuine conflict as unknown with both snippets", () => {
    const r = extractSponsorship("Visa sponsorship is available for some roles. We do not sponsor visas for contractors.");
    expect(r.value).toBe("unknown");
    expect(r.conflict).toBe(true);
    expect(r.evidence).toContain("||");
  });

  it("returns unknown with no evidence when the posting says nothing", () => {
    expect(extractSponsorship("Build data pipelines.")).toEqual({ value: "unknown", evidence: null, conflict: false });
  });
});
```

`packages/ingestion/src/normalize/workMode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectWorkMode } from "./workMode";

describe("detectWorkMode", () => {
  it("prefers the structured value", () => {
    expect(detectWorkMode({ structured: "hybrid", location: "Remote" })).toBe("hybrid");
    expect(detectWorkMode({ structured: "remote" })).toBe("remote");
    expect(detectWorkMode({ structured: "onsite" })).toBe("onsite");
    expect(detectWorkMode({ structured: "on-site" })).toBe("onsite");
  });

  it("falls through when the structured value is unspecified", () => {
    expect(detectWorkMode({ structured: "unspecified", location: "Remote, Bangalore" })).toBe("remote");
    expect(detectWorkMode({ structured: "unspecified" })).toBe("unknown");
  });

  it("reads location keywords (real Greenhouse strings)", () => {
    expect(detectWorkMode({ location: "Remote, United States" })).toBe("remote");
    expect(detectWorkMode({ location: "Remote, Canada; Remote, United Kingdom" })).toBe("remote");
    expect(detectWorkMode({ location: "London (Hybrid)" })).toBe("hybrid");
    expect(detectWorkMode({ location: "Berlin - On-site" })).toBe("onsite");
  });

  it("hybrid beats remote when both appear", () => {
    expect(detectWorkMode({ location: "Hybrid (remote-friendly)" })).toBe("hybrid");
  });

  it("falls back to the title, then to unknown", () => {
    expect(detectWorkMode({ location: "Berlin", title: "Remote Sales Engineer" })).toBe("remote");
    expect(detectWorkMode({ location: "Berlin", title: "Sales Engineer" })).toBe("unknown");
    expect(detectWorkMode({})).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ai-career/ingestion test -- experience sponsorship workMode`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

`packages/ingestion/src/normalize/experience.ts`:

```ts
// "N+ years of [a few words] experience" and "experience: N years". The LOWEST
// stated figure is kept: Phase 5 uses this to exclude on a *hard* mismatch, so
// understating is the safe direction. Optional (nice-to-have) lines and company boasts are ignored
// (real postings: "2+ years ... (nice to have)").

const YEARS_THEN_EXPERIENCE =
  /(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*\+?\s*)?(?:years?|yrs?)['’]?\s+(?:of\s+)?(?:[A-Za-z/&-]+\s+){0,4}?experience/gi;
const EXPERIENCE_THEN_YEARS =
  /experience[:\s]+(?:of\s+)?(?:at least\s+|minimum\s+(?:of\s+)?)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)/gi;
const BOAST = /(?:we(?:'ve| have)|our (?:team|company|founders?)|company (?:has|with))[^.]{0,40}$/i;
// A line is optional if it says so ANYWHERE ("... (nice to have)", "... is a plus"). "preferably" and
// "ideally" only make the years optional when they come BEFORE them ("Preferably 3+ years..."); after
// them they qualify the kind of experience ("8+ years of sales experience, preferably selling a
// technical product" -- a real posting -- is a hard 8-year requirement).
const OPTIONAL_ANYWHERE = /(nice to have|a plus|bonus points|desirable|\(preferred\)|\(optional\))/i;
const OPTIONAL_WHEN_BEFORE = /(preferred|preferably|ideally)/i;

function isOptional(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  return OPTIONAL_ANYWHERE.test(line) || OPTIONAL_WHEN_BEFORE.test(text.slice(lineStart, index));
}

export function extractMinExperience(text: string): { years: number | null; evidence: string | null } {
  let best: { years: number; evidence: string } | null = null;

  for (const pattern of [YEARS_THEN_EXPERIENCE, EXPERIENCE_THEN_YEARS]) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text))) {
      const years = Number(m[1]);
      if (!(years >= 0 && years <= 40)) continue;
      if (BOAST.test(text.slice(Math.max(0, m.index - 60), m.index))) continue;
      if (isOptional(text, m.index)) continue;
      if (best === null || years < best.years) {
        const from = Math.max(0, m.index - 40);
        const to = Math.min(text.length, m.index + m[0].length + 40);
        best = { years, evidence: text.slice(from, to).replace(/\s+/g, " ").trim() };
      }
    }
  }
  return best ?? { years: null, evidence: null };
}
```

`packages/ingestion/src/normalize/sponsorship.ts`:

```ts
import type { SponsorshipValue } from "../types";

// Bare "sponsorship" is NOT a signal ("event sponsorship", "executive sponsor",
// "financial sponsor" all appear in real postings). Every phrase here ties the
// word to a visa / work / immigration / employment context.

const NEGATION =
  "(?:no|not|cannot|can['’]?t|unable to|won['’]?t|will not|do(?:es)? not|don['’]?t|not able to|not in a position to)";
const WORK_CONTEXT = "(?:visas?|immigration|work|employment)";

const NOT_OFFERED: RegExp[] = [
  new RegExp(`\\b${NEGATION}\\b[^.\\n]{0,40}\\b${WORK_CONTEXT}\\b[^.\\n]{0,20}\\bsponsor(?:ship|ing)?\\b`, "i"),
  new RegExp(`\\b${NEGATION}\\b[^.\\n]{0,40}\\bsponsor(?:ship|ing)?\\b[^.\\n]{0,20}\\b${WORK_CONTEXT}\\b`, "i"),
  /\bvisa sponsorship (?:is )?(?:not|unavailable)/i,
  /\b(?:without|not require|no need for)\b[^.\n]{0,30}\bsponsorship\b/i,
  /\bmust (?:already )?(?:be|have)\b[^.\n]{0,30}\b(?:authori[sz]ed|authori[sz]ation|eligible|right) to work\b/i,
];

const OFFERED: RegExp[] = [
  /\bvisa sponsorship (?:is |will be )?(?:available|offered|provided|possible)/i,
  /\b(?:we|company|employer)\b[^.\n]{0,25}\b(?:sponsor|offer(?:s)? sponsorship)\b[^.\n]{0,20}\bvisas?\b/i,
  /\b(?:offer|provide)s?\b[^.\n]{0,15}\bvisa sponsorship\b/i,
  /\bsponsor(?:ing)?\b[^.\n]{0,12}\b(?:work )?visas?\b/i,
];

function snippet(text: string, index: number, length: number): string {
  const from = Math.max(0, index - 40);
  const to = Math.min(text.length, index + length + 40);
  return text.slice(from, to).replace(/\s+/g, " ").trim();
}

export function extractSponsorship(text: string): {
  value: SponsorshipValue;
  evidence: string | null;
  conflict: boolean;
} {
  let negatedEvidence: string | null = null;
  let remaining = text;
  for (const pattern of NOT_OFFERED) {
    const m = pattern.exec(text);
    if (m) {
      negatedEvidence = snippet(text, m.index, m[0].length);
      // Remove the negated clause so "cannot sponsor work visas" is not also read as an offer.
      remaining = text.slice(0, m.index) + " " + text.slice(m.index + m[0].length);
      break;
    }
  }

  let offeredEvidence: string | null = null;
  for (const pattern of OFFERED) {
    const m = pattern.exec(remaining);
    if (m) {
      offeredEvidence = snippet(remaining, m.index, m[0].length);
      break;
    }
  }

  if (offeredEvidence && negatedEvidence) {
    return { value: "unknown", evidence: `${offeredEvidence} || ${negatedEvidence}`, conflict: true };
  }
  if (offeredEvidence) return { value: "offered", evidence: offeredEvidence, conflict: false };
  if (negatedEvidence) return { value: "not_offered", evidence: negatedEvidence, conflict: false };
  return { value: "unknown", evidence: null, conflict: false };
}
```

`packages/ingestion/src/normalize/workMode.ts`:

```ts
import type { WorkMode } from "../types";

function fromStructured(value: string | null | undefined): WorkMode | null {
  const v = value?.toLowerCase().replace(/[^a-z]/g, "");
  if (v === "remote") return "remote";
  if (v === "hybrid") return "hybrid";
  if (v === "onsite") return "onsite";
  return null; // "unspecified", empty, or anything unknown falls through
}

function fromText(text: string | null | undefined): WorkMode | null {
  if (!text) return null;
  if (/\bhybrid\b/i.test(text)) return "hybrid"; // beats "remote" in "Hybrid (remote-friendly)"
  if (/\bremote\b/i.test(text)) return "remote";
  if (/\bon[- ]?site\b|\bin[- ]office\b/i.test(text)) return "onsite";
  return null;
}

/** Structured field first, then location, then title. The description is deliberately not scanned: boilerplate says "remote" everywhere. */
export function detectWorkMode(input: {
  structured?: string | null;
  location?: string | null;
  title?: string | null;
}): WorkMode {
  return fromStructured(input.structured) ?? fromText(input.location) ?? fromText(input.title) ?? "unknown";
}
```

Add to `packages/ingestion/src/index.ts`:

```ts
export * from "./normalize/experience";
export * from "./normalize/sponsorship";
export * from "./normalize/workMode";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/ingestion test && pnpm --filter @ai-career/ingestion typecheck && pnpm --filter @ai-career/ingestion lint`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(ingestion): add experience, sponsorship and work-mode extractors"`

---

### Task 5: `normalizeRecord` — raw record → `NormalizedJob`

**Files:**
- Create: `packages/ingestion/src/normalize/normalizeRecord.ts`
- Test: `packages/ingestion/src/normalize/normalizeRecord.test.ts`
- Modify: `packages/ingestion/src/index.ts`

**Interfaces:**
- Consumes: Task 1 (`SourceRef`, `RawRecord`, `NormalizedJob`, `NormalizeError`, `GreenhouseJobSchema`, `LeverPostingSchema`, `UploadRowSchema`, fixtures), Task 2 (`escapedHtmlToText`, `htmlToText`, `companyKey`, `titleKey`, `locationKey`, `descriptionHash`), Task 3 (`extractSalary`), Task 4 (`extractMinExperience`, `extractSponsorship`, `detectWorkMode`).
- Produces: `normalizeRecord(source: SourceRef, record: RawRecord): NormalizedJob` — pure; throws `NormalizeError` (no message detail) when the payload does not validate.

- [ ] **Step 1: Write the failing test**

`packages/ingestion/src/normalize/normalizeRecord.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeRecord } from "./normalizeRecord";
import { NormalizeError, type SourceRef } from "../types";
import { greenhouseJobFixture, leverPostingFixture } from "../fixtures";

const greenhouse: SourceRef = { id: "s1", kind: "greenhouse", label: "gitlab", config: { slug: "gitlab" } };
const lever: SourceRef = { id: "s2", kind: "lever", label: "acme", config: { slug: "acme", companyName: "Acme" } };
const upload: SourceRef = { id: "s3", kind: "upload", label: "jobs.csv", config: {} };

describe("normalizeRecord — greenhouse", () => {
  const job = normalizeRecord(greenhouse, { externalId: "8556658002", payload: greenhouseJobFixture });

  it("maps identity, location and dates (first_published, never updated_at)", () => {
    expect(job.externalId).toBe("8556658002");
    expect(job.title).toBe("AI Engineer");
    expect(job.companyName).toBe("GitLab");
    expect(job.companyKey).toBe("gitlab");
    expect(job.locationRaw).toBe("Remote, United States");
    expect(job.countryCode).toBeNull();
    expect(job.workMode).toBe("remote");
    expect(job.url).toBe("https://job-boards.greenhouse.io/gitlab/jobs/8556658002");
    expect(job.postedAt?.toISOString()).toBe("2026-05-22T13:16:29.000Z");
  });

  it("decodes the escaped HTML into plain text", () => {
    expect(job.descriptionText).toContain("What You'll Do");
    expect(job.descriptionText).not.toMatch(/&lt;|<div/);
  });

  it("runs the rule extractors over the description", () => {
    expect(job.salary).toMatchObject({ min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true });
    expect(job.minExperience.years).toBe(5); // the "(nice to have)" line is ignored
    expect(job.sponsorship.value).toBe("not_offered");
  });
});

describe("normalizeRecord — lever", () => {
  const job = normalizeRecord(lever, { externalId: leverPostingFixture.id, payload: leverPostingFixture });

  it("uses structured country and workplaceType, joins all locations, and reads createdAt as epoch ms", () => {
    expect(job.title).toBe("Senior Data Engineer");
    expect(job.seniority).toBe("senior");
    expect(job.titleKey).toBe("data engineer");
    expect(job.companyName).toBe("Acme"); // Lever postings carry no company name: source config supplies it
    expect(job.countryCode).toBe("GB");
    expect(job.workMode).toBe("hybrid");
    expect(job.locationRaw).toBe("London; Stockholm");
    expect(job.employmentType).toBe("Permanent");
    expect(job.postedAt?.getTime()).toBe(leverPostingFixture.createdAt);
    expect(job.url).toBe(leverPostingFixture.hostedUrl);
  });

  it("includes the requirement lists in the description (descriptionPlain alone misses them)", () => {
    expect(job.descriptionText).toContain("We build the data platform.");
    expect(job.descriptionText).toContain("- 3+ years of experience with SQL");
    expect(job.descriptionText).toContain("equal opportunity employer");
    expect(job.minExperience.years).toBe(3);
  });
});

describe("normalizeRecord — upload", () => {
  it("normalizes a canonical row, parsing a structured salary cell with an explicit salary label", () => {
    const job = normalizeRecord(upload, {
      externalId: "u1",
      payload: {
        title: "Data Engineer", company: "Acme GmbH", location: "Berlin",
        description: "<p>5+ years of experience with SQL</p>", url: "https://acme.example/jobs/1",
        postedAt: "2026-08-01", employmentType: "Full-time", salary: "€60,000 - €80,000",
      },
    });
    expect(job.companyKey).toBe("acme");
    expect(job.salary).toMatchObject({ min: 60000, max: 80000, currency: "EUR", isParsed: true });
    expect(job.minExperience.years).toBe(5);
    expect(job.postedAt?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(job.descriptionText).toBe("5+ years of experience with SQL");
  });

  it("leaves optional fields null/unknown when absent, and an unparseable date null", () => {
    const job = normalizeRecord(upload, { externalId: "u2", payload: { title: "Analyst", company: "Beta", postedAt: "not a date" } });
    expect(job.postedAt).toBeNull();
    expect(job.locationRaw).toBeNull();
    expect(job.locationKey).toBe("");
    expect(job.workMode).toBe("unknown");
    expect(job.salary.isParsed).toBe(false);
    expect(job.salary.min).toBeNull();
    expect(job.descriptionText).toBe("");
  });
});

describe("normalizeRecord — invalid payloads", () => {
  it("throws NormalizeError (no detail) for a greenhouse job without a title", () => {
    expect(() => normalizeRecord(greenhouse, { externalId: "1", payload: { id: 1, title: "" } })).toThrow(NormalizeError);
  });
  it("throws NormalizeError for an upload row without a company and for a non-object payload", () => {
    expect(() => normalizeRecord(upload, { externalId: "1", payload: { title: "X" } })).toThrow(NormalizeError);
    expect(() => normalizeRecord(lever, { externalId: "1", payload: "nope" })).toThrow(NormalizeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai-career/ingestion test -- normalizeRecord`
Expected: FAIL — cannot resolve `./normalizeRecord`.

- [ ] **Step 3: Write the implementation**

`packages/ingestion/src/normalize/normalizeRecord.ts`:

```ts
import {
  GreenhouseJobSchema,
  LeverPostingSchema,
  UploadRowSchema,
} from "../sourceSchemas";
import { NormalizeError, type NormalizedJob, type RawRecord, type SourceRef } from "../types";
import { companyKey, descriptionHash, locationKey, titleKey } from "./keys";
import { extractMinExperience } from "./experience";
import { extractSalary } from "./salary";
import { extractSponsorship } from "./sponsorship";
import { escapedHtmlToText, htmlToText } from "./text";
import { detectWorkMode } from "./workMode";

interface Common {
  externalId: string;
  url: string | null;
  companyName: string;
  title: string;
  locationRaw: string | null;
  countryCode: string | null;
  structuredWorkMode: string | null;
  employmentType: string | null;
  descriptionText: string;
  postedAt: Date | null;
  /** A structured salary cell (upload). Prefixed with "Salary:" so the extractor sees context. */
  salaryHint?: string | null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

function nonEmpty(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

function assemble(c: Common): NormalizedJob {
  if (!c.companyName || !c.title) throw new NormalizeError();
  const tk = titleKey(c.title);
  const salaryText = c.salaryHint ? `Salary: ${c.salaryHint}\n${c.descriptionText}` : c.descriptionText;
  return {
    externalId: c.externalId,
    url: c.url,
    companyName: c.companyName,
    companyKey: companyKey(c.companyName),
    title: c.title,
    titleKey: tk.titleKey,
    seniority: tk.seniority,
    locationRaw: c.locationRaw,
    locationKey: locationKey(c.locationRaw),
    countryCode: c.countryCode,
    workMode: detectWorkMode({ structured: c.structuredWorkMode, location: c.locationRaw, title: c.title }),
    employmentType: c.employmentType,
    descriptionText: c.descriptionText,
    descriptionHash: descriptionHash(c.descriptionText),
    salary: extractSalary(salaryText, { countryCode: c.countryCode }),
    minExperience: extractMinExperience(c.descriptionText),
    sponsorship: extractSponsorship(c.descriptionText),
    postedAt: c.postedAt,
  };
}

function fromGreenhouse(source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = GreenhouseJobSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const job = parsed.data;
  return assemble({
    externalId: record.externalId,
    url: nonEmpty(job.absolute_url),
    companyName: nonEmpty(job.company_name) ?? source.config.companyName ?? source.label,
    title: job.title.trim(),
    locationRaw: nonEmpty(job.location?.name),
    countryCode: null, // Greenhouse has only free-text location
    structuredWorkMode: null,
    employmentType: null,
    descriptionText: escapedHtmlToText(job.content ?? ""),
    // first_published is the real posted date; updated_at changes on every edit and is NOT a posted date.
    postedAt: parseDate(job.first_published),
  });
}

function fromLever(source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = LeverPostingSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const p = parsed.data;

  // descriptionPlain alone omits the requirement lists ("Who You Are"), where experience/visa text lives.
  const lists = (p.lists ?? []).map((l) => [l.text, l.content ? htmlToText(l.content) : null].filter(Boolean).join("\n"));
  const body =
    p.descriptionPlain ?? [p.openingPlain, p.descriptionBodyPlain].filter(Boolean).join("\n");
  const descriptionText = [body, ...lists, p.additionalPlain].filter(Boolean).join("\n\n").trim();

  const all = p.categories?.allLocations?.filter(Boolean) ?? [];
  const locationRaw = all.length > 0 ? all.join("; ") : nonEmpty(p.categories?.location);
  const country = p.country?.trim().toUpperCase();

  return assemble({
    externalId: record.externalId,
    url: nonEmpty(p.hostedUrl),
    companyName: source.config.companyName ?? source.label, // Lever postings carry no company name
    title: p.text.trim(),
    locationRaw,
    countryCode: country && /^[A-Z]{2}$/.test(country) ? country : null,
    structuredWorkMode: p.workplaceType ?? null,
    employmentType: nonEmpty(p.categories?.commitment),
    descriptionText,
    postedAt: typeof p.createdAt === "number" ? new Date(p.createdAt) : null, // epoch milliseconds
  });
}

function fromUpload(_source: SourceRef, record: RawRecord): NormalizedJob {
  const parsed = UploadRowSchema.safeParse(record.payload);
  if (!parsed.success) throw new NormalizeError();
  const row = parsed.data;
  return assemble({
    externalId: record.externalId,
    url: nonEmpty(row.url),
    companyName: row.company.trim(),
    title: row.title.trim(),
    locationRaw: nonEmpty(row.location),
    countryCode: null,
    structuredWorkMode: null,
    employmentType: nonEmpty(row.employmentType),
    descriptionText: htmlToText(row.description ?? ""),
    postedAt: parseDate(row.postedAt),
    salaryHint: nonEmpty(row.salary),
  });
}

export function normalizeRecord(source: SourceRef, record: RawRecord): NormalizedJob {
  switch (source.kind) {
    case "greenhouse":
      return fromGreenhouse(source, record);
    case "lever":
      return fromLever(source, record);
    case "upload":
      return fromUpload(source, record);
  }
}
```

Add to `packages/ingestion/src/index.ts`: `export * from "./normalize/normalizeRecord";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/ingestion test && pnpm --filter @ai-career/ingestion typecheck`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(ingestion): normalize Greenhouse, Lever and upload records"`

---

### Task 6: HTTP layer, Greenhouse and Lever adapters, adapter config

**Files:**
- Create: `packages/ingestion/src/adapters/slug.ts`, `packages/ingestion/src/adapters/http.ts`, `packages/ingestion/src/adapters/greenhouse.ts`, `packages/ingestion/src/adapters/lever.ts`
- Test: `packages/ingestion/src/adapters/http.test.ts`, `packages/ingestion/src/adapters/adapters.test.ts`
- Modify: `packages/config/src/env.ts`, `packages/config/src/env.test.ts`, `.env.example`, `packages/ingestion/src/index.ts`

**Interfaces:**
- Consumes: `IngestError`, `SourceAdapter`, `SourceRef`, `RawRecord`, `GreenhouseBoardResponseSchema`, `LeverPostingsResponseSchema` (Task 1).
- Produces:
  - `SLUG_RE: RegExp`, `assertValidSlug(slug: unknown): string` (throws `IngestError("invalid_slug")`)
  - `fetchJson(url: string, opts?: { timeoutMs?: number; maxBytes?: number; fetchFn?: typeof fetch }): Promise<unknown>` (throws `IngestError` only)
  - `createGreenhouseAdapter(opts: { baseUrl: string; fetchFn?: typeof fetch }): SourceAdapter`
  - `createLeverAdapter(opts: { baseUrl: string; fetchFn?: typeof fetch }): SourceAdapter`
  - Env: `GREENHOUSE_API_BASE` (default `https://boards-api.greenhouse.io`), `LEVER_API_BASE` (default `https://api.lever.co`), `INGEST_INTERVAL_MINUTES` (default `360`, min `5`).

- [ ] **Step 1: Write the failing tests**

`packages/ingestion/src/adapters/http.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchJson } from "./http";
import { IngestError } from "../types";

const respond = (body: string | null, init: ResponseInit = { status: 200 }) =>
  vi.fn<typeof fetch>(async () => new Response(body, init));
const errorClass = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof IngestError ? e.errorClass : "not-an-IngestError";
  }
  return "no-error";
};

describe("fetchJson", () => {
  it("returns parsed JSON on 200 and does not follow redirects", async () => {
    const fetchFn = respond('{"a":1}');
    expect(await fetchJson("https://x.test/a", { fetchFn })).toEqual({ a: 1 });
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it.each([
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
    [400, "http_error"],
    [302, "http_error"],
  ] as const)("classifies HTTP %i as %s", async (status, expected) => {
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: respond("{}", { status }) }))).toBe(expected);
  });

  it("classifies a rejected fetch as network, and a TimeoutError as timeout", async () => {
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: vi.fn().mockRejectedValue(new TypeError("fetch failed")) }))).toBe("network");
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: vi.fn().mockRejectedValue(timeout) }))).toBe("timeout");
  });

  it("rejects an oversized declared content-length and an oversized streamed body", async () => {
    const declared = respond("{}", { status: 200, headers: { "content-length": "999999" } });
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: declared, maxBytes: 100 }))).toBe("response_too_large");
    const streamed = respond(JSON.stringify({ pad: "x".repeat(500) }));
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: streamed, maxBytes: 100 }))).toBe("response_too_large");
  });

  it("classifies a non-JSON body as schema_mismatch", async () => {
    expect(await errorClass(fetchJson("https://x.test", { fetchFn: respond("<html>") }))).toBe("schema_mismatch");
  });
});
```

`packages/ingestion/src/adapters/adapters.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createGreenhouseAdapter } from "./greenhouse";
import { createLeverAdapter } from "./lever";
import { assertValidSlug } from "./slug";
import { IngestError, type RawRecord, type SourceRef } from "../types";
import { greenhouseJobFixture, leverPostingFixture } from "../fixtures";

const ref = (kind: "greenhouse" | "lever", slug: unknown): SourceRef =>
  ({ id: "s", kind, label: "x", config: { slug: slug as string } });
const json = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
async function collect(iter: AsyncIterable<RawRecord>) {
  const out: RawRecord[] = [];
  for await (const r of iter) out.push(r);
  return out;
}
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as IngestError).errorClass;
  }
  return "no-error";
};

describe("assertValidSlug", () => {
  it("accepts board tokens and rejects anything that could alter host or path", () => {
    expect(assertValidSlug("gitlab")).toBe("gitlab");
    expect(assertValidSlug("Acme_Corp-2")).toBe("Acme_Corp-2");
    for (const bad of ["", "../etc", "a/b", "a.b", "a:b", "a b", "x".repeat(65), undefined, 5]) {
      expect(() => assertValidSlug(bad)).toThrow(IngestError);
    }
  });
});

describe("Greenhouse adapter", () => {
  it("requests the content=true board URL and yields one record per identifiable job", async () => {
    const fetchFn = json({ jobs: [greenhouseJobFixture, { title: "no id" }, { ...greenhouseJobFixture, id: 2 }], meta: { total: 3 } });
    const records = await collect(createGreenhouseAdapter({ baseUrl: "https://gh.test/", fetchFn }).fetch(ref("greenhouse", "gitlab")));
    expect(fetchFn.mock.calls[0][0]).toBe("https://gh.test/v1/boards/gitlab/jobs?content=true");
    expect(records.map((r) => r.externalId)).toEqual(["8556658002", "2"]);
    expect(records[0].payload).toMatchObject({ id: 8556658002, title: "AI Engineer" });
  });

  it("refuses an invalid slug before making any request", async () => {
    const fetchFn = json({ jobs: [] });
    expect(await failure(collect(createGreenhouseAdapter({ baseUrl: "https://gh.test", fetchFn }).fetch(ref("greenhouse", "../x"))))).toBe("invalid_slug");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps a 404 to not_found and an envelope without jobs to schema_mismatch", async () => {
    const adapter = (f: typeof fetch) => createGreenhouseAdapter({ baseUrl: "https://gh.test", fetchFn: f });
    expect(await failure(collect(adapter(json({}, 404)).fetch(ref("greenhouse", "nope"))))).toBe("not_found");
    expect(await failure(collect(adapter(json({ unexpected: true })).fetch(ref("greenhouse", "gitlab"))))).toBe("schema_mismatch");
  });
});

describe("Lever adapter", () => {
  it("requests mode=json and yields a record per posting keyed by its id", async () => {
    const fetchFn = json([leverPostingFixture]);
    const records = await collect(createLeverAdapter({ baseUrl: "https://lv.test", fetchFn }).fetch(ref("lever", "acme")));
    expect(fetchFn.mock.calls[0][0]).toBe("https://lv.test/v0/postings/acme?mode=json");
    expect(records).toEqual([{ externalId: leverPostingFixture.id, payload: leverPostingFixture }]);
  });

  it("treats Lever's {ok:false} 404 body and a non-array 200 as failures", async () => {
    const adapter = (f: typeof fetch) => createLeverAdapter({ baseUrl: "https://lv.test", fetchFn: f });
    expect(await failure(collect(adapter(json({ ok: false, error: "Document not found" }, 404)).fetch(ref("lever", "nope"))))).toBe("not_found");
    expect(await failure(collect(adapter(json({ ok: false })).fetch(ref("lever", "acme"))))).toBe("schema_mismatch");
  });
});
```

Append to `packages/config/src/env.test.ts` (inside the existing `describe("loadEnv", ...)`, before its closing `});`):

```ts
  it("defaults the ingestion settings and lets them be overridden", () => {
    const env = loadEnv(validSource);
    expect(env.GREENHOUSE_API_BASE).toBe("https://boards-api.greenhouse.io");
    expect(env.LEVER_API_BASE).toBe("https://api.lever.co");
    expect(env.INGEST_INTERVAL_MINUTES).toBe(360);

    const custom = loadEnv({ ...validSource, GREENHOUSE_API_BASE: "http://localhost:4010", INGEST_INTERVAL_MINUTES: "15" });
    expect(custom.GREENHOUSE_API_BASE).toBe("http://localhost:4010");
    expect(custom.INGEST_INTERVAL_MINUTES).toBe(15);
  });

  it("rejects a too-short ingestion interval and a malformed API base", () => {
    expect(() => loadEnv({ ...validSource, INGEST_INTERVAL_MINUTES: "1" })).toThrow(/INGEST_INTERVAL_MINUTES/);
    expect(() => loadEnv({ ...validSource, LEVER_API_BASE: "not-a-url" })).toThrow(/LEVER_API_BASE/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ai-career/ingestion test -- adapters` and `pnpm --filter @ai-career/config test`
Expected: FAIL — adapter modules missing; env tests fail on `GREENHOUSE_API_BASE` undefined.

- [ ] **Step 3: Write the implementation**

In `packages/config/src/env.ts`, add these fields inside `z.object({ ... })` right after `VOYAGE_EMBEDDING_MODEL: z.string().min(1),`:

```ts
    // Phase 4 ingestion. The API bases are operator-controlled (never user
    // input), which is what keeps the adapters SSRF-safe; overriding them is how
    // the E2E fake ATS server is used. See DECISIONS.md D3.
    GREENHOUSE_API_BASE: z.string().url().default("https://boards-api.greenhouse.io"),
    LEVER_API_BASE: z.string().url().default("https://api.lever.co"),
    INGEST_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(360),
```

Append to `.env.example`:

```
# Phase 4 job ingestion. Defaults are the public board APIs; override only to
# point the worker at a local fake ATS server (services/job-ingestion/e2e).
# GREENHOUSE_API_BASE=https://boards-api.greenhouse.io
# LEVER_API_BASE=https://api.lever.co
# Minutes between scheduled fetches of each enabled board (minimum 5).
# INGEST_INTERVAL_MINUTES=360
```

`packages/ingestion/src/adapters/slug.ts`:

```ts
import { IngestError } from "../types";

/**
 * Board tokens are interpolated into a URL path. This character set cannot
 * introduce a host, port, path separator, query or fragment, so a slug can
 * never redirect a request to a different destination (SSRF).
 */
export const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function assertValidSlug(slug: unknown): string {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw new IngestError("invalid_slug");
  return slug;
}
```

`packages/ingestion/src/adapters/http.ts`:

```ts
import { IngestError } from "../types";

export const DEFAULT_TIMEOUT_MS = 30_000;
// Greenhouse boards with content=true are large (Stripe ~5 MB, Palantir/Lever ~6 MB).
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export interface FetchJsonOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchFn?: typeof fetch;
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/** GET a URL and return parsed JSON. Throws `IngestError` and nothing else, with a class only. */
export async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let response: Response;
  try {
    response = await fetchFn(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "career-pilot-ingestion/0.1 (personal job search tool)" },
      // A redirect could move the request off the configured host; treat any 3xx as an error.
      redirect: "manual",
    });
  } catch (error) {
    throw new IngestError(isTimeout(error) ? "timeout" : "network");
  }

  if (response.status === 404) throw new IngestError("not_found");
  if (response.status === 429) throw new IngestError("rate_limited");
  if (response.status >= 500) throw new IngestError("server_error");
  if (!response.ok) throw new IngestError("http_error");

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new IngestError("response_too_large");

  let text: string;
  try {
    text = await readCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(isTimeout(error) ? "timeout" : "network");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new IngestError("schema_mismatch");
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new IngestError("response_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
```

`packages/ingestion/src/adapters/greenhouse.ts`:

```ts
import { GreenhouseBoardResponseSchema } from "../sourceSchemas";
import { IngestError, type RawRecord, type SourceAdapter, type SourceRef } from "../types";
import { fetchJson } from "./http";
import { assertValidSlug } from "./slug";

export function createGreenhouseAdapter(opts: { baseUrl: string; fetchFn?: typeof fetch }): SourceAdapter {
  return {
    async *fetch(source: SourceRef): AsyncIterable<RawRecord> {
      const slug = assertValidSlug(source.config.slug);
      const url = `${opts.baseUrl.replace(/\/$/, "")}/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
      const envelope = GreenhouseBoardResponseSchema.safeParse(await fetchJson(url, { fetchFn: opts.fetchFn }));
      if (!envelope.success) throw new IngestError("schema_mismatch");

      for (const job of envelope.data.jobs) {
        const id = (job as { id?: unknown } | null)?.id;
        // A job without an id cannot be tracked across runs, so it is dropped here.
        if (typeof id !== "number" && typeof id !== "string") continue;
        yield { externalId: String(id), payload: job };
      }
    },
  };
}
```

`packages/ingestion/src/adapters/lever.ts`:

```ts
import { LeverPostingsResponseSchema } from "../sourceSchemas";
import { IngestError, type RawRecord, type SourceAdapter, type SourceRef } from "../types";
import { fetchJson } from "./http";
import { assertValidSlug } from "./slug";

export function createLeverAdapter(opts: { baseUrl: string; fetchFn?: typeof fetch }): SourceAdapter {
  return {
    async *fetch(source: SourceRef): AsyncIterable<RawRecord> {
      const slug = assertValidSlug(source.config.slug);
      const url = `${opts.baseUrl.replace(/\/$/, "")}/v0/postings/${encodeURIComponent(slug)}?mode=json`;
      const envelope = LeverPostingsResponseSchema.safeParse(await fetchJson(url, { fetchFn: opts.fetchFn }));
      if (!envelope.success) throw new IngestError("schema_mismatch");

      for (const posting of envelope.data) {
        const id = (posting as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || id.length === 0) continue;
        yield { externalId: id, payload: posting };
      }
    },
  };
}
```

Add to `packages/ingestion/src/index.ts`:

```ts
export * from "./adapters/slug";
export * from "./adapters/http";
export * from "./adapters/greenhouse";
export * from "./adapters/lever";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/ingestion test && pnpm --filter @ai-career/config test && pnpm --filter @ai-career/ingestion typecheck && pnpm --filter @ai-career/config typecheck`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(ingestion): add HTTP layer and Greenhouse/Lever adapters; add ingestion env settings"`

---

### Task 7: CSV/JSON upload parser

**Files:**
- Create: `packages/ingestion/src/adapters/upload.ts`
- Test: `packages/ingestion/src/adapters/upload.test.ts`
- Modify: `packages/ingestion/src/index.ts`

**Interfaces:**
- Consumes: `UploadRowSchema`, `UploadRow`, `RawRecord` (Task 1).
- Produces:
  - `MAX_UPLOAD_ROWS = 5000`
  - `class UploadParseError extends Error` (message is safe to show the user; never contains file content)
  - `parseUploadFile(buffer: Buffer, filename: string): RawRecord[]` — `payload` is a validated `UploadRow`; `externalId` is the row's `id` column when present, else a stable content hash. Duplicate ids within the file keep the first.

- [ ] **Step 1: Write the failing test**

`packages/ingestion/src/adapters/upload.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseUploadFile, UploadParseError, MAX_UPLOAD_ROWS } from "./upload";

const buf = (s: string) => Buffer.from(s, "utf8");

describe("parseUploadFile — CSV", () => {
  it("parses quoted commas and embedded newlines, and maps header aliases case-insensitively", () => {
    const csv = [
      'Job Title,Company Name,Location,Job Description,Job URL,Date Posted,Type,Compensation,Job ID',
      '"Data Engineer, Platform",Acme,Berlin,"Line one\nLine two",https://acme.example/1,2026-08-01,Full-time,"€60,000 - €80,000",A-1',
    ].join("\n");
    const [record] = parseUploadFile(buf(csv), "jobs.csv");
    expect(record.externalId).toBe("A-1");
    expect(record.payload).toEqual({
      title: "Data Engineer, Platform", company: "Acme", location: "Berlin", description: "Line one\nLine two",
      url: "https://acme.example/1", postedAt: "2026-08-01", employmentType: "Full-time", salary: "€60,000 - €80,000",
    });
  });

  it("derives a stable content-hash id when there is no id column, and keeps the first of duplicates", () => {
    const csv = "title,company\nAnalyst,Beta\nAnalyst,Beta\nEngineer,Beta";
    const records = parseUploadFile(buf(csv), "jobs.csv");
    expect(records).toHaveLength(2);
    expect(records[0].externalId).toMatch(/^[0-9a-f]{32}$/);
    expect(parseUploadFile(buf(csv), "jobs.csv")[0].externalId).toBe(records[0].externalId);
  });
});

describe("parseUploadFile — JSON", () => {
  it("accepts a bare array and a {jobs: []} wrapper", () => {
    const rows = [{ title: "Analyst", company: "Beta", url: "https://b.example/1" }];
    expect(parseUploadFile(buf(JSON.stringify(rows)), "jobs.json")).toHaveLength(1);
    expect(parseUploadFile(buf(JSON.stringify({ jobs: rows })), "jobs.json")).toHaveLength(1);
  });
});

describe("parseUploadFile — rejections (messages are user-safe)", () => {
  const rejects = (b: Buffer, name: string, pattern: RegExp) => {
    expect(() => parseUploadFile(b, name)).toThrow(UploadParseError);
    expect(() => parseUploadFile(b, name)).toThrow(pattern);
  };

  it("rejects unsupported extensions, binary content and invalid syntax", () => {
    rejects(buf("x"), "jobs.txt", /\.csv or \.json/);
    rejects(Buffer.from([0x50, 0x4b, 0x00, 0x03]), "jobs.csv", /binary/i);
    rejects(buf("{not json"), "jobs.json", /valid JSON/);
    rejects(buf('{"unexpected": true}'), "jobs.json", /"jobs" array/);
  });

  it("rejects an empty file and rows missing a title or company, naming the row numbers", () => {
    rejects(buf("title,company\n"), "jobs.csv", /no jobs/i);
    rejects(buf("title,company\nAnalyst,Beta\n,Gamma\nEngineer,"), "jobs.csv", /rows 2, 3/);
  });

  it("rejects files over the row cap", () => {
    const lines = ["title,company", ...Array.from({ length: MAX_UPLOAD_ROWS + 1 }, (_, i) => `Job ${i},Co`)];
    rejects(buf(lines.join("\n")), "jobs.csv", /5,000/);
  });
});
```

- [ ] **Step 2: Install the dependency and run the test to verify it fails**

Run: `pnpm install && pnpm --filter @ai-career/ingestion test -- upload`
Expected: FAIL — cannot resolve `./upload`. (`csv-parse` was declared in Task 1's `package.json`.)

- [ ] **Step 3: Write the implementation**

`packages/ingestion/src/adapters/upload.ts`:

```ts
import { createHash } from "node:crypto";
import { parse as parseCsv } from "csv-parse/sync";
import { UploadRowSchema, type UploadRow } from "../sourceSchemas";
import type { RawRecord } from "../types";

export const MAX_UPLOAD_ROWS = 5000;

/** Thrown with a user-safe message. It never includes file content. */
export class UploadParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadParseError";
  }
}

const ALIASES: Record<string, keyof UploadRow | "id"> = {
  title: "title", jobtitle: "title", position: "title", role: "title",
  company: "company", companyname: "company", employer: "company", organization: "company",
  location: "location", city: "location",
  description: "description", jobdescription: "description", details: "description",
  url: "url", link: "url", joburl: "url", applyurl: "url",
  postedat: "postedAt", posted: "postedAt", dateposted: "postedAt", postingdate: "postedAt",
  employmenttype: "employmentType", type: "employmentType", commitment: "employmentType",
  salary: "salary", compensation: "salary", pay: "salary",
  id: "id", jobid: "id", externalid: "id",
};

function readObjects(buffer: Buffer, filename: string): Record<string, unknown>[] {
  if (buffer.includes(0)) throw new UploadParseError("File does not look like text (binary content found)");
  const text = buffer.toString("utf8");
  const name = filename.toLowerCase();

  if (name.endsWith(".json")) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new UploadParseError("File is not valid JSON");
    }
    const list = Array.isArray(data) ? data : (data as { jobs?: unknown } | null)?.jobs;
    if (!Array.isArray(list)) {
      throw new UploadParseError('JSON must be an array of jobs, or an object with a "jobs" array');
    }
    return list.map((row) => (row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {}));
  }

  if (name.endsWith(".csv")) {
    try {
      return parseCsv(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
    } catch {
      throw new UploadParseError("File is not valid CSV");
    }
  }
  throw new UploadParseError("Unsupported file type: use a .csv or .json file");
}

function toCanonical(raw: Record<string, unknown>): { row: Record<string, string>; id: string | null } {
  const row: Record<string, string> = {};
  let id: string | null = null;
  for (const [header, value] of Object.entries(raw)) {
    const key = ALIASES[header.toLowerCase().replace(/[^a-z0-9]/g, "")];
    if (!key || value === null || value === undefined || typeof value === "object") continue;
    const text = String(value).trim();
    if (!text) continue;
    if (key === "id") id ??= text;
    else row[key] ??= text;
  }
  return { row, id };
}

export function parseUploadFile(buffer: Buffer, filename: string): RawRecord[] {
  const objects = readObjects(buffer, filename);
  if (objects.length === 0) throw new UploadParseError("File contains no jobs");
  if (objects.length > MAX_UPLOAD_ROWS) throw new UploadParseError("File has more than 5,000 rows");

  const records: RawRecord[] = [];
  const seen = new Set<string>();
  const invalid: number[] = [];

  objects.forEach((raw, index) => {
    const { row, id } = toCanonical(raw);
    const parsed = UploadRowSchema.safeParse(row);
    if (!parsed.success) {
      invalid.push(index + 1);
      return;
    }
    const data = parsed.data;
    const externalId =
      id ??
      createHash("sha256")
        .update([data.company, data.title, data.location ?? "", data.url ?? ""].join("\u0001"))
        .digest("hex")
        .slice(0, 32);
    if (seen.has(externalId)) return;
    seen.add(externalId);
    records.push({ externalId, payload: data });
  });

  if (invalid.length > 0) {
    const first = invalid.slice(0, 3).join(", ");
    throw new UploadParseError(
      `${invalid.length} row${invalid.length === 1 ? " is" : "s are"} invalid (first: rows ${first}): each needs a title and a company`
    );
  }
  return records;
}
```

Add to `packages/ingestion/src/index.ts`: `export * from "./adapters/upload";`

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/ingestion test && pnpm --filter @ai-career/ingestion typecheck && pnpm --filter @ai-career/ingestion lint`
Expected: PASS. (Row 1 = first data row, so the invalid rows in the test are rows 2 and 3.)

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(ingestion): add CSV/JSON upload parser"`

---

### Task 8: Database schema, migrations and RLS

**Files:**
- Create: `packages/db/src/schema/jobSources.ts`, `ingestionRuns.ts`, `rawJobPostings.ts`, `jobs.ts`, `jobPostings.ts`, `jobDuplicateCandidates.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create (generated): two migration files under `packages/db/migrations/` plus their `meta/` snapshot/journal updates
- Test: `packages/db/src/jobTables.rls.test.ts`

**Interfaces:**
- Consumes: the Drizzle/RLS conventions in `packages/db/src/schema/careerGoals.ts` and `migrations/0007_career_goal_rls.sql`.
- Produces (tables and enums used by Tasks 9–15). Exported names: `jobSources`, `ingestionRuns`, `rawJobPostings`, `jobs`, `jobPostings`, `jobDuplicateCandidates`; enums `jobSourceKindEnum`, `ingestionRunStatusEnum`, `jobStatusEnum`, `jobWorkModeEnum`, `jobSponsorshipEnum`, `salaryPeriodEnum`, `duplicateCandidateStatusEnum`. Column names are the camelCase of the snake_case SQL names shown below.

- [ ] **Step 1: Write the failing RLS test**

`packages/db/src/jobTables.rls.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import { withUserContext } from "./rls";
import { createDbClient } from "./client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";
const adminSql = postgres(ADMIN_URL);
const db = createDbClient({ DATABASE_URL: APP_URL });

const USER_A = "00000000-0000-0000-0000-0000000000f1";
const USER_B = "00000000-0000-0000-0000-0000000000f2";
const TABLES = [
  "job_sources", "ingestion_runs", "raw_job_postings", "jobs", "job_postings", "job_duplicate_candidates",
] as const;

async function wipe() {
  await adminSql`DELETE FROM jobs WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM job_sources WHERE user_id IN (${USER_A}, ${USER_B})`;
}

beforeAll(async () => {
  await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
  await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
  await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  await wipe();
});

afterAll(async () => {
  await wipe();
  await adminSql.end();
});

async function seedUserA() {
  const [source] = await adminSql`
    INSERT INTO job_sources (user_id, kind, label, config) VALUES (${USER_A}, 'greenhouse', 'Acme', '{"slug":"acme"}') RETURNING id`;
  await adminSql`INSERT INTO ingestion_runs (user_id, source_id, started_at) VALUES (${USER_A}, ${source.id}, now())`;
  await adminSql`INSERT INTO raw_job_postings (user_id, source_id, external_id, payload, content_hash)
                 VALUES (${USER_A}, ${source.id}, 'e1', '{}', 'h')`;
  const jobIds: string[] = [];
  for (const n of [1, 2]) {
    const [job] = await adminSql`
      INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_hash, first_seen_at, last_verified_at)
      VALUES (${USER_A}, 'Acme', 'acme', ${"Engineer " + n}, 'engineer', 'dh', now(), now()) RETURNING id`;
    jobIds.push(job.id);
    await adminSql`
      INSERT INTO job_postings (user_id, job_id, source_id, external_id, fingerprint, content_hash, normalized, first_seen_at, last_seen_at)
      VALUES (${USER_A}, ${job.id}, ${source.id}, ${"e" + n}, ${"fp" + n}, 'h', '{}', now(), now())`;
  }
  const [a, b] = jobIds.sort();
  await adminSql`INSERT INTO job_duplicate_candidates (user_id, job_id_a, job_id_b, similarity) VALUES (${USER_A}, ${a}, ${b}, 0.9)`;
}

describe("job intelligence tables — RLS", () => {
  it("isolates every table by user_id", async () => {
    await seedUserA();
    for (const table of TABLES) {
      const asA = await withUserContext(db, USER_A, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      const asB = await withUserContext(db, USER_B, (tx) => tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`));
      expect((asA as unknown as { n: number }[])[0].n, `${table} as A`).toBeGreaterThan(0);
      expect((asB as unknown as { n: number }[])[0].n, `${table} as B`).toBe(0);
    }
  });

  it("stamps user_id from the session variable when the insert omits it", async () => {
    const rows = await withUserContext(db, USER_B, (tx) =>
      tx.execute(sql`INSERT INTO job_sources (kind, label) VALUES ('lever', 'Beta') RETURNING user_id`)
    );
    expect((rows as unknown as { user_id: string }[])[0].user_id).toBe(USER_B);
  });

  it("refuses a second board with the same kind and slug (case-insensitive), but allows the same slug on another kind", async () => {
    const insert = (kind: string, slug: string) =>
      // postgres-js cannot bind an object to a jsonb parameter; pass JSON text and cast.
      adminSql`INSERT INTO job_sources (user_id, kind, label, config) VALUES (${USER_A}, ${kind}, 'x', ${JSON.stringify({ slug })}::jsonb)`;
    await insert("lever", "dup-board");
    await expect(insert("lever", "DUP-BOARD")).rejects.toThrow(/duplicate key|unique/i);
    await expect(insert("greenhouse", "dup-board")).resolves.toBeDefined();
  });

  it("supports trigram similarity on job titles (pg_trgm is enabled and indexed)", async () => {
    const rows = await adminSql`SELECT similarity('data engineer', 'data engineers') AS s`;
    expect(Number(rows[0].s)).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai-career/db test -- jobTables`
Expected: FAIL — `relation "job_sources" does not exist` (migrations not yet generated).

- [ ] **Step 3: Write the schema**

`packages/db/src/schema/jobSources.ts`:

```ts
import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, jsonb, boolean, timestamp } from "drizzle-orm/pg-core";

export const jobSourceKindEnum = pgEnum("job_source_kind", ["greenhouse", "lever", "upload"]);
export const ingestionRunStatusEnum = pgEnum("ingestion_run_status", ["running", "succeeded", "failed"]);

// The watch-list. `consent_confirmed_at` is the D3 gate: the worker refuses to
// run a source where it is null. A partial unique index (custom migration)
// prevents adding the same board twice.
export const jobSources = pgTable("job_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  kind: jobSourceKindEnum("kind").notNull(),
  label: text("label").notNull(),
  config: jsonb("config").$type<{ slug?: string; companyName?: string }>().notNull().default(sql`'{}'::jsonb`),
  enabled: boolean("enabled").notNull().default(false),
  consentConfirmedAt: timestamp("consent_confirmed_at", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastRunStatus: ingestionRunStatusEnum("last_run_status"),
  // An error CLASS only (D29) -- never a message that could carry posting content.
  lastErrorClass: text("last_error_class"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

`packages/db/src/schema/ingestionRuns.ts`:

```ts
import { sql } from "drizzle-orm";
import { pgTable, uuid, integer, boolean, text, timestamp } from "drizzle-orm/pg-core";
import { jobSources, ingestionRunStatusEnum } from "./jobSources";

// One row per fetch attempt. Only `complete = true` runs may close jobs.
export const ingestionRuns = pgTable("ingestion_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => jobSources.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: ingestionRunStatusEnum("status").notNull().default("running"),
  complete: boolean("complete").notNull().default(false),
  fetchedCount: integer("fetched_count").notNull().default(0),
  newCount: integer("new_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  unchangedCount: integer("unchanged_count").notNull().default(0),
  closedCount: integer("closed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  errorClass: text("error_class"),
});
```

`packages/db/src/schema/rawJobPostings.ts`:

```ts
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { jobSources } from "./jobSources";

// Latest source payload per (source, external id) -- a snapshot, not a history.
// Kept so normalizer/parser improvements can be re-run without refetching, and
// so postings that vanish from a source's API stay debuggable.
export const rawJobPostings = pgTable(
  "raw_job_postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => jobSources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    payload: jsonb("payload").notNull(),
    contentHash: text("content_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceExternalUniq: uniqueIndex("raw_job_postings_source_external_uniq").on(t.sourceId, t.externalId),
  })
);
```

`packages/db/src/schema/jobs.ts`:

```ts
import { sql } from "drizzle-orm";
import {
  pgTable, pgEnum, uuid, text, integer, numeric, boolean, jsonb, timestamp,
} from "drizzle-orm/pg-core";

export const jobStatusEnum = pgEnum("job_status", ["open", "closed"]);
export const jobWorkModeEnum = pgEnum("job_work_mode", ["remote", "hybrid", "onsite", "unknown"]);
export const jobSponsorshipEnum = pgEnum("job_sponsorship", ["offered", "not_offered", "unknown"]);
export const salaryPeriodEnum = pgEnum("salary_period", ["year", "month", "hour"]);

// Canonical job with a persistent identity. Rows are (re)computed from the
// job's postings by packages/ingestion's pure mergePostings; `field_provenance`
// records which posting supplied each field group.
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),

  companyName: text("company_name").notNull(),
  companyKey: text("company_key").notNull(),
  title: text("title").notNull(),
  titleKey: text("title_key").notNull(),
  seniority: text("seniority"),

  locationRaw: text("location_raw"),
  locationKey: text("location_key").notNull().default(""),
  // Only when the source states it structurally (Lever); Greenhouse leaves this null.
  countryCode: text("country_code"),
  workMode: jobWorkModeEnum("work_mode").notNull().default("unknown"),
  employmentType: text("employment_type"),

  // Sanitized plain text. Untrusted input: never interpreted as HTML.
  descriptionText: text("description_text").notNull().default(""),
  descriptionHash: text("description_hash").notNull(),

  // D6: raw + normalized + currency + period + is_parsed. Missing is null, never zero.
  salaryRaw: text("salary_raw"),
  salaryMin: numeric("salary_min"),
  salaryMax: numeric("salary_max"),
  salaryCurrency: text("salary_currency"),
  salaryPeriod: salaryPeriodEnum("salary_period"),
  salaryIsParsed: boolean("salary_is_parsed").notNull().default(false),

  minExperienceYears: integer("min_experience_years"),
  minExperienceEvidence: text("min_experience_evidence"),
  sponsorship: jobSponsorshipEnum("sponsorship").notNull().default("unknown"),
  sponsorshipEvidence: text("sponsorship_evidence"),
  sponsorshipConflict: boolean("sponsorship_conflict").notNull().default(false),

  postedAt: timestamp("posted_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }).notNull(),

  status: jobStatusEnum("status").notNull().default("open"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  fieldProvenance: jsonb("field_provenance").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

`packages/db/src/schema/jobPostings.ts`:

```ts
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { jobs, jobStatusEnum } from "./jobs";
import { jobSources } from "./jobSources";

// One row per source appearance of a job. `normalized` is the NormalizedJob
// snapshot the canonical job is recomputed from; `fingerprint` drives tier-2
// identity; `content_hash` (of the raw payload) lets unchanged records skip
// the pipeline.
export const jobPostings = pgTable(
  "job_postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => jobSources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    url: text("url"),
    fingerprint: text("fingerprint").notNull(),
    contentHash: text("content_hash").notNull(),
    normalized: jsonb("normalized").notNull(),
    status: jobStatusEnum("status").notNull().default("open"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    sourceExternalUniq: uniqueIndex("job_postings_source_external_uniq").on(t.sourceId, t.externalId),
  })
);
```

`packages/db/src/schema/jobDuplicateCandidates.ts`:

```ts
import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, real, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";

export const duplicateCandidateStatusEnum = pgEnum("duplicate_candidate_status", ["pending", "same", "different"]);

// Trigram near-matches. Never auto-merged: a false merge hides a real job, a
// false split only shows one extra row. Phase 4 writes `pending` only. The
// pair is stored with job_id_a < job_id_b so the unique index de-duplicates it.
export const jobDuplicateCandidates = pgTable(
  "job_duplicate_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobIdA: uuid("job_id_a")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    jobIdB: uuid("job_id_b")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    similarity: real("similarity").notNull(),
    status: duplicateCandidateStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pairUniq: uniqueIndex("job_duplicate_candidates_pair_uniq").on(t.jobIdA, t.jobIdB),
  })
);
```

Append to `packages/db/src/schema/index.ts`:

```ts
export * from "./jobSources";
export * from "./ingestionRuns";
export * from "./rawJobPostings";
export * from "./jobs";
export * from "./jobPostings";
export * from "./jobDuplicateCandidates";
```

- [ ] **Step 4: Generate the migrations**

Generate the table DDL, then a *custom* (hand-written) migration for RLS, the extension and the expression/GIN indexes that drizzle-kit does not generate (same reason as `0001_users_rls.sql`):

```bash
pnpm --filter @ai-career/db exec dotenv -e ../../.env -- drizzle-kit generate --name=job_intelligence
pnpm --filter @ai-career/db exec dotenv -e ../../.env -- drizzle-kit generate --custom --name=job_intelligence_rls_and_indexes
```

Expected: two new files in `packages/db/migrations/` (numbered after `0008_high_bullseye.sql`), and `meta/_journal.json` updated. Open the first and confirm it creates the seven enums and six tables. Then replace the *body* of the second (custom) file with:

```sql
-- Custom SQL migration: RLS, pg_trgm and the indexes drizzle-kit cannot generate.
-- Follows 0001_users_rls.sql / 0007_career_goal_rls.sql.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE job_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON job_sources
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE ingestion_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON ingestion_runs
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE raw_job_postings ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON raw_job_postings
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON jobs
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE job_postings ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON job_postings
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE job_duplicate_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON job_duplicate_candidates
  USING (user_id = current_setting('app.current_user_id')::uuid);

-- The same board (kind + slug, case-insensitive) cannot be added twice. Uploads have no slug.
CREATE UNIQUE INDEX job_sources_user_kind_slug_uniq
  ON job_sources (user_id, kind, lower(config->>'slug'))
  WHERE kind <> 'upload';

-- Jobs list text filter (ILIKE) and tier-3 duplicate matching.
CREATE INDEX jobs_title_trgm_idx ON jobs USING gin (title gin_trgm_ops);
CREATE INDEX jobs_company_name_trgm_idx ON jobs USING gin (company_name gin_trgm_ops);
CREATE INDEX jobs_location_key_idx ON jobs (location_key);
CREATE INDEX jobs_status_idx ON jobs (status);

CREATE INDEX job_postings_fingerprint_idx ON job_postings (fingerprint);
CREATE INDEX job_postings_job_id_idx ON job_postings (job_id);
CREATE INDEX ingestion_runs_source_started_idx ON ingestion_runs (source_id, started_at DESC);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @ai-career/db test && pnpm --filter @ai-career/db typecheck`
Expected: PASS (existing RLS suites plus `jobTables`). Also apply to the dev database so later manual runs work: `pnpm --filter @ai-career/db db:migrate`.

- [ ] **Step 6: Checkpoint**

`git status --short` (expect the 6 new schema files, index, 2 migrations, meta files, the test). If authorized: `git commit -m "feat(db): add job intelligence tables with RLS and trigram indexes"`

---

### Task 9: `mergePostings` — the pure canonical-job merge

A canonical `jobs` row is *derived* from its postings. Keeping this a pure function (no DB) makes source precedence and provenance directly testable.

**Files:**
- Create: `packages/ingestion/src/identity/serialize.ts`, `packages/ingestion/src/identity/merge.ts`, `packages/ingestion/src/testing/factories.ts`
- Test: `packages/ingestion/src/identity/merge.test.ts`, `packages/ingestion/src/identity/serialize.test.ts`
- Modify: `packages/ingestion/src/index.ts`

**Interfaces:**
- Consumes: `NormalizedJob`, `SourceKind`, `SalaryPeriod`, `SponsorshipValue`, `WorkMode` (Task 1); `companyKey`, `titleKey`, `locationKey`, `descriptionHash` (Task 2, used by the test factory).
- Produces:
  - `serializeNormalized(job: NormalizedJob): Record<string, unknown>` / `deserializeNormalized(value: unknown): NormalizedJob` (Dates ↔ ISO strings for the `job_postings.normalized` jsonb).
  - `PostingForMerge { id; sourceKind: SourceKind; status: "open" | "closed"; firstSeenAt: Date; lastSeenAt: Date; normalized: NormalizedJob }`
  - `MergedJob` (fields below, camelCase names match the `jobs` columns; numbers are JS numbers)
  - `comparePostings(a, b): number`, `mergePostings(postings: PostingForMerge[]): MergedJob`
  - Test helper `makeNormalized(overrides?: Partial<NormalizedJob>): NormalizedJob` (in `src/testing/factories.ts`, **not** exported from `index.ts`).

- [ ] **Step 1: Write the failing tests**

`packages/ingestion/src/testing/factories.ts`:

```ts
import { companyKey, descriptionHash, locationKey, titleKey } from "../normalize/keys";
import type { NormalizedJob } from "../types";

/** A minimal valid NormalizedJob; keys/hashes are derived from the fields you override. */
export function makeNormalized(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  const companyName = overrides.companyName ?? "Acme";
  const title = overrides.title ?? "Data Engineer";
  const locationRaw = overrides.locationRaw !== undefined ? overrides.locationRaw : "Berlin";
  const descriptionText = overrides.descriptionText ?? "Build data pipelines.";
  const tk = titleKey(title);
  return {
    externalId: "ext-1",
    url: "https://acme.example/jobs/1",
    companyName,
    companyKey: companyKey(companyName),
    title,
    titleKey: tk.titleKey,
    seniority: tk.seniority,
    locationRaw,
    locationKey: locationKey(locationRaw),
    countryCode: null,
    workMode: "unknown",
    employmentType: null,
    descriptionText,
    descriptionHash: descriptionHash(descriptionText),
    salary: { raw: null, min: null, max: null, currency: null, period: null, isParsed: false },
    minExperience: { years: null, evidence: null },
    sponsorship: { value: "unknown", evidence: null, conflict: false },
    postedAt: null,
    ...overrides,
  };
}
```

`packages/ingestion/src/identity/serialize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deserializeNormalized, serializeNormalized } from "./serialize";
import { makeNormalized } from "../testing/factories";

describe("serializeNormalized / deserializeNormalized", () => {
  it("round-trips, including a Date postedAt and a null one, through JSON", () => {
    for (const postedAt of [new Date("2026-05-22T13:16:29.000Z"), null]) {
      const job = makeNormalized({ postedAt, workMode: "remote" });
      const roundTripped = deserializeNormalized(JSON.parse(JSON.stringify(serializeNormalized(job))));
      expect(roundTripped).toEqual(job);
    }
  });
});
```

`packages/ingestion/src/identity/merge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mergePostings, comparePostings, type PostingForMerge } from "./merge";
import { makeNormalized } from "../testing/factories";
import type { NormalizedJob, SourceKind } from "../types";

const at = (iso: string) => new Date(iso);
function posting(
  id: string,
  sourceKind: SourceKind,
  overrides: Partial<NormalizedJob> = {},
  extra: Partial<PostingForMerge> = {}
): PostingForMerge {
  return {
    id, sourceKind, status: "open",
    firstSeenAt: at("2026-09-01T00:00:00Z"), lastSeenAt: at("2026-09-10T00:00:00Z"),
    normalized: makeNormalized(overrides), ...extra,
  };
}

describe("mergePostings", () => {
  it("maps a single posting straight through", () => {
    const merged = mergePostings([
      posting("p1", "greenhouse", {
        title: "Senior Data Engineer", workMode: "remote", employmentType: "Full-time", countryCode: "GB",
        salary: { raw: "€60k", min: 60000, max: 80000, currency: "EUR", period: "year", isParsed: true },
        minExperience: { years: 3, evidence: "3+ years" },
        sponsorship: { value: "offered", evidence: "we sponsor", conflict: false },
        postedAt: at("2026-08-01T00:00:00Z"),
      }),
    ]);
    expect(merged).toMatchObject({
      title: "Senior Data Engineer", titleKey: "data engineer", seniority: "senior", workMode: "remote",
      employmentType: "Full-time", countryCode: "GB",
      salaryMin: 60000, salaryMax: 80000, salaryCurrency: "EUR", salaryPeriod: "year", salaryIsParsed: true,
      minExperienceYears: 3, sponsorship: "offered", status: "open",
    });
    expect(merged.postedAt).toEqual(at("2026-08-01T00:00:00Z"));
    expect(merged.fieldProvenance.identity).toBe("p1");
  });

  it("orders postings: open before closed, then source rank, then recency, then id", () => {
    const gh = posting("a", "greenhouse");
    const up = posting("b", "upload", {}, { lastSeenAt: at("2026-09-20T00:00:00Z") });
    expect([up, gh].sort(comparePostings).map((p) => p.id)).toEqual(["a", "b"]); // rank beats recency
    const closedGh = posting("c", "greenhouse", {}, { status: "closed" });
    expect([closedGh, up].sort(comparePostings).map((p) => p.id)).toEqual(["b", "c"]); // open beats rank
    const older = posting("d", "lever", {}, { lastSeenAt: at("2026-09-01T00:00:00Z") });
    const newer = posting("e", "lever", {}, { lastSeenAt: at("2026-09-09T00:00:00Z") });
    expect([older, newer].sort(comparePostings).map((p) => p.id)).toEqual(["e", "d"]);
  });

  it("takes identity and description from the winner even when a lower-ranked source is newer", () => {
    const merged = mergePostings([
      posting("up", "upload", { title: "data engineer", descriptionText: "upload text" }, { lastSeenAt: at("2026-09-20T00:00:00Z") }),
      posting("gh", "greenhouse", { title: "Data Engineer", descriptionText: "greenhouse text" }),
    ]);
    expect(merged.title).toBe("Data Engineer");
    expect(merged.descriptionText).toBe("greenhouse text");
    expect(merged.fieldProvenance.identity).toBe("gh");
    expect(merged.fieldProvenance.description).toBe("gh");
  });

  it("fills fields the winner does not know from the next posting, and records where each came from", () => {
    const merged = mergePostings([
      posting("gh", "greenhouse", { workMode: "unknown", locationRaw: null }),
      posting("up", "upload", {
        workMode: "remote", employmentType: "Contract", locationRaw: "Lisbon",
        salary: { raw: "€50k", min: 50000, max: 50000, currency: "EUR", period: "year", isParsed: true },
        minExperience: { years: 2, evidence: "2+ years" },
        sponsorship: { value: "not_offered", evidence: "no visa", conflict: false },
      }),
    ]);
    expect(merged).toMatchObject({
      workMode: "remote", employmentType: "Contract", locationRaw: "Lisbon", locationKey: "lisbon",
      salaryMin: 50000, minExperienceYears: 2, sponsorship: "not_offered",
    });
    expect(merged.fieldProvenance).toMatchObject({
      identity: "gh", location: "up", workMode: "up", employmentType: "up", salary: "up", minExperience: "up", sponsorship: "up",
    });
  });

  it("prefers a parsed salary over a raw-only one, and a raw-only one over none", () => {
    const rawOnly = { raw: "$150k or £100k", min: null, max: null, currency: null, period: null, isParsed: false } as const;
    const parsed = { raw: "$90k", min: 90000, max: 90000, currency: "USD", period: "year", isParsed: true } as const;
    const a = mergePostings([posting("gh", "greenhouse", { salary: rawOnly }), posting("up", "upload", { salary: parsed })]);
    expect(a).toMatchObject({ salaryMin: 90000, salaryIsParsed: true });
    const b = mergePostings([posting("gh", "greenhouse"), posting("up", "upload", { salary: rawOnly })]);
    expect(b).toMatchObject({ salaryRaw: "$150k or £100k", salaryMin: null, salaryIsParsed: false });
    const c = mergePostings([posting("gh", "greenhouse")]);
    expect(c).toMatchObject({ salaryRaw: null, salaryMin: null, salaryIsParsed: false });
  });

  it("keeps a sponsorship conflict visible when no posting has a definite value", () => {
    const merged = mergePostings([
      posting("gh", "greenhouse", { sponsorship: { value: "unknown", evidence: "a || b", conflict: true } }),
    ]);
    expect(merged).toMatchObject({ sponsorship: "unknown", sponsorshipConflict: true, sponsorshipEvidence: "a || b" });
  });

  it("uses the earliest source-reported posted date across postings", () => {
    const merged = mergePostings([
      posting("gh", "greenhouse", { postedAt: at("2026-08-10T00:00:00Z") }),
      posting("up", "upload", { postedAt: at("2026-08-01T00:00:00Z") }),
    ]);
    expect(merged.postedAt).toEqual(at("2026-08-01T00:00:00Z"));
    expect(merged.fieldProvenance.postedAt).toBe("up");
    expect(mergePostings([posting("gh", "greenhouse")]).postedAt).toBeNull();
  });

  it("derives lifecycle: open while any posting is open; lastVerified is the newest open sighting", () => {
    const open = mergePostings([
      posting("gh", "greenhouse", {}, { status: "closed", lastSeenAt: at("2026-09-15T00:00:00Z") }),
      posting("up", "upload", {}, { lastSeenAt: at("2026-09-12T00:00:00Z"), firstSeenAt: at("2026-08-20T00:00:00Z") }),
    ]);
    expect(open.status).toBe("open");
    expect(open.lastVerifiedAt).toEqual(at("2026-09-12T00:00:00Z"));
    expect(open.firstSeenAt).toEqual(at("2026-08-20T00:00:00Z"));

    const closed = mergePostings([
      posting("gh", "greenhouse", {}, { status: "closed", lastSeenAt: at("2026-09-15T00:00:00Z") }),
      posting("up", "upload", {}, { status: "closed", lastSeenAt: at("2026-09-12T00:00:00Z") }),
    ]);
    expect(closed.status).toBe("closed");
    expect(closed.lastVerifiedAt).toEqual(at("2026-09-15T00:00:00Z"));
  });

  it("refuses an empty list", () => {
    expect(() => mergePostings([])).toThrow(/at least one posting/);
  });
});
```

Country rides with the *location* group: it comes from the first posting with a known location, or the winner.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-career/ingestion test -- identity`
Expected: FAIL — `./merge` / `./serialize` not found.

- [ ] **Step 3: Write the implementation**

`packages/ingestion/src/identity/serialize.ts`:

```ts
import type { NormalizedJob } from "../types";

/** `job_postings.normalized` is jsonb, so Dates travel as ISO strings. */
export function serializeNormalized(job: NormalizedJob): Record<string, unknown> {
  return { ...job, postedAt: job.postedAt ? job.postedAt.toISOString() : null };
}

export function deserializeNormalized(value: unknown): NormalizedJob {
  const v = value as Record<string, unknown>;
  return {
    ...(v as unknown as NormalizedJob),
    postedAt: typeof v.postedAt === "string" ? new Date(v.postedAt) : null,
  };
}
```

`packages/ingestion/src/identity/merge.ts`:

```ts
import type { NormalizedJob, SalaryPeriod, SourceKind, SponsorshipValue, WorkMode } from "../types";

export interface PostingForMerge {
  id: string;
  sourceKind: SourceKind;
  status: "open" | "closed";
  firstSeenAt: Date;
  lastSeenAt: Date;
  normalized: NormalizedJob;
}

export interface MergedJob {
  companyName: string;
  companyKey: string;
  title: string;
  titleKey: string;
  seniority: string | null;
  locationRaw: string | null;
  locationKey: string;
  countryCode: string | null;
  workMode: WorkMode;
  employmentType: string | null;
  descriptionText: string;
  descriptionHash: string;
  salaryRaw: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: SalaryPeriod | null;
  salaryIsParsed: boolean;
  minExperienceYears: number | null;
  minExperienceEvidence: string | null;
  sponsorship: SponsorshipValue;
  sponsorshipEvidence: string | null;
  sponsorshipConflict: boolean;
  postedAt: Date | null;
  firstSeenAt: Date;
  lastVerifiedAt: Date;
  status: "open" | "closed";
  /** field group -> id of the posting that supplied it. */
  fieldProvenance: Record<string, string>;
}

// Structured ATS APIs are more trustworthy than a hand-uploaded file.
const SOURCE_RANK: Record<SourceKind, number> = { greenhouse: 2, lever: 2, upload: 1 };

/** Sort order for "who wins a conflict": open first, then source rank, then most recently seen, then id (stable). */
export function comparePostings(a: PostingForMerge, b: PostingForMerge): number {
  if (a.status !== b.status) return a.status === "open" ? -1 : 1;
  const rank = SOURCE_RANK[b.sourceKind] - SOURCE_RANK[a.sourceKind];
  if (rank !== 0) return rank;
  const seen = b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
  if (seen !== 0) return seen;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function mergePostings(postings: PostingForMerge[]): MergedJob {
  if (postings.length === 0) throw new Error("mergePostings requires at least one posting");
  const sorted = [...postings].sort(comparePostings);
  const winner = sorted[0];
  const firstWith = (test: (n: NormalizedJob) => boolean) => sorted.find((p) => test(p.normalized));
  const provenance: Record<string, string> = { identity: winner.id, description: winner.id };

  // Location, country and locationKey travel together: they describe one place.
  const location = firstWith((n) => n.locationKey !== "") ?? winner;
  provenance.location = location.id;
  const mode = firstWith((n) => n.workMode !== "unknown") ?? winner;
  provenance.workMode = mode.id;
  const employment = firstWith((n) => n.employmentType !== null);
  if (employment) provenance.employmentType = employment.id;
  const salary = firstWith((n) => n.salary.isParsed) ?? firstWith((n) => n.salary.raw !== null) ?? winner;
  provenance.salary = salary.id;
  const experience = firstWith((n) => n.minExperience.years !== null);
  if (experience) provenance.minExperience = experience.id;
  const sponsorship =
    firstWith((n) => n.sponsorship.value !== "unknown") ?? firstWith((n) => n.sponsorship.conflict) ?? winner;
  provenance.sponsorship = sponsorship.id;

  // The original posted date is the earliest one any source reports.
  let posted: PostingForMerge | undefined;
  for (const p of postings) {
    const d = p.normalized.postedAt;
    if (d && (!posted || d < (posted.normalized.postedAt as Date))) posted = p;
  }
  if (posted) provenance.postedAt = posted.id;

  const open = postings.filter((p) => p.status === "open");
  const verifiedFrom = open.length > 0 ? open : postings;
  const maxTime = (list: PostingForMerge[]) => new Date(Math.max(...list.map((p) => p.lastSeenAt.getTime())));

  const w = winner.normalized;
  const s = salary.normalized.salary;
  return {
    companyName: w.companyName,
    companyKey: w.companyKey,
    title: w.title,
    titleKey: w.titleKey,
    seniority: w.seniority,
    locationRaw: location.normalized.locationRaw,
    locationKey: location.normalized.locationKey,
    countryCode: location.normalized.countryCode,
    workMode: mode.normalized.workMode,
    employmentType: employment?.normalized.employmentType ?? null,
    descriptionText: w.descriptionText,
    descriptionHash: w.descriptionHash,
    salaryRaw: s.raw,
    salaryMin: s.min,
    salaryMax: s.max,
    salaryCurrency: s.currency,
    salaryPeriod: s.period,
    salaryIsParsed: s.isParsed,
    minExperienceYears: experience?.normalized.minExperience.years ?? null,
    minExperienceEvidence: experience?.normalized.minExperience.evidence ?? null,
    sponsorship: sponsorship.normalized.sponsorship.value,
    sponsorshipEvidence: sponsorship.normalized.sponsorship.evidence,
    sponsorshipConflict: sponsorship.normalized.sponsorship.conflict,
    postedAt: posted?.normalized.postedAt ?? null,
    firstSeenAt: new Date(Math.min(...postings.map((p) => p.firstSeenAt.getTime()))),
    lastVerifiedAt: maxTime(verifiedFrom),
    status: open.length > 0 ? "open" : "closed",
    fieldProvenance: provenance,
  };
}
```

Add to `packages/ingestion/src/index.ts`:

```ts
export * from "./identity/serialize";
export * from "./identity/merge";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/ingestion test && pnpm --filter @ai-career/ingestion typecheck`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(ingestion): add pure mergePostings with source precedence and provenance"`

---

### Task 10: Persistence — `persistPosting`, `recomputeJob`, fuzzy flagging, closing

**Files:**
- Create: `packages/ingestion/src/pipeline/recomputeJob.ts`, `packages/ingestion/src/pipeline/persistPosting.ts`, `packages/ingestion/src/pipeline/closeMissing.ts`, `packages/ingestion/src/testing/db.ts`
- Test: `packages/ingestion/src/pipeline/persistPosting.test.ts`, `packages/ingestion/src/pipeline/closeMissing.test.ts`
- Modify: `packages/ingestion/src/index.ts`

**Interfaces:**
- Consumes: `schema` + `withUserContext` + `DbClient` from `@ai-career/db` (Task 8 tables); `mergePostings`, `serializeNormalized`, `deserializeNormalized` (Task 9); `computeFingerprint` (Task 2); `NormalizedJob`, `SourceKind`.
- Produces:
  - `FUZZY_DUPLICATE_THRESHOLD = 0.8`
  - `persistPosting(tx: DbClient, input: { sourceId: string; sourceKind: SourceKind; normalized: NormalizedJob; contentHash: string; now: Date }): Promise<{ jobId: string; outcome: "created" | "linked" | "updated" | "unchanged" }>` — call inside `withUserContext`.
  - `recomputeJob(tx: DbClient, jobId: string, now: Date): Promise<void>`
  - `closeMissingPostings(tx: DbClient, sourceId: string, runStartedAt: Date, now: Date): Promise<number>` (returns postings closed)
  - Test helpers `openTestDb(): Promise<{ adminSql; db; close() }>`, `wipeUser(adminSql, userId)`, `insertSource(adminSql, userId, opts?): Promise<string>` (in `src/testing/db.ts`, not exported from `index.ts`).

- [ ] **Step 1: Write the test helpers and the failing tests**

`packages/ingestion/src/testing/db.ts`:

```ts
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { closeDbClient, createDbClient, type DbClient } from "@ai-career/db";

// packages/ingestion/src/testing -> packages/db/migrations
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const ADMIN_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test";

export interface TestDb {
  /** Superuser connection: seeds, inspects and wipes. Bypasses RLS -- never use it for behavior under test. */
  adminSql: postgres.Sql;
  /** App-role client: what the code under test uses, RLS enforced. */
  db: DbClient;
  close(): Promise<void>;
}

// Test files and packages run concurrently against one shared database. On an empty database two
// simultaneous migrate() calls collide creating the same enum type ("pg_type_typname_nsp_index"), so
// migration is serialized with an advisory lock. (CI additionally migrates once before the tests.)
const MIGRATION_LOCK = 7420001;

export async function openTestDb(): Promise<TestDb> {
  const adminSql = postgres(ADMIN_URL);
  const lock = await adminSql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
    await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
    await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  } finally {
    await lock`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    lock.release();
  }
  const db = createDbClient({ DATABASE_URL: APP_URL });
  return {
    adminSql,
    db,
    close: async () => {
      await closeDbClient(db);
      await adminSql.end();
    },
  };
}

/** Scoped to one user id: turbo/vitest run suites concurrently against the shared test database. */
export async function wipeUser(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_sources WHERE user_id = ${userId}`;
}

export async function insertSource(
  adminSql: postgres.Sql,
  userId: string,
  opts: { kind?: "greenhouse" | "lever" | "upload"; label?: string; slug?: string; enabled?: boolean; consent?: boolean } = {}
): Promise<string> {
  const kind = opts.kind ?? "greenhouse";
  const config = kind === "upload" ? {} : { slug: opts.slug ?? `board-${Math.random().toString(36).slice(2, 10)}` };
  const [row] = await adminSql`
    INSERT INTO job_sources (user_id, kind, label, config, enabled, consent_confirmed_at)
    VALUES (${userId}, ${kind}, ${opts.label ?? "Acme"}, ${JSON.stringify(config)}::jsonb,
            ${opts.enabled ?? true}, ${(opts.consent ?? true) ? new Date().toISOString() : null}::timestamptz)
    RETURNING id`;
  return row.id as string;
}
```

`packages/ingestion/src/pipeline/persistPosting.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { withUserContext } from "@ai-career/db";
import { persistPosting } from "./persistPosting";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";
import { makeNormalized } from "../testing/factories";
import type { NormalizedJob, SourceKind } from "../types";

const USER = "00000000-0000-0000-0000-0000000000a1";
const T0 = new Date("2026-09-21T10:00:00Z");
const T1 = new Date("2026-09-21T16:00:00Z");
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const persist = (sourceId: string, sourceKind: SourceKind, normalized: NormalizedJob, contentHash = "h1", now = T0) =>
  withUserContext(t.db, USER, (tx) => persistPosting(tx, { sourceId, sourceKind, normalized, contentHash, now }));
const jobsOf = () => t.adminSql`SELECT * FROM jobs WHERE user_id = ${USER} ORDER BY title`;
const postingsOf = () => t.adminSql`SELECT * FROM job_postings WHERE user_id = ${USER} ORDER BY external_id`;
const candidates = () => t.adminSql`SELECT * FROM job_duplicate_candidates WHERE user_id = ${USER}`;

describe("persistPosting", () => {
  it("creates a canonical job and its posting for a new record", async () => {
    const source = await insertSource(t.adminSql, USER);
    const res = await persist(source, "greenhouse", makeNormalized({
      externalId: "e1", title: "Senior Data Engineer", workMode: "remote",
      salary: { raw: "$150k", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true },
    }));
    expect(res.outcome).toBe("created");

    const [job] = await jobsOf();
    expect(job).toMatchObject({
      title: "Senior Data Engineer", title_key: "data engineer", seniority: "senior", company_key: "acme",
      work_mode: "remote", status: "open", salary_currency: "USD", salary_is_parsed: true,
    });
    expect(Number(job.salary_min)).toBe(150000);
    expect(new Date(job.first_seen_at)).toEqual(T0);
    const [posting] = await postingsOf();
    expect(posting.job_id).toBe(job.id);
    expect(job.field_provenance.identity).toBe(posting.id);
  });

  it("recognises an unchanged record: bumps last-seen/verified and creates nothing", async () => {
    const source = await insertSource(t.adminSql, USER);
    const n = makeNormalized({ externalId: "e1" });
    await persist(source, "greenhouse", n, "h1", T0);
    const res = await persist(source, "greenhouse", n, "h1", T1);
    expect(res.outcome).toBe("unchanged");
    expect(await jobsOf()).toHaveLength(1);
    const [posting] = await postingsOf();
    expect(new Date(posting.last_seen_at)).toEqual(T1);
    expect(new Date((await jobsOf())[0].last_verified_at)).toEqual(T1);
  });

  it("updates the canonical job when the same posting's content changes", async () => {
    const source = await insertSource(t.adminSql, USER);
    await persist(source, "greenhouse", makeNormalized({ externalId: "e1", title: "Data Engineer" }), "h1", T0);
    const res = await persist(source, "greenhouse", makeNormalized({ externalId: "e1", title: "Data Platform Engineer" }), "h2", T1);
    expect(res.outcome).toBe("updated");
    expect(await postingsOf()).toHaveLength(1);
    const jobs = await jobsOf();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe("Data Platform Engineer");
  });

  it("tier 2: the same fingerprint from another source links to the same job, and the higher-ranked source wins", async () => {
    const gh = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    const up = await insertSource(t.adminSql, USER, { kind: "upload" });
    await persist(gh, "greenhouse", makeNormalized({ externalId: "g1", title: "Data Engineer", workMode: "remote" }), "hg", T0);
    // Same company/title-key/location/description, different casing and id, seen LATER, lower rank.
    const res = await persist(up, "upload", makeNormalized({ externalId: "u1", title: "data engineer", employmentType: "Full-time" }), "hu", T1);
    expect(res.outcome).toBe("linked");

    const jobs = await jobsOf();
    expect(jobs).toHaveLength(1);
    expect(await postingsOf()).toHaveLength(2);
    expect(jobs[0].title).toBe("Data Engineer"); // greenhouse wins identity despite upload being newer
    expect(jobs[0].employment_type).toBe("Full-time"); // filled from the upload posting
    const [ghPosting] = await t.adminSql`SELECT id FROM job_postings WHERE external_id = 'g1'`;
    expect(jobs[0].field_provenance.identity).toBe(ghPosting.id);
  });

  it("tier 3: a same-place, same-title job with different content is flagged as a duplicate candidate, never merged", async () => {
    const source = await insertSource(t.adminSql, USER);
    await persist(source, "greenhouse", makeNormalized({ externalId: "e1", descriptionText: "Version one of the text." }));
    await persist(source, "greenhouse", makeNormalized({ externalId: "e2", descriptionText: "A quite different description." }));
    expect(await jobsOf()).toHaveLength(2);
    const pairs = await candidates();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].status).toBe("pending");
    expect(pairs[0].job_id_a < pairs[0].job_id_b).toBe(true);
    expect(Number(pairs[0].similarity)).toBeGreaterThanOrEqual(0.8);
  });

  it("does not flag jobs at a different location or with a dissimilar title", async () => {
    const source = await insertSource(t.adminSql, USER);
    await persist(source, "greenhouse", makeNormalized({ externalId: "e1", descriptionText: "one" }));
    await persist(source, "greenhouse", makeNormalized({ externalId: "e2", locationRaw: "Paris", descriptionText: "two" }));
    await persist(source, "greenhouse", makeNormalized({ externalId: "e3", title: "Office Chef", descriptionText: "three" }));
    expect(await jobsOf()).toHaveLength(3);
    expect(await candidates()).toHaveLength(0);
  });
});
```

`packages/ingestion/src/pipeline/closeMissing.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { withUserContext } from "@ai-career/db";
import { persistPosting } from "./persistPosting";
import { closeMissingPostings } from "./closeMissing";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";
import { makeNormalized } from "../testing/factories";
import type { NormalizedJob, SourceKind } from "../types";

const USER = "00000000-0000-0000-0000-0000000000a4";
const T0 = new Date("2026-09-21T10:00:00Z");
const RUN2_START = new Date("2026-09-21T16:00:00Z");
const T2 = new Date("2026-09-21T16:00:05Z");
const T3 = new Date("2026-09-21T22:00:00Z");
let t: TestDb;

beforeAll(async () => {
  t = await openTestDb();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const persist = (sourceId: string, kind: SourceKind, n: NormalizedJob, now: Date) =>
  withUserContext(t.db, USER, (tx) => persistPosting(tx, { sourceId, sourceKind: kind, normalized: n, contentHash: "h", now }));
const close = (sourceId: string) =>
  withUserContext(t.db, USER, (tx) => closeMissingPostings(tx, sourceId, RUN2_START, new Date("2026-09-21T16:01:00Z")));
const status = async (title: string) =>
  (await t.adminSql`SELECT status, closed_at FROM jobs WHERE user_id = ${USER} AND title = ${title}`)[0];

describe("closeMissingPostings", () => {
  it("closes only the postings not seen since the run started, and their jobs", async () => {
    const source = await insertSource(t.adminSql, USER);
    await persist(source, "greenhouse", makeNormalized({ externalId: "a", title: "Alpha Role", descriptionText: "a" }), T0);
    await persist(source, "greenhouse", makeNormalized({ externalId: "b", title: "Bravo Role", descriptionText: "b" }), T0);
    // Run 2 sees only "a".
    await persist(source, "greenhouse", makeNormalized({ externalId: "a", title: "Alpha Role", descriptionText: "a" }), T2);

    expect(await close(source)).toBe(1);
    expect((await status("Alpha Role")).status).toBe("open");
    const bravo = await status("Bravo Role");
    expect(bravo.status).toBe("closed");
    expect(bravo.closed_at).not.toBeNull();
  });

  it("reopens a closed job when its posting is seen again", async () => {
    const source = await insertSource(t.adminSql, USER);
    await persist(source, "greenhouse", makeNormalized({ externalId: "b", title: "Bravo Role" }), T0);
    await close(source);
    expect((await status("Bravo Role")).status).toBe("closed");

    const res = await persist(source, "greenhouse", makeNormalized({ externalId: "b", title: "Bravo Role" }), T3);
    expect(res.outcome).toBe("unchanged");
    const reopened = await status("Bravo Role");
    expect(reopened.status).toBe("open");
    expect(reopened.closed_at).toBeNull();
  });

  it("keeps a job open while any of its postings, from any source, is still open", async () => {
    const gh = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    const up = await insertSource(t.adminSql, USER, { kind: "upload" });
    await persist(gh, "greenhouse", makeNormalized({ externalId: "g1", title: "Shared Role" }), T0);
    await persist(up, "upload", makeNormalized({ externalId: "u1", title: "Shared Role" }), T0);

    await close(gh); // greenhouse posting unseen -> closed; the upload posting stays open
    expect((await status("Shared Role")).status).toBe("open");
    const postings = await t.adminSql`SELECT external_id, status FROM job_postings WHERE user_id = ${USER} ORDER BY external_id`;
    expect(postings.map((p) => [p.external_id, p.status])).toEqual([["g1", "closed"], ["u1", "open"]]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-career/ingestion test -- pipeline`
Expected: FAIL — `./persistPosting` / `./closeMissing` not found.

- [ ] **Step 3: Write the implementation**

`packages/ingestion/src/pipeline/recomputeJob.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { mergePostings, type MergedJob } from "../identity/merge";
import { deserializeNormalized } from "../identity/serialize";

const { jobs, jobPostings, jobSources } = schema;

export function mergedToJobRow(m: MergedJob, now: Date) {
  return {
    companyName: m.companyName,
    companyKey: m.companyKey,
    title: m.title,
    titleKey: m.titleKey,
    seniority: m.seniority,
    locationRaw: m.locationRaw,
    locationKey: m.locationKey,
    countryCode: m.countryCode,
    workMode: m.workMode,
    employmentType: m.employmentType,
    descriptionText: m.descriptionText,
    descriptionHash: m.descriptionHash,
    salaryRaw: m.salaryRaw,
    salaryMin: m.salaryMin === null ? null : String(m.salaryMin),
    salaryMax: m.salaryMax === null ? null : String(m.salaryMax),
    salaryCurrency: m.salaryCurrency,
    salaryPeriod: m.salaryPeriod,
    salaryIsParsed: m.salaryIsParsed,
    minExperienceYears: m.minExperienceYears,
    minExperienceEvidence: m.minExperienceEvidence,
    sponsorship: m.sponsorship,
    sponsorshipEvidence: m.sponsorshipEvidence,
    sponsorshipConflict: m.sponsorshipConflict,
    postedAt: m.postedAt,
    firstSeenAt: m.firstSeenAt,
    lastVerifiedAt: m.lastVerifiedAt,
    status: m.status,
    fieldProvenance: m.fieldProvenance,
    updatedAt: now,
  };
}

/** Rebuild the canonical job from all of its postings. The single writer of derived job fields. */
export async function recomputeJob(tx: DbClient, jobId: string, now: Date): Promise<void> {
  const rows = await tx
    .select({ posting: jobPostings, kind: jobSources.kind })
    .from(jobPostings)
    .innerJoin(jobSources, eq(jobPostings.sourceId, jobSources.id))
    .where(eq(jobPostings.jobId, jobId));
  if (rows.length === 0) return;

  const merged = mergePostings(
    rows.map(({ posting, kind }) => ({
      id: posting.id,
      sourceKind: kind,
      status: posting.status,
      firstSeenAt: posting.firstSeenAt,
      lastSeenAt: posting.lastSeenAt,
      normalized: deserializeNormalized(posting.normalized),
    }))
  );

  await tx
    .update(jobs)
    .set({
      ...mergedToJobRow(merged, now),
      // Stamp the close time once; keep it on later recomputes; clear it on reopen.
      closedAt: merged.status === "closed" ? sql`coalesce(${jobs.closedAt}, ${now.toISOString()}::timestamptz)` : null,
    })
    .where(eq(jobs.id, jobId));
}
```

`packages/ingestion/src/pipeline/persistPosting.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { mergePostings } from "../identity/merge";
import { serializeNormalized } from "../identity/serialize";
import { computeFingerprint } from "../normalize/keys";
import type { NormalizedJob, SourceKind } from "../types";
import { mergedToJobRow, recomputeJob } from "./recomputeJob";

const { jobs, jobPostings, jobDuplicateCandidates } = schema;

/** pg_trgm similarity of "company_key title_key" at or above which two same-location jobs are flagged. */
export const FUZZY_DUPLICATE_THRESHOLD = 0.8;

export type PersistOutcome = "created" | "linked" | "updated" | "unchanged";

export interface PersistInput {
  sourceId: string;
  sourceKind: SourceKind;
  normalized: NormalizedJob;
  /** Hash of the raw payload; an unchanged hash skips re-normalizing downstream work. */
  contentHash: string;
  now: Date;
}

/**
 * Identity, in order:
 *  1. exact key    -- the same (source, external id) is the same posting;
 *  2. fingerprint  -- the same company/title/location/description on another posting links to that job;
 *  3. fuzzy        -- a near-match at the same location is FLAGGED (job_duplicate_candidates), never merged.
 * Call inside `withUserContext`.
 */
export async function persistPosting(
  tx: DbClient,
  input: PersistInput
): Promise<{ jobId: string; outcome: PersistOutcome }> {
  const { sourceId, sourceKind, normalized, contentHash, now } = input;

  const [existing] = await tx
    .select()
    .from(jobPostings)
    .where(and(eq(jobPostings.sourceId, sourceId), eq(jobPostings.externalId, normalized.externalId)))
    .limit(1);

  if (existing && existing.contentHash === contentHash) {
    await tx.update(jobPostings).set({ lastSeenAt: now, status: "open" }).where(eq(jobPostings.id, existing.id));
    if (existing.status === "closed") await recomputeJob(tx, existing.jobId, now);
    else await tx.update(jobs).set({ lastVerifiedAt: now }).where(eq(jobs.id, existing.jobId));
    return { jobId: existing.jobId, outcome: "unchanged" };
  }

  const fingerprint = computeFingerprint(normalized);
  let jobId = existing?.jobId;
  let outcome: PersistOutcome = existing ? "updated" : "linked";

  if (!jobId) {
    const [match] = await tx
      .select({ jobId: jobPostings.jobId })
      .from(jobPostings)
      .where(eq(jobPostings.fingerprint, fingerprint))
      .limit(1);
    jobId = match?.jobId;
  }

  if (!jobId) {
    const merged = mergePostings([
      { id: "pending", sourceKind, status: "open", firstSeenAt: now, lastSeenAt: now, normalized },
    ]);
    const [created] = await tx.insert(jobs).values(mergedToJobRow(merged, now)).returning({ id: jobs.id });
    jobId = created.id;
    outcome = "created";
  }

  await tx
    .insert(jobPostings)
    .values({
      jobId,
      sourceId,
      externalId: normalized.externalId,
      url: normalized.url,
      fingerprint,
      contentHash,
      normalized: serializeNormalized(normalized),
      status: "open",
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [jobPostings.sourceId, jobPostings.externalId],
      set: {
        url: normalized.url,
        fingerprint,
        contentHash,
        normalized: serializeNormalized(normalized),
        status: "open",
        lastSeenAt: now,
      },
    });

  await recomputeJob(tx, jobId, now);
  if (outcome === "created") await flagFuzzyDuplicates(tx, jobId);
  return { jobId, outcome };
}

async function flagFuzzyDuplicates(tx: DbClient, jobId: string): Promise<void> {
  const rows = (await tx.execute(sql`
    SELECT b.id AS other_id,
           similarity(a.company_key || ' ' || a.title_key, b.company_key || ' ' || b.title_key) AS sim
    FROM jobs a
    JOIN jobs b ON b.location_key = a.location_key AND b.id <> a.id
    WHERE a.id = ${jobId}
      AND similarity(a.company_key || ' ' || a.title_key, b.company_key || ' ' || b.title_key) >= ${FUZZY_DUPLICATE_THRESHOLD}
  `)) as unknown as { other_id: string; sim: number }[];

  for (const row of rows) {
    const [jobIdA, jobIdB] = jobId < row.other_id ? [jobId, row.other_id] : [row.other_id, jobId];
    await tx
      .insert(jobDuplicateCandidates)
      .values({ jobIdA, jobIdB, similarity: Number(row.sim) })
      .onConflictDoNothing();
  }
}
```

`packages/ingestion/src/pipeline/closeMissing.ts`:

```ts
import { and, eq, lt } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { recomputeJob } from "./recomputeJob";

const { jobPostings } = schema;

/**
 * Close every open posting of `sourceId` that was not seen since `runStartedAt`, then recompute each
 * affected job (a job closes only when NONE of its postings, from any source, is open).
 * The caller must only invoke this for a COMPLETE run of a non-upload source.
 */
export async function closeMissingPostings(
  tx: DbClient,
  sourceId: string,
  runStartedAt: Date,
  now: Date
): Promise<number> {
  const closed = await tx
    .update(jobPostings)
    .set({ status: "closed" })
    .where(and(eq(jobPostings.sourceId, sourceId), eq(jobPostings.status, "open"), lt(jobPostings.lastSeenAt, runStartedAt)))
    .returning({ jobId: jobPostings.jobId });

  for (const jobId of new Set(closed.map((r) => r.jobId))) {
    await recomputeJob(tx, jobId, now);
  }
  return closed.length;
}
```

Add to `packages/ingestion/src/index.ts`:

```ts
export * from "./pipeline/persistPosting";
export * from "./pipeline/recomputeJob";
export * from "./pipeline/closeMissing";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/ingestion test && pnpm --filter @ai-career/ingestion typecheck`
Expected: PASS (Postgres and the Task 8 migrations must be applied to `career_intel_test`; the helper migrates automatically).

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(ingestion): persist postings with 3-tier identity, canonical recompute and closing"`

---

### Task 11: `runIngestion`, upload storage and the adapter registry

**Files:**
- Create: `packages/ingestion/src/pipeline/hashPayload.ts`, `storeUpload.ts`, `adapterFor.ts`, `runIngestion.ts`
- Test: `packages/ingestion/src/pipeline/hashPayload.test.ts`, `packages/ingestion/src/pipeline/runIngestion.test.ts`
- Modify: `packages/ingestion/src/index.ts`

**Interfaces:**
- Consumes: `normalizeRecord` (Task 5), adapters (Tasks 6–7), `persistPosting`, `closeMissingPostings` (Task 10), `openTestDb`/`wipeUser`/`insertSource`, the `jobSources`/`ingestionRuns`/`rawJobPostings`/`jobPostings` tables (Task 8).
- Produces:
  - `stableStringify(value: unknown): string`, `hashPayload(payload: unknown): string`
  - `storeUpload(tx: DbClient, input: { filename: string; records: RawRecord[]; now: Date }): Promise<{ sourceId: string; count: number }>` — call inside `withUserContext`; creates an enabled, consented `upload` source plus its raw records.
  - `createStoredRawAdapter(db, userId): SourceAdapter` and `createAdapterFor(opts: { db; userId; greenhouseBaseUrl; leverBaseUrl; fetchFn? }): (source: SourceRef) => SourceAdapter`
  - `runIngestion(db: DbClient, opts: { userId: string; sourceId: string; adapterFor: (s: SourceRef) => SourceAdapter; now?: () => Date }): Promise<RunSummary>` where `RunSummary = { runId; status: "succeeded" | "failed"; complete: boolean; fetched; created; updated; unchanged; closed; failed; errorClass: IngestErrorClass | "empty_result" | null }`. Throws `IngestError` (class only) after recording a failed run.

- [ ] **Step 1: Write the failing tests**

`packages/ingestion/src/pipeline/hashPayload.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hashPayload, stableStringify } from "./hashPayload";

describe("hashPayload", () => {
  it("is independent of object key order, at any depth", () => {
    expect(hashPayload({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(
      hashPayload({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 })
    );
  });

  it("changes when any value changes, and array order matters", () => {
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
    expect(hashPayload([1, 2])).not.toBe(hashPayload([2, 1]));
  });

  it("ignores undefined properties and yields a 64-char hex digest", () => {
    expect(hashPayload({ a: 1, b: undefined })).toBe(hashPayload({ a: 1 }));
    expect(hashPayload({})).toMatch(/^[0-9a-f]{64}$/);
    expect(stableStringify(null)).toBe("null");
  });
});
```

`packages/ingestion/src/pipeline/runIngestion.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { withUserContext } from "@ai-career/db";
import { runIngestion, type RunSummary } from "./runIngestion";
import { createAdapterFor } from "./adapterFor";
import { storeUpload } from "./storeUpload";
import { insertSource, openTestDb, wipeUser, type TestDb } from "../testing/db";
import { greenhouseJobFixture } from "../fixtures";
import { IngestError, type RawRecord, type SourceAdapter } from "../types";

const USER = "00000000-0000-0000-0000-0000000000a2";
const TITLES: Record<number, string> = { 1: "Data Engineer", 2: "Product Designer", 3: "Security Analyst" };
let t: TestDb;
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 8, 21, 10, 0, tick++));

beforeAll(async () => {
  t = await openTestDb();
});
beforeEach(async () => {
  tick = 0;
  await wipeUser(t.adminSql, USER);
});
afterAll(async () => {
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const rec = (id: number): RawRecord => ({ externalId: String(id), payload: { ...greenhouseJobFixture, id, title: TITLES[id] } });
async function* yielding(list: RawRecord[]) {
  for (const r of list) yield r;
}
const adapterFor = (fetch: () => AsyncIterable<RawRecord>) => vi.fn((): SourceAdapter => ({ fetch }));
const run = (sourceId: string, factory: ReturnType<typeof adapterFor>) =>
  runIngestion(t.db, { userId: USER, sourceId, adapterFor: factory, now: clock });
const ok = (sourceId: string, ...ids: number[]) => run(sourceId, adapterFor(() => yielding(ids.map(rec))));
const statuses = async () =>
  Object.fromEntries((await t.adminSql`SELECT title, status FROM jobs WHERE user_id = ${USER}`).map((r) => [r.title, r.status]));
const lastRun = async (sourceId: string) =>
  (await t.adminSql`SELECT * FROM ingestion_runs WHERE source_id = ${sourceId} ORDER BY started_at DESC LIMIT 1`)[0];
const sourceRow = async (sourceId: string) => (await t.adminSql`SELECT * FROM job_sources WHERE id = ${sourceId}`)[0];
const failureOf = async (p: Promise<RunSummary>) => {
  try {
    await p;
  } catch (e) {
    return e as IngestError;
  }
  throw new Error("expected the run to fail");
};

describe("runIngestion — a normal board", () => {
  it("ingests every record and records the run and the source's status", async () => {
    const source = await insertSource(t.adminSql, USER);
    const summary = await ok(source, 1, 2, 3);
    expect(summary).toMatchObject({ status: "succeeded", complete: true, fetched: 3, created: 3, updated: 0, unchanged: 0, closed: 0, failed: 0, errorClass: null });

    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open", "Security Analyst": "open" });
    const [job] = await t.adminSql`SELECT salary_min, salary_currency, salary_is_parsed FROM jobs WHERE user_id = ${USER} AND title = 'Data Engineer'`;
    expect(Number(job.salary_min)).toBe(150000);
    expect(job).toMatchObject({ salary_currency: "USD", salary_is_parsed: true });
    expect((await t.adminSql`SELECT count(*)::int AS n FROM raw_job_postings WHERE source_id = ${source}`)[0].n).toBe(3);

    expect(await lastRun(source)).toMatchObject({ status: "succeeded", complete: true, fetched_count: 3, new_count: 3, error_class: null });
    expect(await sourceRow(source)).toMatchObject({ last_run_status: "succeeded", last_error_class: null });
  });

  it("a second identical run changes nothing", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2, 3);
    expect(await ok(source, 1, 2, 3)).toMatchObject({ created: 0, updated: 0, unchanged: 3, closed: 0, complete: true });
  });

  it("closes jobs that disappear from a complete fetch", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2, 3);
    expect(await ok(source, 1, 2)).toMatchObject({ closed: 1, complete: true });
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open", "Security Analyst": "closed" });
  });
});

describe("runIngestion — safety", () => {
  it("a fetch that fails midway closes nothing and records only the error class", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2, 3);
    async function* dies() {
      yield rec(1);
      throw new IngestError("server_error");
    }
    const error = await failureOf(run(source, adapterFor(dies)));
    expect(error).toBeInstanceOf(IngestError);
    expect(error).toMatchObject({ errorClass: "server_error", retryable: true });

    expect(await lastRun(source)).toMatchObject({ status: "failed", complete: false, error_class: "server_error", fetched_count: 1 });
    expect(await sourceRow(source)).toMatchObject({ last_run_status: "failed", last_error_class: "server_error" });
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open", "Security Analyst": "open" });
  });

  it("an empty fetch is incomplete, so it cannot mass-close a board", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2);
    const summary = await ok(source);
    expect(summary).toMatchObject({ status: "succeeded", complete: false, fetched: 0, closed: 0, errorClass: "empty_result" });
    expect(await sourceRow(source)).toMatchObject({ last_error_class: "empty_result" });
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open" });
  });

  it("a record that cannot be normalized is counted and skipped, and its tracked posting stays open", async () => {
    const source = await insertSource(t.adminSql, USER);
    await ok(source, 1, 2);
    const broken: RawRecord = { externalId: "2", payload: { id: 2 } }; // no title
    const summary = await run(source, adapterFor(() => yielding([rec(1), broken])));
    expect(summary).toMatchObject({ fetched: 2, unchanged: 1, failed: 1, closed: 0, complete: true });
    expect(await statuses()).toEqual({ "Data Engineer": "open", "Product Designer": "open" });
  });

  it("an unexpected adapter error becomes a retryable 'unknown' and its message is never stored", async () => {
    const source = await insertSource(t.adminSql, USER);
    async function* leaks(): AsyncIterable<RawRecord> {
      throw new Error("secret posting content");
    }
    const error = await failureOf(run(source, adapterFor(leaks)));
    expect(error).toMatchObject({ errorClass: "unknown", retryable: true });
    expect(error.message).toBe("unknown");
    expect(JSON.stringify(await lastRun(source))).not.toContain("secret");
    expect(JSON.stringify(await sourceRow(source))).not.toContain("secret");
  });
});

describe("runIngestion — the consent gate (D3) is enforced in worker code", () => {
  it("never calls the adapter for a source without consent, and records why", async () => {
    const source = await insertSource(t.adminSql, USER, { consent: false });
    const factory = adapterFor(() => yielding([rec(1)]));
    const error = await failureOf(run(source, factory));
    expect(error).toMatchObject({ errorClass: "consent_missing", retryable: false });
    expect(factory).not.toHaveBeenCalled();
    expect(await lastRun(source)).toMatchObject({ status: "failed", error_class: "consent_missing" });
    expect(await statuses()).toEqual({});
  });

  it("refuses a disabled source, and reports an unknown source id as not_found", async () => {
    const disabled = await insertSource(t.adminSql, USER, { enabled: false });
    expect(await failureOf(ok(disabled, 1))).toMatchObject({ errorClass: "source_disabled", retryable: false });
    expect(await failureOf(ok("00000000-0000-0000-0000-00000000ffff", 1))).toMatchObject({ errorClass: "not_found" });
  });
});

describe("runIngestion — uploads", () => {
  it("processes a stored upload and never closes anything, even when a later run has fewer records", async () => {
    const uploadAdapterFor = createAdapterFor({ db: t.db, userId: USER, greenhouseBaseUrl: "http://unused.test", leverBaseUrl: "http://unused.test" });
    const records: RawRecord[] = [
      { externalId: "u1", payload: { title: "Data Analyst", company: "Acme" } },
      { externalId: "u2", payload: { title: "Site Reliability Engineer", company: "Acme" } },
    ];
    const stored = await withUserContext(t.db, USER, (tx) => storeUpload(tx, { filename: "jobs.csv", records, now: new Date("2026-09-21T09:00:00Z") }));
    expect(stored.count).toBe(2);
    expect(await sourceRow(stored.sourceId)).toMatchObject({ kind: "upload", label: "jobs.csv", enabled: true });
    expect((await sourceRow(stored.sourceId)).consent_confirmed_at).not.toBeNull();

    const first = await runIngestion(t.db, { userId: USER, sourceId: stored.sourceId, adapterFor: uploadAdapterFor, now: clock });
    expect(first).toMatchObject({ created: 2, closed: 0, complete: true });

    await t.adminSql`DELETE FROM raw_job_postings WHERE source_id = ${stored.sourceId} AND external_id = 'u2'`;
    const second = await runIngestion(t.db, { userId: USER, sourceId: stored.sourceId, adapterFor: uploadAdapterFor, now: clock });
    expect(second).toMatchObject({ unchanged: 1, closed: 0 });
    expect(await statuses()).toEqual({ "Data Analyst": "open", "Site Reliability Engineer": "open" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-career/ingestion test -- runIngestion hashPayload`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

Design notes the tests pin down: the consent gate is checked *in* `runIngestion` (D3); a fetch that dies midway, or returns nothing, is `complete = false` and closes nothing; a record that fails to normalize is counted and skipped, but its already-tracked posting is touched so it is not closed; errors are stored as a class only.

`packages/ingestion/src/pipeline/hashPayload.ts`:

```ts
import { createHash } from "node:crypto";

/** JSON with object keys sorted, so key order in a source's response never changes a record's hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`);
  return `{${entries.join(",")}}`;
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}
```

`packages/ingestion/src/pipeline/storeUpload.ts`:

```ts
import { schema, type DbClient } from "@ai-career/db";
import type { RawRecord } from "../types";
import { hashPayload } from "./hashPayload";

const { jobSources, rawJobPostings } = schema;
const INSERT_CHUNK = 500;

/**
 * Persist a parsed upload as a new upload-kind source plus its raw records, ready for the worker.
 * The caller has already confirmed the user's consent for this file (the upload API requires it),
 * so the source is created enabled and consented. Call inside `withUserContext`.
 */
export async function storeUpload(
  tx: DbClient,
  input: { filename: string; records: RawRecord[]; now: Date }
): Promise<{ sourceId: string; count: number }> {
  const [source] = await tx
    .insert(jobSources)
    .values({
      kind: "upload",
      label: input.filename.slice(0, 120),
      config: {},
      enabled: true,
      consentConfirmedAt: input.now,
    })
    .returning({ id: jobSources.id });

  for (let i = 0; i < input.records.length; i += INSERT_CHUNK) {
    await tx.insert(rawJobPostings).values(
      input.records.slice(i, i + INSERT_CHUNK).map((record) => ({
        sourceId: source.id,
        externalId: record.externalId,
        payload: record.payload,
        contentHash: hashPayload(record.payload),
        fetchedAt: input.now,
      }))
    );
  }
  return { sourceId: source.id, count: input.records.length };
}
```

`packages/ingestion/src/pipeline/adapterFor.ts`:

```ts
import { eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { createGreenhouseAdapter } from "../adapters/greenhouse";
import { createLeverAdapter } from "../adapters/lever";
import type { RawRecord, SourceAdapter, SourceRef } from "../types";

const { rawJobPostings } = schema;

/** An upload's "fetch" is reading back the raw records the upload API stored. */
export function createStoredRawAdapter(db: DbClient, userId: string): SourceAdapter {
  return {
    async *fetch(source: SourceRef): AsyncIterable<RawRecord> {
      const rows = await withUserContext(db, userId, (tx) =>
        tx
          .select({ externalId: rawJobPostings.externalId, payload: rawJobPostings.payload })
          .from(rawJobPostings)
          .where(eq(rawJobPostings.sourceId, source.id))
          .orderBy(rawJobPostings.externalId)
      );
      for (const row of rows) yield { externalId: row.externalId, payload: row.payload };
    },
  };
}

export interface AdapterForOptions {
  db: DbClient;
  userId: string;
  greenhouseBaseUrl: string;
  leverBaseUrl: string;
  fetchFn?: typeof fetch;
}

export function createAdapterFor(opts: AdapterForOptions): (source: SourceRef) => SourceAdapter {
  return (source) => {
    switch (source.kind) {
      case "greenhouse":
        return createGreenhouseAdapter({ baseUrl: opts.greenhouseBaseUrl, fetchFn: opts.fetchFn });
      case "lever":
        return createLeverAdapter({ baseUrl: opts.leverBaseUrl, fetchFn: opts.fetchFn });
      case "upload":
        return createStoredRawAdapter(opts.db, opts.userId);
    }
  };
}
```

`packages/ingestion/src/pipeline/runIngestion.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { normalizeRecord } from "../normalize/normalizeRecord";
import { IngestError, type IngestErrorClass, type NormalizedJob, type SourceAdapter, type SourceRef } from "../types";
import { closeMissingPostings } from "./closeMissing";
import { hashPayload } from "./hashPayload";
import { persistPosting } from "./persistPosting";

const { jobSources, ingestionRuns, rawJobPostings, jobPostings } = schema;

export interface RunIngestionOptions {
  userId: string;
  sourceId: string;
  adapterFor: (source: SourceRef) => SourceAdapter;
  now?: () => Date;
}

export interface RunSummary {
  runId: string;
  status: "succeeded" | "failed";
  /** True only when the fetch returned every record; only a complete run may close jobs. */
  complete: boolean;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  closed: number;
  failed: number;
  errorClass: IngestErrorClass | "empty_result" | null;
}

/**
 * One fetch -> store raw -> normalize -> identify/upsert -> close cycle for a source.
 * Throws `IngestError` (with a class only) when the run fails, after recording it.
 */
export async function runIngestion(db: DbClient, opts: RunIngestionOptions): Promise<RunSummary> {
  const { userId, sourceId } = opts;
  const now = opts.now ?? (() => new Date());
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, userId, fn);

  const [source] = await inUserContext((tx) => tx.select().from(jobSources).where(eq(jobSources.id, sourceId)).limit(1));
  if (!source) throw new IngestError("not_found");

  const startedAt = now();
  const [run] = await inUserContext((tx) =>
    tx.insert(ingestionRuns).values({ sourceId, startedAt }).returning({ id: ingestionRuns.id })
  );

  const counters = { fetched: 0, created: 0, updated: 0, unchanged: 0, closed: 0, failed: 0 };
  const finish = (status: "succeeded" | "failed", complete: boolean, errorClass: RunSummary["errorClass"]) =>
    inUserContext(async (tx) => {
      const finishedAt = now();
      await tx
        .update(ingestionRuns)
        .set({
          finishedAt,
          status,
          complete,
          fetchedCount: counters.fetched,
          newCount: counters.created,
          updatedCount: counters.updated,
          unchangedCount: counters.unchanged,
          closedCount: counters.closed,
          failedCount: counters.failed,
          errorClass,
        })
        .where(eq(ingestionRuns.id, run.id));
      await tx
        .update(jobSources)
        .set({ lastRunAt: finishedAt, lastRunStatus: status, lastErrorClass: errorClass })
        .where(eq(jobSources.id, sourceId));
    });
  const summary = (status: RunSummary["status"], complete: boolean, errorClass: RunSummary["errorClass"]): RunSummary => ({
    runId: run.id, status, complete, errorClass, ...counters,
  });

  // The D3 consent gate lives here, in worker code, not only in the UI.
  const guard: IngestErrorClass | null = !source.enabled
    ? "source_disabled"
    : !source.consentConfirmedAt
      ? "consent_missing"
      : null;
  if (guard) {
    await finish("failed", false, guard);
    throw new IngestError(guard);
  }

  const ref: SourceRef = { id: source.id, kind: source.kind, label: source.label, config: source.config };

  try {
    for await (const record of opts.adapterFor(ref).fetch(ref)) {
      counters.fetched++;
      await inUserContext(async (tx) => {
        const at = now();
        const contentHash = hashPayload(record.payload);
        await tx
          .insert(rawJobPostings)
          .values({ sourceId, externalId: record.externalId, payload: record.payload, contentHash, fetchedAt: at })
          .onConflictDoUpdate({
            target: [rawJobPostings.sourceId, rawJobPostings.externalId],
            set: { payload: record.payload, contentHash, fetchedAt: at },
          });

        let normalized: NormalizedJob | null;
        try {
          normalized = normalizeRecord(ref, record);
        } catch {
          normalized = null;
        }
        if (!normalized) {
          // Unreadable this time, but it WAS seen: keep an already-tracked posting alive so it is not closed.
          await tx
            .update(jobPostings)
            .set({ lastSeenAt: at })
            .where(and(eq(jobPostings.sourceId, sourceId), eq(jobPostings.externalId, record.externalId)));
          counters.failed++;
          return;
        }

        const { outcome } = await persistPosting(tx, {
          sourceId, sourceKind: source.kind, normalized, contentHash, now: at,
        });
        if (outcome === "created" || outcome === "linked") counters.created++;
        else if (outcome === "updated") counters.updated++;
        else counters.unchanged++;
      });
    }
  } catch (error) {
    const errorClass: IngestErrorClass = error instanceof IngestError ? error.errorClass : "unknown";
    await finish("failed", false, errorClass);
    throw error instanceof IngestError ? error : new IngestError("unknown");
  }

  // A fetch that returned nothing is more likely an API glitch than an emptied board: treat it as
  // incomplete so it can never mass-close a source's jobs.
  const complete = counters.fetched > 0;
  if (complete && source.kind !== "upload") {
    counters.closed = await inUserContext((tx) => closeMissingPostings(tx, sourceId, startedAt, now()));
  }
  const errorClass = complete ? null : "empty_result";
  await finish("succeeded", complete, errorClass);
  return summary("succeeded", complete, errorClass);
}
```

Add to `packages/ingestion/src/index.ts`:

```ts
export * from "./pipeline/hashPayload";
export * from "./pipeline/storeUpload";
export * from "./pipeline/adapterFor";
export * from "./pipeline/runIngestion";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/ingestion test && pnpm --filter @ai-career/ingestion typecheck && pnpm --filter @ai-career/ingestion lint`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(ingestion): add runIngestion with consent gate, safe closing and upload storage"`

---

### Task 12: `services/job-ingestion` — BullMQ worker, scheduler reconcile, entrypoint

**Files:**
- Create: `packages/ingestion/src/queue.ts`, `packages/ingestion/src/testing/index.ts`
- Modify: `packages/ingestion/package.json` (add an `exports` map), `packages/ingestion/src/index.ts`
- Create: `services/job-ingestion/package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `src/schedule.ts`, `src/reconcile.ts`, `src/worker.ts`, `src/main.ts`
- Test: `services/job-ingestion/src/schedule.test.ts`, `reconcile.test.ts`, `worker.test.ts`

**Interfaces:**
- Consumes: `runIngestion`, `createAdapterFor`, `IngestError` (Tasks 1, 11); `openTestDb`, `insertSource`, `wipeUser` (Task 10).
- Produces:
  - From `@ai-career/ingestion`: `INGEST_QUEUE_NAME = "job-ingestion"`, `INGEST_JOB_NAME = "ingest-source"`, `SCHEDULER_PREFIX`, `IngestJobData { sourceId: string }`, `ingestJobId(sourceId): string`, `schedulerIdFor(sourceId): string`, `INGEST_JOB_OPTIONS` (attempts 3, exponential backoff, remove-on-complete/fail). Task 13 (web) uses these to enqueue "Run now".
  - From `@ai-career/ingestion/testing`: the Task 9/10 test helpers plus `greenhouseJobFixture`, `leverPostingFixture`.
  - The `pnpm --filter @ai-career/job-ingestion start` process.

BullMQ API verified against the installed `bullmq@5.81.5`: `queue.upsertJobScheduler(id, { every }, { name, data, opts })`, `queue.getJobSchedulers()` (entries have `id?`/`key`), `queue.removeJobScheduler(id)`, `job.waitUntilFinished(queueEvents)`. If a later BullMQ changes these, read `node_modules/bullmq/dist/esm/classes/queue.d.ts`.

- [ ] **Step 1: Write the failing tests**

Integration tests use the real Redis and Postgres from `infra/docker-compose.yml` and a unique queue name per file, so a running dev worker is never disturbed.

`services/job-ingestion/src/schedule.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planSchedules } from "./schedule";

describe("planSchedules", () => {
  it("adds a scheduler for each eligible source that has none", () => {
    expect(planSchedules({ eligibleSourceIds: ["a", "b"], existingSchedulerIds: ["schedule-a"], refresh: false })).toEqual({
      upsert: [{ schedulerId: "schedule-b", sourceId: "b" }],
      remove: [],
    });
  });

  it("re-upserts every eligible scheduler on refresh (boot), so an interval change applies", () => {
    expect(planSchedules({ eligibleSourceIds: ["a", "b"], existingSchedulerIds: ["schedule-a"], refresh: true }).upsert).toEqual([
      { schedulerId: "schedule-a", sourceId: "a" },
      { schedulerId: "schedule-b", sourceId: "b" },
    ]);
  });

  it("removes schedulers whose source is no longer eligible, but never ones it did not create", () => {
    expect(
      planSchedules({ eligibleSourceIds: ["a"], existingSchedulerIds: ["schedule-a", "schedule-gone", "someone-elses"], refresh: false })
    ).toEqual({ upsert: [], remove: ["schedule-gone"] });
  });

  it("does nothing when everything already matches", () => {
    expect(planSchedules({ eligibleSourceIds: ["a"], existingSchedulerIds: ["schedule-a"], refresh: false })).toEqual({ upsert: [], remove: [] });
    expect(planSchedules({ eligibleSourceIds: [], existingSchedulerIds: [], refresh: true })).toEqual({ upsert: [], remove: [] });
  });
});
```

`services/job-ingestion/src/reconcile.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { insertSource, openTestDb, wipeUser, type TestDb } from "@ai-career/ingestion/testing";
import type { IngestJobData } from "@ai-career/ingestion";
import { reconcileSchedules } from "./reconcile";

const USER = "00000000-0000-0000-0000-0000000000a5";
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };

let t: TestDb;
let queue: Queue<IngestJobData>;

beforeAll(async () => {
  t = await openTestDb();
  queue = new Queue<IngestJobData>(`job-ingestion-test-${randomUUID()}`, { connection });
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
  for (const s of await queue.getJobSchedulers()) await queue.removeJobScheduler((s.id ?? s.key) as string);
});
afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const reconcile = (refresh = false) =>
  reconcileSchedules({ db: t.db, userId: USER, queue, everyMs: 3_600_000, refresh });
const schedulerIds = async () => (await queue.getJobSchedulers()).map((s) => s.id ?? s.key).sort();

describe("reconcileSchedules", () => {
  it("schedules only enabled, consented, non-upload sources", async () => {
    const eligible = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    await insertSource(t.adminSql, USER, { kind: "lever", consent: false });
    await insertSource(t.adminSql, USER, { kind: "greenhouse", enabled: false });
    await insertSource(t.adminSql, USER, { kind: "upload" });

    await reconcile(true);
    expect(await schedulerIds()).toEqual([`schedule-${eligible}`]);
  });

  it("removes a scheduler when its source is disabled, and a second pass changes nothing", async () => {
    const source = await insertSource(t.adminSql, USER, { kind: "lever" });
    await reconcile();
    expect(await schedulerIds()).toEqual([`schedule-${source}`]);

    expect(await reconcile()).toEqual({ upsert: [], remove: [] }); // idempotent: the timer is not reset

    await t.adminSql`UPDATE job_sources SET enabled = false WHERE id = ${source}`;
    expect(await reconcile()).toEqual({ upsert: [], remove: [`schedule-${source}`] });
    expect(await schedulerIds()).toEqual([]);
  });

  it("gives each scheduled job the source id as its payload", async () => {
    const source = await insertSource(t.adminSql, USER, { kind: "greenhouse" });
    await reconcile();
    const [scheduler] = await queue.getJobSchedulers();
    expect(scheduler.every).toBe(3_600_000);
    expect(scheduler.template?.data).toEqual({ sourceId: source });
  });
});
```

`services/job-ingestion/src/worker.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, QueueEvents, type Worker } from "bullmq";
import { greenhouseJobFixture, insertSource, openTestDb, wipeUser, type TestDb } from "@ai-career/ingestion/testing";
import { INGEST_JOB_NAME, IngestError, ingestJobId, type IngestJobData, type RawRecord, type SourceAdapter } from "@ai-career/ingestion";
import { createIngestWorker } from "./worker";

const USER = "00000000-0000-0000-0000-0000000000a6";
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), maxRetriesPerRequest: null };
const queueName = `job-ingestion-test-${randomUUID()}`;

let t: TestDb;
let queue: Queue<IngestJobData>;
let events: QueueEvents;
let worker: Worker<IngestJobData>;
let adapter: SourceAdapter;

beforeAll(async () => {
  t = await openTestDb();
  queue = new Queue<IngestJobData>(queueName, { connection });
  events = new QueueEvents(queueName, { connection });
  await events.waitUntilReady();
  worker = createIngestWorker({ connection, db: t.db, userId: USER, adapterFor: () => adapter, queueName });
  await worker.waitUntilReady();
});
beforeEach(async () => {
  await wipeUser(t.adminSql, USER);
});
afterAll(async () => {
  await worker.close();
  await events.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await wipeUser(t.adminSql, USER);
  await t.close();
});

const enqueue = (sourceId: string, opts: Record<string, unknown> = {}) =>
  queue.add(INGEST_JOB_NAME, { sourceId }, { jobId: ingestJobId(sourceId), ...opts });

describe("ingest worker", () => {
  it("runs an enqueued source end to end", async () => {
    const source = await insertSource(t.adminSql, USER);
    const record: RawRecord = { externalId: "1", payload: greenhouseJobFixture };
    adapter = { fetch: async function* () { yield record; } };

    await (await enqueue(source)).waitUntilFinished(events);

    const jobs = await t.adminSql`SELECT title, status FROM jobs WHERE user_id = ${USER}`;
    expect(jobs).toEqual([{ title: "AI Engineer", status: "open" }]);
  });

  it("does not retry a permanent failure (a source without consent)", async () => {
    const source = await insertSource(t.adminSql, USER, { consent: false });
    const fetch = vi.fn(async function* (): AsyncIterable<RawRecord> {});
    adapter = { fetch };

    const job = await enqueue(source, { attempts: 3, backoff: { type: "fixed", delay: 10 }, removeOnFail: false });
    await expect(job.waitUntilFinished(events)).rejects.toThrow("consent_missing");

    expect((await queue.getJob(ingestJobId(source)))?.attemptsMade).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect((await t.adminSql`SELECT count(*)::int AS n FROM ingestion_runs WHERE source_id = ${source}`)[0].n).toBe(1);
  });

  it("retries a transient failure up to the attempt limit, recording every attempt", async () => {
    const source = await insertSource(t.adminSql, USER);
    adapter = {
      fetch: async function* (): AsyncIterable<RawRecord> {
        throw new IngestError("server_error");
      },
    };

    const job = await enqueue(source, { attempts: 2, backoff: { type: "fixed", delay: 20 }, removeOnFail: false });
    await expect(job.waitUntilFinished(events)).rejects.toThrow("server_error");

    expect((await queue.getJob(ingestJobId(source)))?.attemptsMade).toBe(2);
    const runs = await t.adminSql`SELECT status, error_class FROM ingestion_runs WHERE source_id = ${source}`;
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === "failed" && r.error_class === "server_error")).toBe(true);
  });
});
```

- [ ] **Step 2: Create the package files and install**

`services/job-ingestion/package.json`, `tsconfig.json`, `eslint.config.mjs` and `vitest.config.ts` (the `e2e` include is used by Task 19; `lint` is widened there):

`services/job-ingestion/package.json`:

```json
{
  "name": "@ai-career/job-ingestion",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "dotenv -e ../../.env -- tsx src/main.ts",
    "dev": "dotenv -e ../../.env -- tsx watch src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@ai-career/config": "workspace:*",
    "@ai-career/db": "workspace:*",
    "@ai-career/ingestion": "workspace:*",
    "bullmq": "^5.34.0",
    "drizzle-orm": "^0.36.0",
    "ioredis": "^5.4.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "dotenv-cli": "^7.4.0",
    "eslint": "^9.0.0",
    "postgres": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```

`services/job-ingestion/tsconfig.json`:

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": [
      "node"
    ]
  },
  "include": [
    "src",
    "e2e"
  ]
}
```

`services/job-ingestion/eslint.config.mjs`:

```js
import baseConfig from "../../eslint.config.base.mjs";

export default baseConfig;
```

`services/job-ingestion/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests migrate the shared test database and share one Redis.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
```

Give `@ai-career/ingestion` a `./testing` entry so other packages' integration tests can share its test helpers without reaching across package boundaries or leaking test data into production imports. In `packages/ingestion/package.json`, add this after the `"types"` line (keep `main`/`types`):

```json
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing/index.ts"
  },
```

Run: `pnpm install`
Expected: `@ai-career/job-ingestion` is linked into the workspace; `bullmq` installs.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @ai-career/job-ingestion test`
Expected: FAIL — `./schedule`, `./reconcile`, `./worker` and `@ai-career/ingestion/testing` not found.

- [ ] **Step 4: Write the implementation**

`packages/ingestion/src/queue.ts`:

```ts
// Shared by the worker (services/job-ingestion) and the web app's "Run now".
// Constants only -- this package deliberately does not depend on bullmq.

export const INGEST_QUEUE_NAME = "job-ingestion";
export const INGEST_JOB_NAME = "ingest-source";
export const SCHEDULER_PREFIX = "schedule-";

export interface IngestJobData {
  sourceId: string;
}

/**
 * A fixed job id per source makes BullMQ ignore a second enqueue while one is waiting or running.
 * (BullMQ rejects custom ids containing ":", hence the dash.)
 */
export const ingestJobId = (sourceId: string): string => `ingest-${sourceId}`;
export const schedulerIdFor = (sourceId: string): string => `${SCHEDULER_PREFIX}${sourceId}`;

/**
 * Transient failures (rate limit, 5xx, network) retry with backoff. Both removal flags are on so a
 * finished or failed job never keeps its id reserved and blocks the next enqueue; the outcome of
 * every attempt is recorded in `ingestion_runs`, not in Redis.
 */
export const INGEST_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: true,
};
```

`packages/ingestion/src/testing/index.ts`:

```ts
// Test-only helpers, exposed as "@ai-career/ingestion/testing" so other workspace
// packages' integration tests can share them. Never imported by production code.
export * from "./db";
export * from "./factories";
export { greenhouseJobFixture, leverPostingFixture } from "../fixtures";
```

Add `export * from "./queue";` to `packages/ingestion/src/index.ts`. **Checkpoint:** this file grows across Tasks 1–12; compare yours with the expected content at this point (a missing line surfaces later as an `undefined` import in the web app):

`packages/ingestion/src/index.ts`:

```ts
export * from "./types";
export * from "./sourceSchemas";
export * from "./queue";
export * from "./normalize/text";
export * from "./normalize/keys";
export * from "./normalize/salary";
export * from "./normalize/experience";
export * from "./normalize/sponsorship";
export * from "./normalize/workMode";
export * from "./normalize/normalizeRecord";
export * from "./adapters/slug";
export * from "./adapters/http";
export * from "./adapters/greenhouse";
export * from "./adapters/lever";
export * from "./adapters/upload";
export * from "./identity/serialize";
export * from "./identity/merge";
export * from "./pipeline/persistPosting";
export * from "./pipeline/recomputeJob";
export * from "./pipeline/closeMissing";
export * from "./pipeline/hashPayload";
export * from "./pipeline/storeUpload";
export * from "./pipeline/adapterFor";
export * from "./pipeline/runIngestion";
```

`services/job-ingestion/src/schedule.ts`:

```ts
import { SCHEDULER_PREFIX, schedulerIdFor } from "@ai-career/ingestion";

export interface SchedulePlan {
  upsert: { schedulerId: string; sourceId: string }[];
  /** Scheduler ids to remove. */
  remove: string[];
}

/**
 * Decide what to change so BullMQ's repeatable schedulers match the database (the source of truth).
 * - `refresh: true` (boot) re-upserts every eligible scheduler so a changed interval takes effect;
 * - `refresh: false` (the periodic reconcile) only adds the missing ones, so an unchanged scheduler is
 *   never touched (and its next-run timer never reset);
 * - only schedulers this service created (by prefix) are ever removed.
 */
export function planSchedules(input: {
  eligibleSourceIds: string[];
  existingSchedulerIds: string[];
  refresh: boolean;
}): SchedulePlan {
  const wanted = new Set(input.eligibleSourceIds.map(schedulerIdFor));
  const existing = new Set(input.existingSchedulerIds);
  return {
    upsert: input.eligibleSourceIds
      .filter((sourceId) => input.refresh || !existing.has(schedulerIdFor(sourceId)))
      .map((sourceId) => ({ schedulerId: schedulerIdFor(sourceId), sourceId })),
    remove: input.existingSchedulerIds.filter((id) => id.startsWith(SCHEDULER_PREFIX) && !wanted.has(id)),
  };
}
```

`services/job-ingestion/src/reconcile.ts`:

```ts
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { Queue } from "bullmq";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { INGEST_JOB_NAME, INGEST_JOB_OPTIONS, type IngestJobData } from "@ai-career/ingestion";
import { planSchedules, type SchedulePlan } from "./schedule";

const { jobSources } = schema;

export interface ReconcileDeps {
  db: DbClient;
  userId: string;
  queue: Queue<IngestJobData>;
  everyMs: number;
  refresh: boolean;
}

/**
 * Make BullMQ's repeatable schedulers match the database: one per enabled, consented, non-upload
 * source. Uploads are one-shot (processed when uploaded), so they are never scheduled.
 */
export async function reconcileSchedules(deps: ReconcileDeps): Promise<SchedulePlan> {
  const eligible = await withUserContext(deps.db, deps.userId, (tx) =>
    tx
      .select({ id: jobSources.id })
      .from(jobSources)
      .where(and(eq(jobSources.enabled, true), isNotNull(jobSources.consentConfirmedAt), ne(jobSources.kind, "upload")))
  );
  const schedulers = await deps.queue.getJobSchedulers();

  const plan = planSchedules({
    eligibleSourceIds: eligible.map((row) => row.id),
    existingSchedulerIds: schedulers.map((s) => s.id ?? s.key),
    refresh: deps.refresh,
  });

  for (const { schedulerId, sourceId } of plan.upsert) {
    await deps.queue.upsertJobScheduler(
      schedulerId,
      { every: deps.everyMs },
      { name: INGEST_JOB_NAME, data: { sourceId }, opts: INGEST_JOB_OPTIONS }
    );
  }
  for (const schedulerId of plan.remove) await deps.queue.removeJobScheduler(schedulerId);
  return plan;
}
```

`services/job-ingestion/src/worker.ts`:

```ts
import { Worker, UnrecoverableError, type ConnectionOptions } from "bullmq";
import type { DbClient } from "@ai-career/db";
import {
  INGEST_QUEUE_NAME,
  IngestError,
  runIngestion,
  type IngestJobData,
  type SourceAdapter,
  type SourceRef,
} from "@ai-career/ingestion";

export interface IngestWorkerDeps {
  connection: ConnectionOptions;
  db: DbClient;
  userId: string;
  adapterFor: (source: SourceRef) => SourceAdapter;
  /** Overridable so tests use an isolated queue. */
  queueName?: string;
}

/**
 * The worker holds no domain logic: it hands a source id to `runIngestion` and maps its error classes
 * onto BullMQ's retry model. Permanent failures (no consent, bad slug, 404, schema mismatch) must not
 * retry; transient ones (429, 5xx, network, timeout) do, with the queue's backoff.
 * Concurrency 1: fetches are I/O-bound and a personal watch-list is small, so this is simply "one
 * source at a time" and it rules out two runs of the same source racing.
 */
export function createIngestWorker(deps: IngestWorkerDeps): Worker<IngestJobData> {
  return new Worker<IngestJobData>(
    deps.queueName ?? INGEST_QUEUE_NAME,
    async (job) => {
      try {
        await runIngestion(deps.db, { userId: deps.userId, sourceId: job.data.sourceId, adapterFor: deps.adapterFor });
      } catch (error) {
        if (error instanceof IngestError && !error.retryable) throw new UnrecoverableError(error.errorClass);
        throw error;
      }
    },
    { connection: deps.connection, concurrency: 1 }
  );
}
```

`services/job-ingestion/src/main.ts`:

```ts
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { INGEST_QUEUE_NAME, createAdapterFor, type IngestJobData } from "@ai-career/ingestion";
import { reconcileSchedules } from "./reconcile";
import { createIngestWorker } from "./worker";

// Structured logs only, and never posting content: ids, counts and error CLASSES (CLAUDE.md §9, D29).
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));

const safeErrorLabel = (error: unknown): string =>
  error instanceof Error && (error.name === "UnrecoverableError" || error.name === "IngestError")
    ? error.message
    : error instanceof Error
      ? error.name
      : "unknown";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDbClient(env);
  // BullMQ workers require maxRetriesPerRequest: null on their connection.
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<IngestJobData>(INGEST_QUEUE_NAME, { connection });
  const adapterFor = createAdapterFor({
    db,
    userId: env.DEFAULT_USER_ID,
    greenhouseBaseUrl: env.GREENHOUSE_API_BASE,
    leverBaseUrl: env.LEVER_API_BASE,
  });
  const worker = createIngestWorker({ connection, db, userId: env.DEFAULT_USER_ID, adapterFor });
  worker.on("completed", (job) => log("ingest_completed", { jobId: job.id }));
  worker.on("failed", (job, error) => log("ingest_failed", { jobId: job?.id, error: safeErrorLabel(error) }));

  const everyMs = env.INGEST_INTERVAL_MINUTES * 60_000;
  const reconcile = async (refresh: boolean) => {
    try {
      const plan = await reconcileSchedules({ db, userId: env.DEFAULT_USER_ID, queue, everyMs, refresh });
      if (refresh || plan.upsert.length > 0 || plan.remove.length > 0) {
        log("schedules_reconciled", { upserted: plan.upsert.length, removed: plan.remove.length });
      }
    } catch (error) {
      log("schedule_reconcile_failed", { error: safeErrorLabel(error) });
    }
  };

  await reconcile(true);
  // The database is the source of truth: pick up sources enabled/disabled from the web app.
  const timer = setInterval(() => void reconcile(false), 60_000);
  log("worker_started", { everyMinutes: env.INGEST_INTERVAL_MINUTES });

  const shutdown = async () => {
    clearInterval(timer);
    await worker.close();
    await queue.close();
    await connection.quit();
    await closeDbClient(db);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  log("worker_crashed", { error: safeErrorLabel(error) });
  process.exit(1);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/job-ingestion test && pnpm --filter @ai-career/job-ingestion typecheck && pnpm --filter @ai-career/job-ingestion lint && pnpm --filter @ai-career/ingestion test`
Expected: PASS (service: 3 files, 10 tests; ingestion: unchanged).

- [ ] **Step 6: Smoke-test the entrypoint**

Run in a terminal: `pnpm --filter @ai-career/job-ingestion start`
Expected output (JSON lines, no posting content): `{"event":"schedules_reconciled",...,"upserted":0,"removed":0}` then `{"event":"worker_started",...,"everyMinutes":360}`. Stop with Ctrl-C; the process must exit cleanly (it closes the worker, queue, Redis and DB pool). This needs the dev database migrated (Task 8, Step 5) and a `.env` in the working tree.

- [ ] **Step 7: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(job-ingestion): add BullMQ worker service with scheduler reconciliation"`

---

### Task 13: Web — enqueue helper and the `/api/job-sources` routes

**Files:**
- Create: `apps/web/src/test/jobsDb.ts`, `apps/web/src/lib/isUniqueViolation.ts`, `apps/web/src/lib/job-ingestion/enqueue.ts`, `apps/web/src/lib/job-sources/jobSourceSchemas.ts`, `apps/web/src/lib/job-sources/serializeSource.ts`
- Create: `apps/web/src/app/api/job-sources/route.ts`, `apps/web/src/app/api/job-sources/[id]/route.ts`, `apps/web/src/app/api/job-sources/[id]/run/route.ts`
- Test: `apps/web/src/lib/job-ingestion/enqueue.test.ts`, `apps/web/src/lib/job-sources/jobSourceSchemas.test.ts`, `apps/web/src/app/api/job-sources/route.test.ts`, `.../[id]/route.test.ts`, `.../[id]/run/route.test.ts`
- Modify: `apps/web/package.json` (dependencies)

**Interfaces:**
- Consumes: `INGEST_QUEUE_NAME`, `INGEST_JOB_NAME`, `INGEST_JOB_OPTIONS`, `ingestJobId`, `IngestJobData`, `SLUG_RE` (Tasks 6, 12); `schema`, `withUserContext`, `createDbClient`, `closeDbClient` (Task 8 tables); `readJsonBody`, `formatValidationError` (existing, `apps/web/src/lib`).
- Produces:
  - `enqueueIngestion(env: { REDIS_URL: string }, sourceId: string, queueName?: string): Promise<"enqueued" | "already_queued">`
  - `CreateJobSourceSchema`, `UpdateJobSourceSchema` (zod); `JobSourceView`, `serializeSource(row, run | null)`, `listJobSourceViews(tx)`; `isUniqueViolation(error)`
  - Routes — `GET /api/job-sources` → `{ sources: JobSourceView[] }`; `POST /api/job-sources` `{ kind: "greenhouse" | "lever", slug, companyName? }` → 201 `{ source }` | 400 | 409 duplicate; `PATCH /api/job-sources/[id]` `{ enabled, consentConfirmed? }` → 200 `{ source }` | 400 (enabling without the ToS confirmation) | 404; `POST /api/job-sources/[id]/run` → 202 `{ status: "queued" }` | 409 (disabled / no consent / already queued) | 404
  - Test helpers in `apps/web/src/test/jobsDb.ts`: `openAdminDb()` (migrates under an advisory lock), `wipeJobData(admin, userId)`, `insertSource(admin, userId, opts?)`.

**Read first:** `apps/web/AGENTS.md`, and in `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` the section on dynamic segments: **`params` is a `Promise`** (`{ params }: { params: Promise<{ id: string }> }`, then `await params`). The routes below already follow this.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/test/jobsDb.ts` (first version; Task 15 adds `insertJob` and `insertPosting`):

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

// apps/web/src/test -> packages/db/migrations
const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/migrations");
const MIGRATION_LOCK = 7420001;

/**
 * Superuser connection for seeding/inspecting/wiping (bypasses RLS -- never use it for behavior under
 * test). Migrates the shared test database under an advisory lock, because vitest and turbo run test
 * files and packages concurrently against the same database.
 */
export async function openAdminDb(): Promise<postgres.Sql> {
  const adminSql = postgres(
    process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test"
  );
  const lock = await adminSql.reserve();
  try {
    await lock`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
    await adminSql.unsafe("GRANT USAGE ON SCHEMA public TO career_intel_app");
    await adminSql.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO career_intel_app");
  } finally {
    await lock`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    lock.release();
  }
  return adminSql;
}

/** Scoped to one user id, since other suites use the same database at the same time. */
export async function wipeJobData(adminSql: postgres.Sql, userId: string): Promise<void> {
  await adminSql`DELETE FROM jobs WHERE user_id = ${userId}`;
  await adminSql`DELETE FROM job_sources WHERE user_id = ${userId}`;
}

export async function insertSource(
  adminSql: postgres.Sql,
  userId: string,
  opts: { kind?: "greenhouse" | "lever" | "upload"; label?: string; slug?: string; enabled?: boolean; consent?: boolean } = {}
): Promise<string> {
  const kind = opts.kind ?? "greenhouse";
  const config = kind === "upload" ? {} : { slug: opts.slug ?? `b-${Math.random().toString(36).slice(2, 10)}` };
  const [row] = await adminSql`
    INSERT INTO job_sources (user_id, kind, label, config, enabled, consent_confirmed_at)
    VALUES (${userId}, ${kind}, ${opts.label ?? "Acme"}, ${JSON.stringify(config)}::jsonb,
            ${opts.enabled ?? false}, ${(opts.consent ?? false) ? new Date().toISOString() : null}::timestamptz)
    RETURNING id`;
  return row.id as string;
}

```

`apps/web/src/lib/job-ingestion/enqueue.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { INGEST_JOB_NAME, ingestJobId } from "@ai-career/ingestion";
import { enqueueIngestion } from "./enqueue";

const env = { REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379" };
const queueName = `job-ingestion-test-${randomUUID()}`;
const redisUrl = new URL(env.REDIS_URL);
const cleanup = new Queue(queueName, { connection: { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) } });

afterAll(async () => {
  await cleanup.obliterate({ force: true });
  await cleanup.close();
});

describe("enqueueIngestion", () => {
  it("enqueues once, then reports already_queued while the first is still waiting", async () => {
    const sourceId = randomUUID();
    expect(await enqueueIngestion(env, sourceId, queueName)).toBe("enqueued");
    expect(await enqueueIngestion(env, sourceId, queueName)).toBe("already_queued");

    const job = await cleanup.getJob(ingestJobId(sourceId));
    expect(job?.name).toBe(INGEST_JOB_NAME);
    expect(job?.data).toEqual({ sourceId });
    expect(job?.opts.attempts).toBe(3);
  });

  it("treats different sources independently", async () => {
    expect(await enqueueIngestion(env, randomUUID(), queueName)).toBe("enqueued");
    expect(await enqueueIngestion(env, randomUUID(), queueName)).toBe("enqueued");
  });
});
```

`apps/web/src/lib/job-sources/jobSourceSchemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CreateJobSourceSchema, UpdateJobSourceSchema } from "./jobSourceSchemas";

describe("CreateJobSourceSchema", () => {
  it("accepts a board token and an optional company name, trimming both", () => {
    expect(CreateJobSourceSchema.parse({ kind: "greenhouse", slug: " gitlab ", companyName: " GitLab " })).toEqual({
      kind: "greenhouse", slug: "gitlab", companyName: "GitLab",
    });
    expect(CreateJobSourceSchema.safeParse({ kind: "lever", slug: "Acme_Corp-2" }).success).toBe(true);
  });

  it("rejects upload as a kind, and any slug that could alter a URL", () => {
    expect(CreateJobSourceSchema.safeParse({ kind: "upload", slug: "x" }).success).toBe(false);
    for (const slug of ["", "../etc", "a/b", "a.b", "a:b", "a b", "x".repeat(65)]) {
      expect(CreateJobSourceSchema.safeParse({ kind: "lever", slug }).success, slug).toBe(false);
    }
  });
});

describe("UpdateJobSourceSchema", () => {
  it("requires a boolean enabled, with an optional consentConfirmed", () => {
    expect(UpdateJobSourceSchema.safeParse({ enabled: true, consentConfirmed: true }).success).toBe(true);
    expect(UpdateJobSourceSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(UpdateJobSourceSchema.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(UpdateJobSourceSchema.safeParse({}).success).toBe(false);
  });
});
```

`apps/web/src/app/api/job-sources/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeJobData, insertSource } from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b1",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000b1";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeJobData(admin, USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await admin.end();
});

const { GET, POST } = await import("./route");
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/job-sources", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("GET /api/job-sources", () => {
  it("returns an empty list when nothing is on the watch-list", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sources: [] });
  });

  it("lists sources newest first with each one's latest run", async () => {
    const older = await insertSource(admin, USER, { label: "Older", slug: "older" });
    const newer = await insertSource(admin, USER, { label: "Newer", slug: "newer", enabled: true, consent: true });
    await admin`INSERT INTO ingestion_runs (user_id, source_id, started_at, status, complete, fetched_count, new_count, closed_count)
                VALUES (${USER}, ${newer}, '2026-09-20T10:00:00Z', 'succeeded', true, 5, 4, 1)`;
    await admin`INSERT INTO ingestion_runs (user_id, source_id, started_at, status, complete, fetched_count, new_count)
                VALUES (${USER}, ${newer}, '2026-09-21T10:00:00Z', 'succeeded', true, 7, 2)`;
    await admin`UPDATE job_sources SET created_at = now() - interval '1 day' WHERE id = ${older}`;

    const { sources } = await (await GET()).json();
    expect(sources.map((s: { label: string }) => s.label)).toEqual(["Newer", "Older"]);
    expect(sources[0]).toMatchObject({ kind: "greenhouse", slug: "newer", enabled: true });
    expect(sources[0].consentConfirmedAt).not.toBeNull();
    expect(sources[0].lastRun).toEqual({ complete: true, fetched: 7, created: 2, updated: 0, unchanged: 0, closed: 0, failed: 0 });
    expect(sources[1].lastRun).toBeNull();
  });
});

describe("POST /api/job-sources", () => {
  it("creates a disabled, unconsented board, labelled by its company name when given", async () => {
    const res = await post({ kind: "greenhouse", slug: "gitlab", companyName: "GitLab" });
    expect(res.status).toBe(201);
    const { source } = await res.json();
    expect(source).toMatchObject({ kind: "greenhouse", label: "GitLab", slug: "gitlab", companyName: "GitLab", enabled: false, consentConfirmedAt: null });
    const [row] = await admin`SELECT enabled, consent_confirmed_at FROM job_sources WHERE id = ${source.id}`;
    expect(row).toMatchObject({ enabled: false, consent_confirmed_at: null });
  });

  it("labels a board by its slug when no company name is given", async () => {
    const { source } = await (await post({ kind: "lever", slug: "spotify" })).json();
    expect(source).toMatchObject({ label: "spotify", companyName: null });
  });

  it("answers 409 for the same board twice, case-insensitively", async () => {
    expect((await post({ kind: "lever", slug: "spotify" })).status).toBe(201);
    const res = await post({ kind: "lever", slug: "SPOTIFY" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already on your list/);
    expect((await post({ kind: "greenhouse", slug: "spotify" })).status).toBe(201); // a different kind is a different board
  });

  it("answers 400 for a bad kind, an unsafe slug, and malformed JSON", async () => {
    expect((await post({ kind: "upload", slug: "x" })).status).toBe(400);
    expect((await post({ kind: "lever", slug: "../etc/passwd" })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
  });
});
```

`apps/web/src/app/api/job-sources/[id]/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeJobData, insertSource } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b2",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000b2";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeJobData(admin, USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await admin.end();
});

const { PATCH } = await import("./route");
const patch = (id: string, body: unknown) =>
  PATCH(new Request(`http://localhost/api/job-sources/${id}`, { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
const row = async (id: string) => (await admin`SELECT enabled, consent_confirmed_at FROM job_sources WHERE id = ${id}`)[0];

describe("PATCH /api/job-sources/[id]", () => {
  it("refuses to enable a source until the Terms-of-Service confirmation is given (D3), and changes nothing", async () => {
    const id = await insertSource(admin, USER);
    for (const body of [{ enabled: true }, { enabled: true, consentConfirmed: false }]) {
      const res = await patch(id, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Terms of Service/);
    }
    expect(await row(id)).toMatchObject({ enabled: false, consent_confirmed_at: null });
  });

  it("enables with the confirmation and records when it was given", async () => {
    const id = await insertSource(admin, USER);
    const res = await patch(id, { enabled: true, consentConfirmed: true });
    expect(res.status).toBe(200);
    expect((await res.json()).source).toMatchObject({ id, enabled: true });
    const after = await row(id);
    expect(after.enabled).toBe(true);
    expect(after.consent_confirmed_at).not.toBeNull();
  });

  it("keeps the confirmation when disabling, and re-enabling does not ask again", async () => {
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    const before = (await row(id)).consent_confirmed_at;

    expect((await patch(id, { enabled: false })).status).toBe(200);
    expect(await row(id)).toMatchObject({ enabled: false });
    expect((await row(id)).consent_confirmed_at).toEqual(before);

    expect((await patch(id, { enabled: true })).status).toBe(200);
    expect(await row(id)).toMatchObject({ enabled: true });
  });

  it("answers 404 for an unknown or malformed id, and 400 for a bad body", async () => {
    expect((await patch("00000000-0000-0000-0000-00000000ffff", { enabled: false })).status).toBe(404);
    expect((await patch("not-a-uuid", { enabled: false })).status).toBe(404);
    const id = await insertSource(admin, USER);
    expect((await patch(id, { enabled: "yes" })).status).toBe(400);
    expect((await patch(id, "{oops")).status).toBe(400);
  });
});
```

`apps/web/src/app/api/job-sources/[id]/run/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeJobData, insertSource } from "../../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b3",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379",
  }),
}));
vi.mock("../../../../../lib/job-ingestion/enqueue", () => ({ enqueueIngestion: vi.fn() }));

import { enqueueIngestion } from "../../../../../lib/job-ingestion/enqueue";

const USER = "00000000-0000-0000-0000-0000000000b3";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  vi.mocked(enqueueIngestion).mockReset().mockResolvedValue("enqueued");
  await wipeJobData(admin, USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");
const run = (id: string) => POST(new Request(`http://localhost/api/job-sources/${id}/run`, { method: "POST" }), { params: Promise.resolve({ id }) });

describe("POST /api/job-sources/[id]/run", () => {
  it("queues an enabled, consented source and answers 202", async () => {
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    const res = await run(id);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued" });
    expect(enqueueIngestion).toHaveBeenCalledWith(expect.objectContaining({ REDIS_URL: "redis://localhost:6379" }), id);
  });

  it("answers 409 without queueing when the source is disabled or has no consent", async () => {
    const disabled = await insertSource(admin, USER, { enabled: false, consent: true });
    const noConsent = await insertSource(admin, USER, { enabled: true, consent: false });
    expect((await run(disabled)).status).toBe(409);
    expect((await run(noConsent)).status).toBe(409);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });

  it("answers 409 when a run is already queued or active", async () => {
    vi.mocked(enqueueIngestion).mockResolvedValue("already_queued");
    const id = await insertSource(admin, USER, { enabled: true, consent: true });
    const res = await run(id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already queued or running/);
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect((await run("00000000-0000-0000-0000-00000000ffff")).status).toBe(404);
    expect((await run("nope")).status).toBe(404);
  });

  it("allows re-running an upload source (it reprocesses the stored records)", async () => {
    const id = await insertSource(admin, USER, { kind: "upload", enabled: true, consent: true });
    expect((await run(id)).status).toBe(202);
  });
});
```

- [ ] **Step 2: Add the dependencies and run the tests to verify they fail**

Run: `pnpm --filter web add "@ai-career/ingestion@workspace:*" bullmq`
Then: `pnpm --filter web test -- job-sources job-ingestion`
Expected: FAIL — the modules under test do not exist yet.

- [ ] **Step 3: Write the implementation**

Design notes the tests pin down: a source is created **disabled and unconsented**; enabling records the Terms-of-Service confirmation (D3) and it is never asked twice; `run` refuses disabled/unconsented sources with 409 (the worker re-checks); a second "Run now" while one is queued is a 409 via the queue's fixed job id.

`apps/web/src/lib/isUniqueViolation.ts`:

```ts
/** Postgres unique_violation (23505), whether the driver error is thrown bare or wrapped as a `cause`. */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}
```

`apps/web/src/lib/job-ingestion/enqueue.ts`:

```ts
import IORedis from "ioredis";
import { Queue } from "bullmq";
import {
  INGEST_JOB_NAME,
  INGEST_JOB_OPTIONS,
  INGEST_QUEUE_NAME,
  ingestJobId,
  type IngestJobData,
} from "@ai-career/ingestion";

export type EnqueueResult = "enqueued" | "already_queued";

const PENDING_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);

/**
 * Put a source on the ingestion queue. The fixed job id per source means a second click while a run is
 * waiting or active is reported as `already_queued` instead of piling up. `queueName` is overridable so
 * tests never touch a real worker's queue.
 */
export async function enqueueIngestion(
  env: { REDIS_URL: string },
  sourceId: string,
  queueName: string = INGEST_QUEUE_NAME
): Promise<EnqueueResult> {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<IngestJobData>(queueName, { connection });
  try {
    const existing = await queue.getJob(ingestJobId(sourceId));
    if (existing && PENDING_STATES.has(await existing.getState())) return "already_queued";
    await queue.add(INGEST_JOB_NAME, { sourceId }, { ...INGEST_JOB_OPTIONS, jobId: ingestJobId(sourceId) });
    return "enqueued";
  } finally {
    await queue.close();
    connection.disconnect();
  }
}
```

`apps/web/src/lib/job-sources/jobSourceSchemas.ts`:

```ts
import { z } from "zod";
import { SLUG_RE } from "@ai-career/ingestion";

export const CreateJobSourceSchema = z.object({
  kind: z.enum(["greenhouse", "lever"]),
  slug: z
    .string()
    .trim()
    .regex(SLUG_RE, "Board token may contain only letters, digits, hyphens and underscores (max 64 characters)"),
  companyName: z.string().trim().min(1).max(120).optional(),
});

export const UpdateJobSourceSchema = z.object({
  enabled: z.boolean(),
  consentConfirmed: z.boolean().optional(),
});
```

`apps/web/src/lib/job-sources/serializeSource.ts`:

```ts
import { desc, inArray } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";

const { jobSources, ingestionRuns } = schema;

type SourceRow = typeof jobSources.$inferSelect;
type RunRow = typeof ingestionRuns.$inferSelect;

export interface JobSourceView {
  id: string;
  kind: "greenhouse" | "lever" | "upload";
  label: string;
  slug: string | null;
  companyName: string | null;
  enabled: boolean;
  consentConfirmedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: "running" | "succeeded" | "failed" | null;
  /** An error class such as "not_found" or "empty_result" -- never a message. */
  lastErrorClass: string | null;
  lastRun: {
    complete: boolean;
    fetched: number;
    created: number;
    updated: number;
    unchanged: number;
    closed: number;
    failed: number;
  } | null;
  createdAt: string;
}

export function serializeSource(row: SourceRow, run: RunRow | null): JobSourceView {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    slug: row.config.slug ?? null,
    companyName: row.config.companyName ?? null,
    enabled: row.enabled,
    consentConfirmedAt: row.consentConfirmedAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus: row.lastRunStatus,
    lastErrorClass: row.lastErrorClass,
    lastRun: run
      ? {
          complete: run.complete,
          fetched: run.fetchedCount,
          created: run.newCount,
          updated: run.updatedCount,
          unchanged: run.unchangedCount,
          closed: run.closedCount,
          failed: run.failedCount,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listJobSourceViews(tx: DbClient): Promise<JobSourceView[]> {
  const sources = await tx.select().from(jobSources).orderBy(desc(jobSources.createdAt));
  if (sources.length === 0) return [];
  const latest = await tx
    .selectDistinctOn([ingestionRuns.sourceId])
    .from(ingestionRuns)
    .where(inArray(ingestionRuns.sourceId, sources.map((s) => s.id)))
    .orderBy(ingestionRuns.sourceId, desc(ingestionRuns.startedAt));
  const runBySource = new Map(latest.map((run) => [run.sourceId, run]));
  return sources.map((source) => serializeSource(source, runBySource.get(source.id) ?? null));
}
```

`apps/web/src/app/api/job-sources/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { formatValidationError } from "../../../lib/formatValidationError";
import { isUniqueViolation } from "../../../lib/isUniqueViolation";
import { readJsonBody } from "../../../lib/readJsonBody";
import { CreateJobSourceSchema } from "../../../lib/job-sources/jobSourceSchemas";
import { listJobSourceViews, serializeSource } from "../../../lib/job-sources/serializeSource";

export async function GET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const sources = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => listJobSourceViews(tx));
    return NextResponse.json({ sources });
  } finally {
    await closeDbClient(db);
  }
}

export async function POST(request: Request) {
  const env = loadEnv();
  const jsonBody = await readJsonBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = CreateJobSourceSchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }
  const { kind, slug, companyName } = parsed.data;

  const db = createDbClient(env);
  try {
    // Created disabled and unconsented: enabling is a separate, explicit step that records the
    // Terms-of-Service confirmation (D3).
    const [row] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .insert(schema.jobSources)
        .values({ kind, label: companyName ?? slug, config: { slug, ...(companyName ? { companyName } : {}) } })
        .returning()
    );
    return NextResponse.json({ source: serializeSource(row, null) }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: "That board is already on your list" }, { status: 409 });
    }
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
```

`apps/web/src/app/api/job-sources/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { UpdateJobSourceSchema } from "../../../../lib/job-sources/jobSourceSchemas";
import { serializeSource } from "../../../../lib/job-sources/serializeSource";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Job source not found" }, { status: 404 });

  const env = loadEnv();
  const jsonBody = await readJsonBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = UpdateJobSourceSchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }
  const { enabled, consentConfirmed } = parsed.data;

  const db = createDbClient(env);
  try {
    return await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      const [source] = await tx.select().from(schema.jobSources).where(eq(schema.jobSources.id, id)).limit(1);
      if (!source) return NextResponse.json({ error: "Job source not found" }, { status: 404 });

      // D3: a source cannot be enabled until the user has confirmed they reviewed its Terms of Service.
      // Once recorded the confirmation stays; disabling and re-enabling does not ask again.
      if (enabled && !source.consentConfirmedAt && consentConfirmed !== true) {
        return NextResponse.json(
          { error: "Confirm that you have reviewed this source's Terms of Service before enabling it" },
          { status: 400 }
        );
      }
      const [updated] = await tx
        .update(schema.jobSources)
        .set({
          enabled,
          consentConfirmedAt: source.consentConfirmedAt ?? (enabled ? new Date() : null),
        })
        .where(eq(schema.jobSources.id, id))
        .returning();
      return NextResponse.json({ source: serializeSource(updated, null) });
    });
  } finally {
    await closeDbClient(db);
  }
}
```

`apps/web/src/app/api/job-sources/[id]/run/route.ts`:

```ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { enqueueIngestion } from "../../../../../lib/job-ingestion/enqueue";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Job source not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  let source;
  try {
    [source] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.select().from(schema.jobSources).where(eq(schema.jobSources.id, id)).limit(1)
    );
  } finally {
    await closeDbClient(db);
  }
  if (!source) return NextResponse.json({ error: "Job source not found" }, { status: 404 });

  // The worker re-checks both of these (D3); refusing here just gives the user a clear answer.
  if (!source.enabled) {
    return NextResponse.json({ error: "Enable this source before running it" }, { status: 409 });
  }
  if (!source.consentConfirmedAt) {
    return NextResponse.json({ error: "Confirm the source's Terms of Service before running it" }, { status: 409 });
  }

  const result = await enqueueIngestion(env, id);
  if (result === "already_queued") {
    return NextResponse.json({ error: "A run for this source is already queued or running" }, { status: 409 });
  }
  return NextResponse.json({ status: "queued" }, { status: 202 });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web test -- job-sources job-ingestion && pnpm --filter web lint`
Expected: PASS (5 files, 20 tests), lint clean. (`pnpm --filter web typecheck` needs one `pnpm --filter web build` first in a fresh checkout — see Global Constraints.)

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(web): add job source API with consent gate and run queueing"`

---

### Task 14: Web — job file upload route

**Files:**
- Create: `apps/web/src/app/api/job-sources/upload/route.ts`
- Test: `apps/web/src/app/api/job-sources/upload/route.test.ts`

**Interfaces:**
- Consumes: `parseUploadFile`, `UploadParseError`, `storeUpload` (Tasks 7, 11); `enqueueIngestion` (Task 13); test helpers from Task 13.
- Produces: `POST /api/job-sources/upload` — multipart `file` + `consentConfirmed=true` → 201 `{ sourceId, count, queued }`; 400 for a missing/oversized/invalid file or missing consent (nothing stored).

- [ ] **Step 1: Write the failing test**

`apps/web/src/app/api/job-sources/upload/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeJobData } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b4",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379",
  }),
}));
vi.mock("../../../../lib/job-ingestion/enqueue", () => ({ enqueueIngestion: vi.fn() }));

import { enqueueIngestion } from "../../../../lib/job-ingestion/enqueue";

const USER = "00000000-0000-0000-0000-0000000000b4";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  vi.mocked(enqueueIngestion).mockReset().mockResolvedValue("enqueued");
  await wipeJobData(admin, USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await admin.end();
});

const { POST } = await import("./route");
const CSV = "title,company,location\nData Engineer,Acme,Berlin\nAnalyst,Beta,Paris";

function upload(opts: { content?: string | ArrayBuffer; name?: string; consent?: string | null; headers?: Record<string, string> } = {}) {
  const form = new FormData();
  if (opts.content !== null) {
    form.set("file", new File([opts.content ?? CSV], opts.name ?? "jobs.csv"));
  }
  if (opts.consent !== null) form.set("consentConfirmed", opts.consent ?? "true");
  return new Request("http://localhost/api/job-sources/upload", { method: "POST", body: form, headers: opts.headers });
}
const sourceCount = async () => (await admin`SELECT count(*)::int AS n FROM job_sources WHERE user_id = ${USER}`)[0].n;

describe("POST /api/job-sources/upload", () => {
  it("stores the file as an enabled, consented upload source and queues it", async () => {
    const res = await POST(upload());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ count: 2, queued: true });

    const [source] = await admin`SELECT kind, label, enabled, consent_confirmed_at FROM job_sources WHERE id = ${body.sourceId}`;
    expect(source).toMatchObject({ kind: "upload", label: "jobs.csv", enabled: true });
    expect(source.consent_confirmed_at).not.toBeNull();
    expect((await admin`SELECT count(*)::int AS n FROM raw_job_postings WHERE source_id = ${body.sourceId}`)[0].n).toBe(2);
    expect(enqueueIngestion).toHaveBeenCalledWith(expect.objectContaining({ REDIS_URL: "redis://localhost:6379" }), body.sourceId);
  });

  it("still succeeds, reporting queued: false, when the queue is unreachable", async () => {
    vi.mocked(enqueueIngestion).mockRejectedValue(new Error("redis down"));
    const res = await POST(upload());
    expect(res.status).toBe(201);
    expect((await res.json()).queued).toBe(false);
    expect(await sourceCount()).toBe(1);
  });

  it("requires the consent confirmation and stores nothing without it (D3)", async () => {
    for (const consent of [null, "false", "yes"]) {
      const res = await POST(upload({ consent }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/permitted to use/);
    }
    expect(await sourceCount()).toBe(0);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });

  it("answers 400 with the parser's user-safe message for an invalid file, and stores nothing", async () => {
    const noCompany = await POST(upload({ content: "title,company\nAnalyst,\n" }));
    expect(noCompany.status).toBe(400);
    expect((await noCompany.json()).error).toMatch(/each needs a title and a company/);
    expect((await POST(upload({ content: new Uint8Array([0x50, 0x4b, 0x00, 0x03]).buffer }))).status).toBe(400);
    expect((await POST(upload({ name: "jobs.txt" }))).status).toBe(400);
    expect(await sourceCount()).toBe(0);
  });

  it("answers 400 when no file is attached, or the body is not multipart", async () => {
    expect((await POST(upload({ content: null as unknown as string }))).status).toBe(400);
    const notForm = new Request("http://localhost/api/job-sources/upload", { method: "POST", body: "plain text" });
    expect((await POST(notForm)).status).toBe(400);
  });

  it("rejects an oversized declared Content-Length before reading the body", async () => {
    const res = await POST(upload({ headers: { "content-length": String(11 * 1024 * 1024) } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/10MB/);
    expect(await sourceCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter web test -- job-sources/upload`
Expected: FAIL — `./route` not found.

- [ ] **Step 3: Write the implementation**

`apps/web/src/app/api/job-sources/upload/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { UploadParseError, parseUploadFile, storeUpload } from "@ai-career/ingestion";
import { enqueueIngestion } from "../../../../lib/job-ingestion/enqueue";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
// Content-Length covers the whole multipart envelope, so a file at exactly the cap is slightly larger.
// This is only an early, coarse rejection; `file.size` below is the authoritative limit.
const CONTENT_LENGTH_SLACK_BYTES = 64 * 1024;

export async function POST(request: Request) {
  const env = loadEnv();

  // Reject an oversized upload from its declared length BEFORE request.formData() buffers the body.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FILE_SIZE_BYTES + CONTENT_LENGTH_SLACK_BYTES) {
    return NextResponse.json({ error: "File exceeds 10MB limit" }, { status: 400 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Request must be multipart form data" }, { status: 400 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size > MAX_FILE_SIZE_BYTES) return NextResponse.json({ error: "File exceeds 10MB limit" }, { status: 400 });

  // D3: the user must confirm they may use this data before it is ingested.
  if (formData.get("consentConfirmed") !== "true") {
    return NextResponse.json(
      { error: "Confirm that you are permitted to use this file's data before uploading it" },
      { status: 400 }
    );
  }

  let records;
  try {
    records = parseUploadFile(Buffer.from(await file.arrayBuffer()), file.name);
  } catch (error) {
    if (error instanceof UploadParseError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }

  const db = createDbClient(env);
  let stored;
  try {
    stored = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      storeUpload(tx, { filename: file.name, records, now: new Date() })
    );
  } finally {
    await closeDbClient(db);
  }

  // The records are safely stored either way. If the queue is unreachable the user can use "Run now" later.
  let queued = true;
  try {
    await enqueueIngestion(env, stored.sourceId);
  } catch {
    queued = false;
  }
  return NextResponse.json({ sourceId: stored.sourceId, count: stored.count, queued }, { status: 201 });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter web test -- job-sources && pnpm --filter web lint`
Expected: PASS. Note `next build` type-checks test files too: `new File([...])` must be given `string | ArrayBuffer`, not a bare `Uint8Array` (the test above already does this).

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(web): add job export upload endpoint"`

---

### Task 15: Web — jobs list and detail API

**Files:**
- Create: `apps/web/src/lib/jobs/listJobs.ts`, `apps/web/src/lib/jobs/getJobDetail.ts`, `apps/web/src/app/api/jobs/route.ts`, `apps/web/src/app/api/jobs/[id]/route.ts`
- Modify: `apps/web/src/test/jobsDb.ts` (add `insertJob`, `insertPosting`)
- Test: `apps/web/src/lib/jobs/listJobs.test.ts`, `apps/web/src/app/api/jobs/route.test.ts`, `apps/web/src/app/api/jobs/[id]/route.test.ts`

**Interfaces:**
- Consumes: Task 8 tables; Task 13 test helpers.
- Produces:
  - `PAGE_SIZE = 25`, `ListJobsQuerySchema`, `type ListJobsQuery`, `escapeLike(value)`, `toJobListItem(row)`, `listJobs(tx, query)`, `type JobListItem` (`id, title, companyName, locationRaw, workMode, status, postedAt, firstSeenAt, salary{raw,min,max,currency,period,isParsed}, sponsorship, minExperienceYears`)
  - `getJobDetail(tx, id): Promise<JobDetail | null>`, `type JobDetail` (a `JobListItem` plus evidence, `postings[]`, `duplicateCandidates[]`, `fieldProvenance`)
  - `GET /api/jobs?q=&status=open|closed|all&sourceId=&page=` → `{ jobs, page, pageSize, total }` (400 on invalid params); `GET /api/jobs/[id]` → `{ job }` | 404.
  - `insertJob(admin, userId, opts?)`, `insertPosting(admin, userId, jobId, sourceId, opts?)` test helpers.

- [ ] **Step 1: Write the failing tests**

Add these two helpers to the end of `apps/web/src/test/jobsDb.ts`:

```ts
export async function insertJob(
  adminSql: postgres.Sql,
  userId: string,
  opts: {
    title?: string;
    companyName?: string;
    status?: "open" | "closed";
    postedAt?: string | null;
    firstSeenAt?: string;
    locationRaw?: string | null;
    workMode?: "remote" | "hybrid" | "onsite" | "unknown";
    salaryRaw?: string | null;
    salaryMin?: number | null;
    salaryMax?: number | null;
    salaryCurrency?: string | null;
    salaryPeriod?: "year" | "month" | "hour" | null;
    salaryIsParsed?: boolean;
    sponsorship?: "offered" | "not_offered" | "unknown";
    sponsorshipEvidence?: string | null;
    minExperienceYears?: number | null;
    descriptionText?: string;
  } = {}
): Promise<string> {
  const title = opts.title ?? "Data Engineer";
  const companyName = opts.companyName ?? "Acme";
  const [row] = await adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, location_raw, location_key, work_mode,
                      description_text, description_hash, salary_raw, salary_min, salary_max, salary_currency,
                      salary_period, salary_is_parsed, sponsorship, sponsorship_evidence, min_experience_years,
                      posted_at, first_seen_at, last_verified_at, status)
    VALUES (${userId}, ${companyName}, ${companyName.toLowerCase()}, ${title}, ${title.toLowerCase()},
            ${opts.locationRaw === undefined ? "Berlin" : opts.locationRaw},
            ${(opts.locationRaw === undefined ? "Berlin" : opts.locationRaw ?? "").toLowerCase()},
            ${opts.workMode ?? "unknown"}, ${opts.descriptionText ?? "Build pipelines."}, ${"hash-" + title},
            ${opts.salaryRaw ?? null}, ${opts.salaryMin ?? null}, ${opts.salaryMax ?? null},
            ${opts.salaryCurrency ?? null}, ${opts.salaryPeriod ?? null}, ${opts.salaryIsParsed ?? false},
            ${opts.sponsorship ?? "unknown"}, ${opts.sponsorshipEvidence ?? null}, ${opts.minExperienceYears ?? null},
            ${opts.postedAt ?? null}::timestamptz, ${opts.firstSeenAt ?? "2026-09-01T00:00:00Z"}::timestamptz,
            ${opts.firstSeenAt ?? "2026-09-01T00:00:00Z"}::timestamptz, ${opts.status ?? "open"})
    RETURNING id`;
  return row.id as string;
}

export async function insertPosting(
  adminSql: postgres.Sql,
  userId: string,
  jobId: string,
  sourceId: string,
  opts: { externalId?: string; url?: string | null; status?: "open" | "closed" } = {}
): Promise<string> {
  const externalId = opts.externalId ?? `ext-${Math.random().toString(36).slice(2, 10)}`;
  const [row] = await adminSql`
    INSERT INTO job_postings (user_id, job_id, source_id, external_id, url, fingerprint, content_hash, normalized, status, first_seen_at, last_seen_at)
    VALUES (${userId}, ${jobId}, ${sourceId}, ${externalId}, ${opts.url ?? null}, ${"fp-" + externalId}, 'h', '{}'::jsonb,
            ${opts.status ?? "open"}, '2026-09-01T00:00:00Z'::timestamptz, '2026-09-02T00:00:00Z'::timestamptz)
    RETURNING id`;
  return row.id as string;
}
```

`apps/web/src/lib/jobs/listJobs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ListJobsQuerySchema, escapeLike } from "./listJobs";

describe("escapeLike", () => {
  it("escapes LIKE wildcards and the escape character itself", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("ListJobsQuerySchema", () => {
  it("defaults to open jobs, page 1, and coerces the page number", () => {
    expect(ListJobsQuerySchema.parse({})).toEqual({ status: "open", page: 1 });
    expect(ListJobsQuerySchema.parse({ page: "3", status: "all", q: " data " })).toEqual({ status: "all", page: 3, q: "data" });
  });

  it("rejects an unknown status, a non-positive page and a non-uuid source id", () => {
    expect(ListJobsQuerySchema.safeParse({ status: "weird" }).success).toBe(false);
    expect(ListJobsQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(ListJobsQuerySchema.safeParse({ sourceId: "nope" }).success).toBe(false);
  });
});
```

`apps/web/src/app/api/jobs/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { insertJob, insertPosting, insertSource, openAdminDb, wipeJobData } from "../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b5",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000b5";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeJobData(admin, USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await admin.end();
});

const { GET } = await import("./route");
const get = (query = "") => GET(new Request(`http://localhost/api/jobs${query}`));
const titles = async (query = "") => ((await (await get(query)).json()).jobs as { title: string }[]).map((j) => j.title);

describe("GET /api/jobs", () => {
  it("returns open jobs by default, newest posted first with unknown posted dates last, then by first seen", async () => {
    await insertJob(admin, USER, { title: "Posted Old", postedAt: "2026-08-01T00:00:00Z" });
    await insertJob(admin, USER, { title: "Posted New", postedAt: "2026-09-10T00:00:00Z" });
    await insertJob(admin, USER, { title: "Undated Seen Later", postedAt: null, firstSeenAt: "2026-09-15T00:00:00Z" });
    await insertJob(admin, USER, { title: "Undated Seen Earlier", postedAt: null, firstSeenAt: "2026-09-05T00:00:00Z" });
    await insertJob(admin, USER, { title: "Closed One", status: "closed", postedAt: "2026-09-11T00:00:00Z" });

    expect(await titles()).toEqual(["Posted New", "Posted Old", "Undated Seen Later", "Undated Seen Earlier"]);
    expect(await titles("?status=closed")).toEqual(["Closed One"]);
    expect((await titles("?status=all")).length).toBe(5);
  });

  it("returns salary as numbers with its raw span and parse flag, and never invents one", async () => {
    await insertJob(admin, USER, {
      title: "Paid", salaryRaw: "$150,000 - $200,000", salaryMin: 150000, salaryMax: 200000,
      salaryCurrency: "USD", salaryPeriod: "year", salaryIsParsed: true, sponsorship: "not_offered", minExperienceYears: 5,
    });
    await insertJob(admin, USER, { title: "Unpaid" });
    const { jobs } = await (await get()).json();
    const paid = jobs.find((j: { title: string }) => j.title === "Paid");
    const unpaid = jobs.find((j: { title: string }) => j.title === "Unpaid");
    expect(paid.salary).toEqual({ raw: "$150,000 - $200,000", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true });
    expect(paid).toMatchObject({ sponsorship: "not_offered", minExperienceYears: 5 });
    expect(unpaid.salary).toEqual({ raw: null, min: null, max: null, currency: null, period: null, isParsed: false });
  });

  it("filters by title or company, case-insensitively, treating % and _ literally", async () => {
    await insertJob(admin, USER, { title: "Data Engineer", companyName: "Acme" });
    await insertJob(admin, USER, { title: "Designer", companyName: "Data Corp" });
    await insertJob(admin, USER, { title: "100% Remote Analyst", companyName: "Beta" });
    await insertJob(admin, USER, { title: "Chef", companyName: "Gamma" });

    expect((await titles("?q=DATA")).sort()).toEqual(["Data Engineer", "Designer"]);
    expect(await titles("?q=100%25")).toEqual(["100% Remote Analyst"]); // "%" is not a wildcard
    expect(await titles("?q=_")).toEqual([]); // "_" is not a wildcard
  });

  it("filters by source and pages 25 at a time with an accurate total", async () => {
    const source = await insertSource(admin, USER, { slug: "s1" });
    for (let i = 0; i < 27; i++) await insertJob(admin, USER, { title: `Job ${String(i).padStart(2, "0")}`, firstSeenAt: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z` });
    const linked = await insertJob(admin, USER, { title: "Linked Job" });
    await insertPosting(admin, USER, linked, source);

    const page1 = await (await get()).json();
    expect(page1).toMatchObject({ page: 1, pageSize: 25, total: 28 });
    expect(page1.jobs).toHaveLength(25);
    expect((await (await get("?page=2")).json()).jobs).toHaveLength(3);
    expect(await titles(`?sourceId=${source}`)).toEqual(["Linked Job"]);
  });

  it("answers 400 for invalid query parameters", async () => {
    for (const query of ["?status=weird", "?page=0", "?sourceId=nope"]) {
      expect((await get(query)).status, query).toBe(400);
    }
  });
});
```

`apps/web/src/app/api/jobs/[id]/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { insertJob, insertPosting, insertSource, openAdminDb, wipeJobData } from "../../../../test/jobsDb";

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-0000000000b6",
    DATABASE_URL:
      process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
  }),
}));

const USER = "00000000-0000-0000-0000-0000000000b6";
let admin: postgres.Sql;

beforeAll(async () => {
  admin = await openAdminDb();
});
beforeEach(async () => {
  await wipeJobData(admin, USER);
});
afterAll(async () => {
  await wipeJobData(admin, USER);
  await admin.end();
});

const { GET } = await import("./route");
const get = (id: string) => GET(new Request(`http://localhost/api/jobs/${id}`), { params: Promise.resolve({ id }) });

describe("GET /api/jobs/[id]", () => {
  it("returns the job with its evidence, every posting and its source", async () => {
    const gh = await insertSource(admin, USER, { kind: "greenhouse", label: "GitLab", slug: "gitlab" });
    const up = await insertSource(admin, USER, { kind: "upload", label: "jobs.csv" });
    const id = await insertJob(admin, USER, {
      title: "AI Engineer", sponsorship: "not_offered", sponsorshipEvidence: "Visa sponsorship is not available.",
      minExperienceYears: 5, descriptionText: "Build agents.",
    });
    await insertPosting(admin, USER, id, gh, { externalId: "g1", url: "https://boards.example/g1" });
    await insertPosting(admin, USER, id, up, { externalId: "u1", status: "closed" });

    const res = await get(id);
    expect(res.status).toBe(200);
    const { job } = await res.json();
    expect(job).toMatchObject({
      id, title: "AI Engineer", descriptionText: "Build agents.", sponsorship: "not_offered",
      sponsorshipEvidence: "Visa sponsorship is not available.", minExperienceYears: 5,
    });
    expect(job.postings.map((p: { sourceLabel: string; sourceKind: string; status: string }) => [p.sourceLabel, p.sourceKind, p.status])).toEqual([
      ["GitLab", "greenhouse", "open"],
      ["jobs.csv", "upload", "closed"],
    ]);
    expect(job.postings[0].url).toBe("https://boards.example/g1");
    expect(job.duplicateCandidates).toEqual([]);
  });

  it("lists possible duplicates from either side of the pair, most similar first, without merging them", async () => {
    const a = await insertJob(admin, USER, { title: "Data Engineer" });
    const b = await insertJob(admin, USER, { title: "Data Engineers", locationRaw: "Berlin" });
    const c = await insertJob(admin, USER, { title: "Data Eng", locationRaw: "Berlin" });
    const [lo1, hi1] = [a, b].sort();
    const [lo2, hi2] = [a, c].sort();
    await admin`INSERT INTO job_duplicate_candidates (user_id, job_id_a, job_id_b, similarity) VALUES (${USER}, ${lo1}, ${hi1}, 0.9)`;
    await admin`INSERT INTO job_duplicate_candidates (user_id, job_id_a, job_id_b, similarity) VALUES (${USER}, ${lo2}, ${hi2}, 0.82)`;

    const { job } = await (await get(a)).json();
    expect(job.duplicateCandidates.map((d: { title: string; similarity: number; review: string }) => [d.title, Math.round(d.similarity * 100), d.review])).toEqual([
      ["Data Engineers", 90, "pending"],
      ["Data Eng", 82, "pending"],
    ]);
    const fromB = await (await get(b)).json();
    expect(fromB.job.duplicateCandidates.map((d: { title: string }) => d.title)).toEqual(["Data Engineer"]);
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect((await get("00000000-0000-0000-0000-00000000ffff")).status).toBe(404);
    expect((await get("nope")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test -- jobs`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

The list is ordered by the source's posted date (unknown last), then by first-seen, then id — so ordering is stable across pages. `q` matches title or company case-insensitively with `%`/`_` escaped, so "100%" means the characters, not a wildcard.

`apps/web/src/lib/jobs/listJobs.ts`:

```ts
import { and, count, desc, eq, exists, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { schema, type DbClient } from "@ai-career/db";

const { jobs, jobPostings } = schema;

export const PAGE_SIZE = 25;

export const ListJobsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["open", "closed", "all"]).default("open"),
  sourceId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
export type ListJobsQuery = z.infer<typeof ListJobsQuerySchema>;

type JobRow = typeof jobs.$inferSelect;

export interface JobListItem {
  id: string;
  title: string;
  companyName: string;
  locationRaw: string | null;
  workMode: JobRow["workMode"];
  status: JobRow["status"];
  /** Source-reported posted date; null when the source does not give one. */
  postedAt: string | null;
  firstSeenAt: string;
  salary: {
    raw: string | null;
    min: number | null;
    max: number | null;
    currency: string | null;
    period: JobRow["salaryPeriod"];
    isParsed: boolean;
  };
  sponsorship: JobRow["sponsorship"];
  minExperienceYears: number | null;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

export function toJobListItem(row: JobRow): JobListItem {
  return {
    id: row.id,
    title: row.title,
    companyName: row.companyName,
    locationRaw: row.locationRaw,
    workMode: row.workMode,
    status: row.status,
    postedAt: row.postedAt?.toISOString() ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    salary: {
      raw: row.salaryRaw,
      min: num(row.salaryMin),
      max: num(row.salaryMax),
      currency: row.salaryCurrency,
      period: row.salaryPeriod,
      isParsed: row.salaryIsParsed,
    },
    sponsorship: row.sponsorship,
    minExperienceYears: row.minExperienceYears,
  };
}

/** So a user typing "100%" or "a_b" searches for those characters instead of a wildcard. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function listJobs(
  tx: DbClient,
  query: ListJobsQuery
): Promise<{ jobs: JobListItem[]; page: number; pageSize: number; total: number }> {
  const conditions: SQL[] = [];
  if (query.status !== "all") conditions.push(eq(jobs.status, query.status));
  if (query.q) {
    const pattern = `%${escapeLike(query.q)}%`;
    conditions.push(or(ilike(jobs.title, pattern), ilike(jobs.companyName, pattern)) as SQL);
  }
  if (query.sourceId) {
    conditions.push(
      exists(
        tx
          .select({ one: sql`1` })
          .from(jobPostings)
          .where(and(eq(jobPostings.jobId, jobs.id), eq(jobPostings.sourceId, query.sourceId)))
      )
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await tx
    .select()
    .from(jobs)
    .where(where)
    .orderBy(sql`${jobs.postedAt} DESC NULLS LAST`, desc(jobs.firstSeenAt), jobs.id)
    .limit(PAGE_SIZE)
    .offset((query.page - 1) * PAGE_SIZE);
  const [{ total }] = await tx.select({ total: count() }).from(jobs).where(where);

  return { jobs: rows.map(toJobListItem), page: query.page, pageSize: PAGE_SIZE, total };
}
```

`apps/web/src/lib/jobs/getJobDetail.ts`:

```ts
import { eq, inArray, or } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { toJobListItem, type JobListItem } from "./listJobs";

const { jobs, jobPostings, jobSources, jobDuplicateCandidates } = schema;

export interface JobDetail extends JobListItem {
  seniority: string | null;
  employmentType: string | null;
  countryCode: string | null;
  descriptionText: string;
  minExperienceEvidence: string | null;
  sponsorshipEvidence: string | null;
  sponsorshipConflict: boolean;
  lastVerifiedAt: string;
  closedAt: string | null;
  /** field group -> id of the posting that supplied it. */
  fieldProvenance: Record<string, string>;
  postings: {
    id: string;
    sourceId: string;
    sourceKind: "greenhouse" | "lever" | "upload";
    sourceLabel: string;
    url: string | null;
    status: "open" | "closed";
    firstSeenAt: string;
    lastSeenAt: string;
  }[];
  /** Possible duplicates: never merged, listed for the user to judge. */
  duplicateCandidates: {
    jobId: string;
    title: string;
    companyName: string;
    locationRaw: string | null;
    status: "open" | "closed";
    similarity: number;
    review: "pending" | "same" | "different";
  }[];
}

export async function getJobDetail(tx: DbClient, id: string): Promise<JobDetail | null> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!job) return null;

  const postings = await tx
    .select({ posting: jobPostings, kind: jobSources.kind, label: jobSources.label })
    .from(jobPostings)
    .innerJoin(jobSources, eq(jobPostings.sourceId, jobSources.id))
    .where(eq(jobPostings.jobId, id))
    .orderBy(jobPostings.firstSeenAt);

  const pairs = await tx
    .select()
    .from(jobDuplicateCandidates)
    .where(or(eq(jobDuplicateCandidates.jobIdA, id), eq(jobDuplicateCandidates.jobIdB, id)));
  const otherIds = pairs.map((p) => (p.jobIdA === id ? p.jobIdB : p.jobIdA));
  const others =
    otherIds.length > 0 ? await tx.select().from(jobs).where(inArray(jobs.id, otherIds)) : [];
  const otherById = new Map(others.map((o) => [o.id, o]));

  return {
    ...toJobListItem(job),
    seniority: job.seniority,
    employmentType: job.employmentType,
    countryCode: job.countryCode,
    descriptionText: job.descriptionText,
    minExperienceEvidence: job.minExperienceEvidence,
    sponsorshipEvidence: job.sponsorshipEvidence,
    sponsorshipConflict: job.sponsorshipConflict,
    lastVerifiedAt: job.lastVerifiedAt.toISOString(),
    closedAt: job.closedAt?.toISOString() ?? null,
    fieldProvenance: job.fieldProvenance,
    postings: postings.map(({ posting, kind, label }) => ({
      id: posting.id,
      sourceId: posting.sourceId,
      sourceKind: kind,
      sourceLabel: label,
      url: posting.url,
      status: posting.status,
      firstSeenAt: posting.firstSeenAt.toISOString(),
      lastSeenAt: posting.lastSeenAt.toISOString(),
    })),
    duplicateCandidates: pairs
      .map((pair) => {
        const other = otherById.get(pair.jobIdA === id ? pair.jobIdB : pair.jobIdA);
        return other
          ? {
              jobId: other.id,
              title: other.title,
              companyName: other.companyName,
              locationRaw: other.locationRaw,
              status: other.status,
              similarity: pair.similarity,
              review: pair.status,
            }
          : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.similarity - a.similarity),
  };
}
```

`apps/web/src/app/api/jobs/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { formatValidationError } from "../../../lib/formatValidationError";
import { ListJobsQuerySchema, listJobs } from "../../../lib/jobs/listJobs";

export async function GET(request: Request) {
  const env = loadEnv();
  const parsed = ListJobsQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }

  const db = createDbClient(env);
  try {
    const result = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => listJobs(tx, parsed.data));
    return NextResponse.json(result);
  } finally {
    await closeDbClient(db);
  }
}
```

`apps/web/src/app/api/jobs/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { getJobDetail } from "../../../../lib/jobs/getJobDetail";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const job = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => getJobDetail(tx, id));
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
    return NextResponse.json({ job });
  } finally {
    await closeDbClient(db);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter web test -- jobs job-sources && pnpm --filter web lint`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(web): add jobs list and detail API"`

---

### Task 16: Web — display helpers and the Sources page

**Files:**
- Create: `apps/web/src/lib/jobs/format.ts`, `apps/web/src/app/sources/page.tsx`, `SourcesClient.tsx`, `AddBoardForm.tsx`, `UploadJobsForm.tsx`, `SourceRow.tsx`
- Test: `apps/web/src/lib/jobs/format.test.ts`, `apps/web/src/app/sources/SourcesClient.test.tsx`

**Interfaces:**
- Consumes: the Task 13 API and `JobSourceView` (type-only import), `JobListItem` (Task 15).
- Produces: `formatDate`, `formatSalary`, `formatPosted`, `formatWorkMode`, `formatSponsorship`, `formatErrorClass`, `safeHttpUrl` (used again by Task 17); the `/sources` page.

**Read first:** `apps/web/AGENTS.md`. **Lint rule to respect:** `react-hooks/set-state-in-effect` rejects `setState` calls inside an `async` function that an effect calls; load data with a promise chain (`fetch(...).then(...).catch(...)`), as `CareerGoalClient.tsx` does. The components below already do.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/jobs/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatDate, formatErrorClass, formatPosted, formatSalary, formatSponsorship, formatWorkMode, safeHttpUrl } from "./format";

const salary = (over: Partial<Parameters<typeof formatSalary>[0]> = {}) => ({
  raw: null, min: null, max: null, currency: null, period: null, isParsed: false, ...over,
});

describe("formatSalary", () => {
  it("shows a parsed range with its currency, and says when it was annualized", () => {
    expect(formatSalary(salary({ raw: "$150k", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true }))).toBe("USD 150,000–200,000 / year");
    expect(formatSalary(salary({ raw: "€3k", min: 36000, max: 36000, currency: "EUR", period: "month", isParsed: true }))).toBe("EUR 36,000 / year (annualized from monthly pay)");
  });

  it("shows an unparsed span verbatim and flags it as unclear", () => {
    expect(formatSalary(salary({ raw: "$150,000 - $200,000 or £100,000" }))).toBe("Unclear: “$150,000 - $200,000 or £100,000”");
  });

  it("says 'Not stated' — never zero — when there is no salary", () => {
    expect(formatSalary(salary())).toBe("Not stated");
  });
});

describe("formatPosted", () => {
  it("uses the posted date when there is one, otherwise labels first-seen as such", () => {
    expect(formatPosted({ postedAt: "2026-09-10T00:00:00Z", firstSeenAt: "2026-09-15T00:00:00Z" })).toBe("Posted Sep 10, 2026");
    expect(formatPosted({ postedAt: null, firstSeenAt: "2026-09-15T00:00:00Z" })).toBe("First seen Sep 15, 2026 (no posted date)");
    expect(formatDate("2026-01-01T00:00:00Z")).toBe("Jan 1, 2026");
  });
});

describe("labels", () => {
  it("never present unknown as a fact", () => {
    expect(formatWorkMode("unknown")).toBe("Work mode not stated");
    expect(formatSponsorship("unknown")).toBe("Sponsorship not stated");
    expect(formatSponsorship("not_offered")).toBe("No visa sponsorship");
  });
  it("maps every error class to a sentence and falls back for unrecognised ones", () => {
    expect(formatErrorClass("not_found")).toMatch(/Board not found/);
    expect(formatErrorClass("empty_result")).toMatch(/nothing was closed/);
    expect(formatErrorClass("something_new")).toMatch(/Something went wrong/);
  });
});

describe("safeHttpUrl", () => {
  it("passes http(s) URLs and drops everything else (third-party data must not become a script link)", () => {
    expect(safeHttpUrl("https://boards.example/jobs/1")).toBe("https://boards.example/jobs/1");
    expect(safeHttpUrl("http://boards.example/x")).toBe("http://boards.example/x");
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "not a url", "", null]) {
      expect(safeHttpUrl(bad as string | null), String(bad)).toBeNull();
    }
  });
});
```

`apps/web/src/app/sources/SourcesClient.test.tsx`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SourcesClient } from "./SourcesClient";

const source = (over: Record<string, unknown> = {}) => ({
  id: "s1", kind: "greenhouse", label: "GitLab", slug: "gitlab", companyName: "GitLab", enabled: false,
  consentConfirmedAt: null, lastRunAt: null, lastRunStatus: null, lastErrorClass: null, lastRun: null,
  createdAt: "2026-09-01T00:00:00Z", ...over,
});

type Handler = (init?: RequestInit) => { status?: number; body: unknown };
function mockFetch(handlers: Record<string, Handler>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const handler = handlers[`${init?.method ?? "GET"} ${url}`];
    if (!handler) throw new Error(`unhandled request: ${init?.method ?? "GET"} ${url}`);
    const { status = 200, body } = handler(init);
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const list = (sources: unknown[]) => ({ "GET /api/job-sources": () => ({ body: { sources } }) });
const calls = (fn: ReturnType<typeof mockFetch>, key: string) =>
  fn.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${url}` === key);

beforeEach(() => vi.unstubAllGlobals());

describe("SourcesClient", () => {
  it("shows a helpful empty state", async () => {
    mockFetch(list([]));
    render(<SourcesClient />);
    expect(await screen.findByText(/No sources yet/)).toBeInTheDocument();
  });

  it("lists sources with their status and last run, and explains failures in words", async () => {
    mockFetch(list([
      source({ id: "a", label: "GitLab", enabled: true, consentConfirmedAt: "2026-09-02T00:00:00Z", lastRunStatus: "succeeded", lastRunAt: "2026-09-20T00:00:00Z",
        lastRun: { complete: true, fetched: 209, created: 12, updated: 3, unchanged: 190, closed: 4, failed: 0 } }),
      source({ id: "b", label: "Nope", slug: "nope", enabled: true, consentConfirmedAt: "2026-09-02T00:00:00Z", lastRunStatus: "failed", lastRunAt: "2026-09-20T00:00:00Z", lastErrorClass: "not_found" }),
      source({ id: "c", label: "Never", slug: "never" }),
    ]));
    render(<SourcesClient />);
    expect(await screen.findByText(/209 fetched · 12 new · 3 updated · 4 closed/)).toBeInTheDocument();
    expect(screen.getByText(/Board not found — check the board token/)).toBeInTheDocument();
    expect(screen.getByText("Not run yet")).toBeInTheDocument();
  });

  it("cannot enable a source until its Terms of Service confirmation is ticked, then sends it", async () => {
    let listed = [source()];
    const fn = mockFetch({
      "GET /api/job-sources": () => ({ body: { sources: listed } }),
      "PATCH /api/job-sources/s1": () => {
        listed = [source({ enabled: true, consentConfirmedAt: "2026-09-21T00:00:00Z" })];
        return { body: { source: listed[0] } };
      },
    });
    render(<SourcesClient />);
    const enable = await screen.findByRole("button", { name: "Enable" });
    expect(enable).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/reviewed this source's Terms of Service/));
    expect(enable).toBeEnabled();
    fireEvent.click(enable);

    await waitFor(() => expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument());
    const [, init] = calls(fn, "PATCH /api/job-sources/s1")[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ enabled: true, consentConfirmed: true });
    expect(screen.queryByLabelText(/reviewed this source's Terms of Service/)).not.toBeInTheDocument();
  });

  it("does not ask again for a source that already has the confirmation, and can disable it", async () => {
    const fn = mockFetch({
      ...list([source({ enabled: true, consentConfirmedAt: "2026-09-02T00:00:00Z" })]),
      "PATCH /api/job-sources/s1": () => ({ body: {} }),
    });
    render(<SourcesClient />);
    expect(screen.queryByLabelText(/Terms of Service/)).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    await waitFor(() => expect(calls(fn, "PATCH /api/job-sources/s1")).toHaveLength(1));
    expect(JSON.parse((calls(fn, "PATCH /api/job-sources/s1")[0][1] as RequestInit).body as string)).toEqual({ enabled: false, consentConfirmed: false });
  });

  it("queues a run and says so; shows the server's reason when a run is refused", async () => {
    const ok = { enabled: true, consentConfirmedAt: "2026-09-02T00:00:00Z" };
    let status = 202;
    mockFetch({
      ...list([source(ok)]),
      "POST /api/job-sources/s1/run": () => (status === 202 ? { status, body: { status: "queued" } } : { status, body: { error: "A run for this source is already queued or running" } }),
    });
    render(<SourcesClient />);
    const run = await screen.findByRole("button", { name: "Run now" });
    fireEvent.click(run);
    expect(await screen.findByRole("status")).toHaveTextContent(/Queued a run for GitLab/);

    status = 409;
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already queued or running/);
  });

  it("disables 'Run now' for a source that is not enabled", async () => {
    mockFetch(list([source()]));
    render(<SourcesClient />);
    expect(await screen.findByRole("button", { name: "Run now" })).toBeDisabled();
  });

  it("adds a board, shows the server's error for a duplicate, and clears the form on success", async () => {
    let status = 409;
    const fn = mockFetch({
      ...list([]),
      "POST /api/job-sources": () => (status === 201 ? { status, body: { source: source() } } : { status, body: { error: "That board is already on your list" } }),
    });
    render(<SourcesClient />);
    fireEvent.change(await screen.findByLabelText("Board token"), { target: { value: "gitlab" } });
    fireEvent.change(screen.getByLabelText(/Company name/), { target: { value: "GitLab" } });
    fireEvent.click(screen.getByRole("button", { name: "Add board" }));
    expect(await screen.findByText(/already on your list/)).toBeInTheDocument();
    expect(JSON.parse((calls(fn, "POST /api/job-sources")[0][1] as RequestInit).body as string)).toEqual({ kind: "greenhouse", slug: "gitlab", companyName: "GitLab" });

    status = 201;
    fireEvent.click(screen.getByRole("button", { name: "Add board" }));
    await waitFor(() => expect(screen.getByLabelText("Board token")).toHaveValue(""));
  });

  it("uploads a file only with a file and the confirmation, and reports how many jobs were stored", async () => {
    const fn = mockFetch({
      ...list([]),
      "POST /api/job-sources/upload": () => ({ status: 201, body: { sourceId: "u1", count: 2, queued: true } }),
    });
    render(<SourcesClient />);
    const button = await screen.findByRole("button", { name: "Upload" });

    fireEvent.click(button);
    expect(screen.getByText("Select a file first.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Job file/), { target: { files: [new File(["title,company\nA,B"], "jobs.csv")] } });
    fireEvent.click(button);
    expect(screen.getByText(/Confirm that you are permitted/)).toBeInTheDocument();
    expect(calls(fn, "POST /api/job-sources/upload")).toHaveLength(0);

    fireEvent.click(screen.getByLabelText(/permitted to use the data/));
    fireEvent.click(button);
    expect(await screen.findByRole("status")).toHaveTextContent("Uploaded 2 jobs — they are being processed.");
    const form = (calls(fn, "POST /api/job-sources/upload")[0][1] as RequestInit).body as FormData;
    expect(form.get("consentConfirmed")).toBe("true");
    expect((form.get("file") as File).name).toBe("jobs.csv");
  });

  it("offers a retry when the list cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<SourcesClient />);
    expect(await screen.findByText(/Could not load your sources/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test -- format sources`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementation**

UX rules the tests pin down: *Enable* is disabled until the Terms-of-Service checkbox is ticked (only shown for a source that has never been confirmed); error **classes** are shown as plain sentences; "Run now" is disabled for a disabled source; missing salary reads "Not stated", never zero.

`apps/web/src/lib/jobs/format.ts`:

```ts
import type { JobListItem } from "./listJobs";

const DATE = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}

/**
 * Missing salary is "Not stated", never zero. An unparsed span is shown as-is and flagged, so the user
 * sees exactly what the parser saw (D6). Hourly/monthly values were annualized at ingest; say so.
 */
export function formatSalary(salary: JobListItem["salary"]): string {
  if (salary.isParsed && salary.min !== null && salary.max !== null) {
    const range =
      salary.min === salary.max ? NUMBER.format(salary.min) : `${NUMBER.format(salary.min)}–${NUMBER.format(salary.max)}`;
    const note = salary.period && salary.period !== "year" ? ` (annualized from ${salary.period}ly pay)` : "";
    return `${salary.currency} ${range} / year${note}`;
  }
  if (salary.raw) return `Unclear: “${salary.raw}”`;
  return "Not stated";
}

/** The source's posted date when it gives one; otherwise say plainly that this is only when we first saw it. */
export function formatPosted(job: Pick<JobListItem, "postedAt" | "firstSeenAt">): string {
  return job.postedAt ? `Posted ${formatDate(job.postedAt)}` : `First seen ${formatDate(job.firstSeenAt)} (no posted date)`;
}

const WORK_MODE: Record<JobListItem["workMode"], string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  unknown: "Work mode not stated",
};
export const formatWorkMode = (mode: JobListItem["workMode"]): string => WORK_MODE[mode];

const SPONSORSHIP: Record<JobListItem["sponsorship"], string> = {
  offered: "Visa sponsorship offered",
  not_offered: "No visa sponsorship",
  unknown: "Sponsorship not stated",
};
export const formatSponsorship = (value: JobListItem["sponsorship"]): string => SPONSORSHIP[value];

const ERROR_CLASS: Record<string, string> = {
  not_found: "Board not found — check the board token",
  invalid_slug: "The board token is not valid",
  rate_limited: "Rate limited by the source — it will retry",
  server_error: "The source had a server error — it will retry",
  network: "Could not reach the source — it will retry",
  timeout: "The source timed out — it will retry",
  http_error: "The source refused the request",
  response_too_large: "The source's response was too large",
  schema_mismatch: "The source returned data in an unexpected format",
  consent_missing: "Terms-of-Service confirmation is missing",
  source_disabled: "The source is disabled",
  empty_result: "The last fetch returned no jobs, so nothing was closed",
  unknown: "Something went wrong — it will retry",
};
export const formatErrorClass = (errorClass: string): string => ERROR_CLASS[errorClass] ?? ERROR_CLASS.unknown;

/** Posting URLs come from third-party data: only ever render http(s) links (never `javascript:` and friends). */
export function safeHttpUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
```

`apps/web/src/app/sources/page.tsx`:

```ts
import { SourcesClient } from "./SourcesClient";

export default function SourcesPage() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">Job sources</h1>
      <p className="mb-6 text-sm text-gray-600">
        Jobs come only from sources you add and confirm. Greenhouse and Lever expose one board per company, so this is
        a watch-list of the companies you want to follow.
      </p>
      <SourcesClient />
    </main>
  );
}
```

`apps/web/src/app/sources/AddBoardForm.tsx`:

```ts
"use client";

import { useState } from "react";

export function AddBoardForm({ onAdded }: { onAdded: () => void }) {
  const [kind, setKind] = useState<"greenhouse" | "lever">("greenhouse");
  const [slug, setSlug] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (slug.trim() === "") {
      setError("Enter the board token.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/job-sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, slug: slug.trim(), ...(companyName.trim() ? { companyName: companyName.trim() } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not add that board.");
        return;
      }
      setSlug("");
      setCompanyName("");
      onAdded();
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded border p-4">
      <legend className="px-1 text-sm font-medium">Add a company board</legend>
      <label htmlFor="board-kind" className="text-sm">Source type</label>
      <select id="board-kind" value={kind} onChange={(e) => setKind(e.target.value as "greenhouse" | "lever")} className="block rounded border px-2 py-1">
        <option value="greenhouse">Greenhouse</option>
        <option value="lever">Lever</option>
      </select>
      <label htmlFor="board-slug" className="text-sm">Board token</label>
      <input id="board-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="e.g. gitlab" className="block rounded border px-2 py-1" />
      <p className="text-xs text-gray-500">The last part of the company&apos;s job-board address, e.g. boards.greenhouse.io/<b>gitlab</b> or jobs.lever.co/<b>spotify</b>.</p>
      <label htmlFor="board-company" className="text-sm">Company name (optional)</label>
      <input id="board-company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="block rounded border px-2 py-1" />
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button type="button" onClick={submit} disabled={busy} className="w-fit rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {busy ? "Adding..." : "Add board"}
      </button>
    </fieldset>
  );
}
```

`apps/web/src/app/sources/UploadJobsForm.tsx`:

```ts
"use client";

import { useState } from "react";

export function UploadJobsForm({ onUploaded }: { onUploaded: (message: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file) {
      setError("Select a file first.");
      return;
    }
    if (!consent) {
      setError("Confirm that you are permitted to use this data.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("consentConfirmed", "true");
      const res = await fetch("/api/job-sources/upload", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not upload that file.");
        return;
      }
      setFile(null);
      setConsent(false);
      onUploaded(
        body.queued
          ? `Uploaded ${body.count} jobs — they are being processed.`
          : `Uploaded ${body.count} jobs, but the worker queue is unavailable. Use “Run now” once it is running.`
      );
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="flex flex-col gap-3 rounded border p-4">
      <legend className="px-1 text-sm font-medium">Upload a job export</legend>
      <label htmlFor="upload-file" className="text-sm">Job file (CSV or JSON)</label>
      <input id="upload-file" type="file" accept=".csv,.json" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block text-sm" />
      <p className="text-xs text-gray-500">Columns: <b>title</b> and <b>company</b> are required; location, description, url, posted_at, employment_type, salary and id are optional. Up to 5,000 rows.</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
        I confirm I am permitted to use the data in this file.
      </label>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <button type="button" onClick={submit} disabled={busy} className="w-fit rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        {busy ? "Uploading..." : "Upload"}
      </button>
    </fieldset>
  );
}
```

`apps/web/src/app/sources/SourceRow.tsx`:

```ts
"use client";

import { useState } from "react";
import type { JobSourceView } from "../../lib/job-sources/serializeSource";
import { formatDate, formatErrorClass } from "../../lib/jobs/format";

const KIND: Record<JobSourceView["kind"], string> = { greenhouse: "Greenhouse", lever: "Lever", upload: "File upload" };

function lastRunText(source: JobSourceView): string {
  if (source.lastRunStatus === "running") return "Running…";
  if (!source.lastRunStatus || !source.lastRunAt) return "Not run yet";
  const when = formatDate(source.lastRunAt);
  if (source.lastRunStatus === "failed") {
    return `Last run failed (${when}): ${formatErrorClass(source.lastErrorClass ?? "unknown")}`;
  }
  const run = source.lastRun;
  const counts = run
    ? `${run.fetched} fetched · ${run.created} new · ${run.updated} updated · ${run.closed} closed${run.failed ? ` · ${run.failed} unreadable` : ""}`
    : "";
  const note = source.lastErrorClass ? ` — ${formatErrorClass(source.lastErrorClass)}` : run && !run.complete ? " — incomplete, nothing was closed" : "";
  return `Last run ${when}: ${counts}${note}`;
}

export function SourceRow({
  source,
  busy,
  onToggle,
  onRun,
}: {
  source: JobSourceView;
  busy: boolean;
  onToggle: (enabled: boolean, consentConfirmed: boolean) => void;
  onRun: () => void;
}) {
  const [consent, setConsent] = useState(false);
  const needsConsent = source.consentConfirmedAt === null;
  const consentId = `consent-${source.id}`;

  return (
    <li className="flex flex-col gap-2 rounded border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{source.label}</h3>
        <span className={`rounded px-2 py-0.5 text-xs ${source.enabled ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-700"}`}>
          {source.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>
      <p className="text-sm text-gray-600">
        {KIND[source.kind]}
        {source.slug ? ` · ${source.slug}` : ""}
      </p>
      <p className="text-sm">{lastRunText(source)}</p>

      {needsConsent && (
        <label htmlFor={consentId} className="flex items-start gap-2 text-sm">
          <input id={consentId} type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
          I have reviewed this source&apos;s Terms of Service and I am permitted to ingest its data.
        </label>
      )}

      <div className="flex gap-2">
        {source.enabled ? (
          <button type="button" disabled={busy} onClick={() => onToggle(false, false)} className="rounded border px-3 py-1 text-sm disabled:opacity-50">
            Disable
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || (needsConsent && !consent)}
            onClick={() => onToggle(true, needsConsent && consent)}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
          >
            Enable
          </button>
        )}
        <button type="button" disabled={busy || !source.enabled} onClick={onRun} className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50">
          Run now
        </button>
      </div>
    </li>
  );
}
```

`apps/web/src/app/sources/SourcesClient.tsx`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { JobSourceView } from "../../lib/job-sources/serializeSource";
import { AddBoardForm } from "./AddBoardForm";
import { SourceRow } from "./SourceRow";
import { UploadJobsForm } from "./UploadJobsForm";

const POLL_INTERVAL_MS = 3000;
const POLL_DURATION_MS = 60_000;

export function SourcesClient() {
  const [sources, setSources] = useState<JobSourceView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollUntil, setPollUntil] = useState(0);

  // A promise chain (state is set inside callbacks), matching CareerGoalClient: the React lint rule
  // react-hooks/set-state-in-effect rejects setState calls in an async function that an effect invokes.
  const load = useCallback(
    () =>
      fetch("/api/job-sources")
        .then((res) => {
          if (!res.ok) throw new Error("load failed");
          return res.json();
        })
        .then((body) => {
          setSources(body.sources);
          setLoadFailed(false);
        })
        .catch(() => setLoadFailed(true)),
    []
  );

  useEffect(() => {
    void load();
  }, [load]);

  // After a run is queued, refresh for a minute so the result appears without a manual reload.
  useEffect(() => {
    if (pollUntil <= Date.now()) return;
    const timer = setInterval(() => {
      if (Date.now() > pollUntil) clearInterval(timer);
      else void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pollUntil, load]);

  async function call(id: string, path: string, init: RequestInit, onOk: () => void) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(path, init);
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Something went wrong.");
      else onOk();
    } catch {
      setError("Could not reach the server — check your connection and try again.");
    } finally {
      setBusyId(null);
    }
  }

  const toggle = (source: JobSourceView, enabled: boolean, consentConfirmed: boolean) =>
    call(
      source.id,
      `/api/job-sources/${source.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, consentConfirmed }) },
      () => void load()
    );

  const run = (source: JobSourceView) =>
    call(source.id, `/api/job-sources/${source.id}/run`, { method: "POST" }, () => {
      setNotice(`Queued a run for ${source.label}. Make sure the worker is running (pnpm --filter @ai-career/job-ingestion start).`);
      setPollUntil(Date.now() + POLL_DURATION_MS);
      void load();
    });

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-2">
        <AddBoardForm onAdded={() => void load()} />
        <UploadJobsForm
          onUploaded={(message) => {
            setNotice(message);
            setPollUntil(Date.now() + POLL_DURATION_MS);
            void load();
          }}
        />
      </div>

      {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      {loadFailed && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-600">Could not load your sources — check your connection and try again.</p>
          <button type="button" onClick={() => void load()} className="w-fit rounded border px-4 py-2 text-sm">Retry</button>
        </div>
      )}

      {sources === null && !loadFailed && <p>Loading...</p>}
      {sources !== null && sources.length === 0 && (
        <p className="text-sm text-gray-600">No sources yet. Add a company board or upload a job export above.</p>
      )}
      {sources !== null && sources.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Job sources">
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              busy={busyId === source.id}
              onToggle={(enabled, consent) => void toggle(source, enabled, consent)}
              onRun={() => void run(source)}
            />
          ))}
        </ul>
      )}

      <p className="text-sm">
        <Link href="/jobs" className="underline">Browse ingested jobs →</Link>
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter web test -- format sources && pnpm --filter web lint`
Expected: PASS (`format`: 7 tests, including `safeHttpUrl`; `SourcesClient`: 9 tests), lint clean.

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(web): add Sources page with consent-gated enabling and upload"`

---

### Task 17: Web — Jobs pages and home-page links

**Files:**
- Create: `apps/web/src/app/jobs/page.tsx`, `JobsClient.tsx`, `apps/web/src/app/jobs/[id]/page.tsx`, `JobDetailClient.tsx`
- Test: `apps/web/src/app/jobs/JobsClient.test.tsx`, `apps/web/src/app/jobs/[id]/JobDetailClient.test.tsx`, `apps/web/src/app/page.test.tsx` (modify)
- Modify: `apps/web/src/app/page.tsx`

**Interfaces:**
- Consumes: Task 15 API and types, Task 16 `format.ts`.
- Produces: `/jobs` and `/jobs/[id]` pages; home links to `/sources` and `/jobs`.

**Read first:** in `apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md`: a page's `params` is a **`Promise`** (`export default async function Page({ params }: { params: Promise<{ id: string }> })`). `[id]/page.tsx` below awaits it.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/app/jobs/JobsClient.test.tsx`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { JobsClient } from "./JobsClient";

const job = (over: Record<string, unknown> = {}) => ({
  id: "j1", title: "Data Engineer", companyName: "Acme", locationRaw: "Berlin", workMode: "remote", status: "open",
  postedAt: "2026-09-10T00:00:00Z", firstSeenAt: "2026-09-12T00:00:00Z",
  salary: { raw: "$150k", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true },
  sponsorship: "not_offered", minExperienceYears: 5, ...over,
});
const page = (jobs: unknown[], total = jobs.length, pageNo = 1) => ({ jobs, page: pageNo, pageSize: 25, total });

function mockJobs(respond: (url: string) => unknown) {
  const fn = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => respond(url) }) as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}
beforeEach(() => vi.unstubAllGlobals());

describe("JobsClient", () => {
  it("shows what was read from each posting — and says 'not stated' rather than inventing values", async () => {
    mockJobs(() => page([
      job(),
      job({ id: "j2", title: "Analyst", workMode: "unknown", postedAt: null, sponsorship: "unknown", minExperienceYears: null,
        salary: { raw: null, min: null, max: null, currency: null, period: null, isParsed: false } }),
    ]));
    render(<JobsClient />);
    expect(await screen.findByRole("link", { name: "Data Engineer" })).toHaveAttribute("href", "/jobs/j1");
    expect(screen.getByText(/USD 150,000–200,000 \/ year/)).toBeInTheDocument();
    expect(screen.getByText(/5\+ years experience/)).toBeInTheDocument();
    expect(screen.getByText("Posted Sep 10, 2026")).toBeInTheDocument();

    expect(screen.getByText(/Not stated · Sponsorship not stated/)).toBeInTheDocument();
    expect(screen.getByText(/First seen Sep 12, 2026 \(no posted date\)/)).toBeInTheDocument();
    expect(screen.getByText(/Work mode not stated/)).toBeInTheDocument();
  });

  it("searches and filters by status, resetting to page 1", async () => {
    const fn = mockJobs(() => page([job()]));
    render(<JobsClient />);
    await screen.findByText("Data Engineer");
    expect(fn.mock.calls[0][0]).toBe("/api/jobs?status=open&page=1");

    fireEvent.change(screen.getByLabelText("Title or company"), { target: { value: " data " } });
    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fn.mock.calls.at(-1)?.[0]).toBe("/api/jobs?status=all&page=1&q=data"));
  });

  it("pages through results", async () => {
    const fn = mockJobs((url) => (url.includes("page=2") ? page([job({ id: "j26", title: "Job 26" })], 26, 2) : page([job()], 26, 1)));
    render(<JobsClient />);
    expect(await screen.findByText("Showing 1–25 of 26")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Showing 26–26 of 26")).toBeInTheDocument();
    expect(fn.mock.calls.at(-1)?.[0]).toContain("page=2");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("points to the sources page when there are no jobs, and offers a retry on failure", async () => {
    mockJobs(() => page([]));
    const { unmount } = render(<JobsClient />);
    expect(await screen.findByRole("link", { name: /Add a source and run it/ })).toHaveAttribute("href", "/sources");
    unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<JobsClient />);
    expect(await screen.findByText(/Could not load jobs/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
```

`apps/web/src/app/jobs/[id]/JobDetailClient.test.tsx`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { JobDetailClient } from "./JobDetailClient";

const detail = (over: Record<string, unknown> = {}) => ({
  id: "j1", title: "AI Engineer", companyName: "GitLab", locationRaw: "Remote, United States", workMode: "remote", status: "open",
  postedAt: "2026-05-22T13:16:29Z", firstSeenAt: "2026-09-12T00:00:00Z", lastVerifiedAt: "2026-09-20T00:00:00Z", closedAt: null,
  salary: { raw: "$150,000 - $200,000 per year", min: 150000, max: 200000, currency: "USD", period: "year", isParsed: true },
  sponsorship: "not_offered", sponsorshipEvidence: "Visa sponsorship is not available.", sponsorshipConflict: false,
  minExperienceYears: 5, minExperienceEvidence: "5+ years of experience in software engineering",
  seniority: null, employmentType: null, countryCode: null, descriptionText: "Build agents.", fieldProvenance: {},
  postings: [
    { id: "p1", sourceId: "s1", sourceKind: "greenhouse", sourceLabel: "GitLab", url: "https://boards.example/1", status: "open", firstSeenAt: "2026-09-12T00:00:00Z", lastSeenAt: "2026-09-20T00:00:00Z" },
    { id: "p2", sourceId: "s2", sourceKind: "upload", sourceLabel: "jobs.csv", url: "javascript:alert(1)", status: "closed", firstSeenAt: "2026-09-12T00:00:00Z", lastSeenAt: "2026-09-13T00:00:00Z" },
  ],
  duplicateCandidates: [{ jobId: "j9", title: "AI Engineers", companyName: "GitLab", locationRaw: "Remote", status: "open", similarity: 0.91, review: "pending" }],
  ...over,
});
const respond = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response));
beforeEach(() => vi.unstubAllGlobals());

describe("JobDetailClient", () => {
  it("shows each extracted fact next to the text it was read from", async () => {
    respond(200, { job: detail() });
    render(<JobDetailClient id="j1" />);
    expect(await screen.findByRole("heading", { name: "AI Engineer" })).toBeInTheDocument();
    expect(screen.getByText(/USD 150,000–200,000 \/ year/)).toBeInTheDocument();
    expect(screen.getByText("Source text: “$150,000 - $200,000 per year”")).toBeInTheDocument();
    expect(screen.getByText("No visa sponsorship")).toBeInTheDocument();
    expect(screen.getByText("“Visa sponsorship is not available.”")).toBeInTheDocument();
    expect(screen.getByText("5+ years")).toBeInTheDocument();
    expect(screen.getByText("“5+ years of experience in software engineering”")).toBeInTheDocument();
    expect(screen.getByText("Build agents.")).toBeInTheDocument();
  });

  it("only renders http(s) links for postings — third-party data never becomes a script link", async () => {
    respond(200, { job: detail() });
    render(<JobDetailClient id="j1" />);
    await screen.findByText(/GitLab \(greenhouse\)/);
    const links = screen.getAllByRole("link", { name: "View posting" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://boards.example/1");
    expect(links[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/jobs\.csv \(upload\) · closed/)).toBeInTheDocument();
  });

  it("lists possible duplicates as read-only links, and warns about a sponsorship conflict", async () => {
    respond(200, { job: detail({ sponsorship: "unknown", sponsorshipConflict: true }) });
    render(<JobDetailClient id="j1" />);
    expect(await screen.findByRole("link", { name: "AI Engineers" })).toHaveAttribute("href", "/jobs/j9");
    expect(screen.getByText(/91% title match/)).toBeInTheDocument();
    expect(screen.getByText(/were not merged automatically/)).toBeInTheDocument();
    expect(screen.getByText(/conflicting statements/)).toBeInTheDocument();
  });

  it("hides the duplicates section when there are none, and says when there is no posted date", async () => {
    respond(200, { job: detail({ duplicateCandidates: [], postedAt: null }) });
    render(<JobDetailClient id="j1" />);
    await screen.findByRole("heading", { name: "AI Engineer" });
    expect(screen.queryByText("Possible duplicates")).not.toBeInTheDocument();
    expect(screen.getByText(/First seen Sep 12, 2026 \(no posted date\)/)).toBeInTheDocument();
  });

  it("handles a missing job and a failed load", async () => {
    respond(404, { error: "Job not found" });
    const { unmount } = render(<JobDetailClient id="nope" />);
    expect(await screen.findByText("Job not found.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All jobs/ })).toHaveAttribute("href", "/jobs");
    unmount();

    respond(500, {});
    render(<JobDetailClient id="j1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this job.");
  });
});
```

In `apps/web/src/app/page.test.tsx`, extend the first test's expectations (the order is the user journey) — change the `toEqual` line and add two assertions:

```tsx
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/profile", "/career-goal", "/sources", "/jobs"]);
    // ...existing two assertions unchanged, then:
    expect(screen.getByRole("link", { name: /job sources/i })).toHaveAttribute("href", "/sources");
    expect(screen.getByRole("link", { name: /browse what was ingested/i })).toHaveAttribute("href", "/jobs");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test -- jobs page.test`
Expected: FAIL — components not found; the home test fails on the two new links.

- [ ] **Step 3: Write the implementation**

Honesty rules the tests pin down: a missing posted date reads "First seen … (no posted date)" (the source did not say when it was posted); unknown work mode / sponsorship / salary read "not stated"; each extracted fact on the detail page sits next to the text it was read from; **posting URLs are third-party data, so only `http(s)` links are rendered** (`safeHttpUrl`); possible duplicates are read-only and labelled as not merged. The percentage on a duplicate is a *title match* (seniority words are stripped from the comparison key by design), so it is labelled that way.

`apps/web/src/app/jobs/page.tsx`:

```ts
import { JobsClient } from "./JobsClient";

export default function JobsPage() {
  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">Jobs</h1>
      <p className="mb-6 text-sm text-gray-600">
        Everything ingested from your sources, newest first. Ranking and matching against your career goal come in a later phase.
      </p>
      <JobsClient />
    </main>
  );
}
```

`apps/web/src/app/jobs/JobsClient.tsx`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { JobListItem } from "../../lib/jobs/listJobs";
import { formatPosted, formatSalary, formatSponsorship, formatWorkMode } from "../../lib/jobs/format";

type Status = "open" | "closed" | "all";
interface Result {
  jobs: JobListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export function JobsClient() {
  const [draftQuery, setDraftQuery] = useState("");
  const [draftStatus, setDraftStatus] = useState<Status>("open");
  const [applied, setApplied] = useState<{ q: string; status: Status }>({ q: "", status: "open" });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Result | null>(null);
  const [failed, setFailed] = useState(false);

  // A promise chain, not async/await: see the note in SourcesClient (react-hooks/set-state-in-effect).
  const load = useCallback(() => {
    const params = new URLSearchParams({ status: applied.status, page: String(page) });
    if (applied.q) params.set("q", applied.q);
    return fetch(`/api/jobs?${params.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((body: Result) => {
        setResult(body);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [applied, page]);

  useEffect(() => {
    void load();
  }, [load]);

  function search() {
    setPage(1);
    setApplied({ q: draftQuery.trim(), status: draftStatus });
  }

  const from = result && result.total > 0 ? (result.page - 1) * result.pageSize + 1 : 0;
  const to = result ? Math.min(result.page * result.pageSize, result.total) : 0;

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="job-search" className="text-sm">Title or company</label>
          <input id="job-search" value={draftQuery} onChange={(e) => setDraftQuery(e.target.value)} className="rounded border px-2 py-1" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="job-status" className="text-sm">Show</label>
          <select id="job-status" value={draftStatus} onChange={(e) => setDraftStatus(e.target.value as Status)} className="rounded border px-2 py-1">
            <option value="open">Open jobs</option>
            <option value="closed">Closed jobs</option>
            <option value="all">All jobs</option>
          </select>
        </div>
        <button type="submit" className="rounded bg-black px-4 py-1.5 text-white">Search</button>
      </form>

      {failed && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-sm text-red-600">Could not load jobs — check your connection and try again.</p>
          <button type="button" onClick={() => void load()} className="w-fit rounded border px-4 py-2 text-sm">Retry</button>
        </div>
      )}
      {result === null && !failed && <p>Loading...</p>}

      {result !== null && result.total === 0 && (
        <p className="text-sm text-gray-600">
          No jobs match. <Link href="/sources" className="underline">Add a source and run it</Link>, or change the filters.
        </p>
      )}

      {result !== null && result.total > 0 && (
        <>
          <p className="text-sm text-gray-600">Showing {from}–{to} of {result.total}</p>
          <ul className="flex flex-col gap-3" aria-label="Jobs">
            {result.jobs.map((job) => (
              <li key={job.id} className="flex flex-col gap-1 rounded border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link href={`/jobs/${job.id}`} className="font-medium underline">{job.title}</Link>
                  {job.status === "closed" && <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">Closed</span>}
                </div>
                <p className="text-sm">{job.companyName}{job.locationRaw ? ` · ${job.locationRaw}` : ""} · {formatWorkMode(job.workMode)}</p>
                <p className="text-sm">
                  {formatSalary(job.salary)} · {formatSponsorship(job.sponsorship)}
                  {job.minExperienceYears !== null ? ` · ${job.minExperienceYears}+ years experience` : ""}
                </p>
                <p className="text-xs text-gray-500">{formatPosted(job)}</p>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button type="button" disabled={result.page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border px-3 py-1 text-sm disabled:opacity-50">Previous</button>
            <button type="button" disabled={to >= result.total} onClick={() => setPage((p) => p + 1)} className="rounded border px-3 py-1 text-sm disabled:opacity-50">Next</button>
          </div>
        </>
      )}
    </div>
  );
}
```

`apps/web/src/app/jobs/[id]/page.tsx`:

```ts
import { JobDetailClient } from "./JobDetailClient";

// Next 16: dynamic route params arrive as a Promise.
export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-3xl p-8">
      <JobDetailClient id={id} />
    </main>
  );
}
```

`apps/web/src/app/jobs/[id]/JobDetailClient.tsx`:

```ts
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { JobDetail } from "../../../lib/jobs/getJobDetail";
import { formatDate, formatPosted, formatSalary, formatSponsorship, formatWorkMode, safeHttpUrl } from "../../../lib/jobs/format";

type State = { kind: "loading" } | { kind: "missing" } | { kind: "error" } | { kind: "ready"; job: JobDetail };

export function JobDetailClient({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${id}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) setState({ kind: "missing" });
        else if (!res.ok) setState({ kind: "error" });
        else setState({ kind: "ready", job: (await res.json()).job });
      })
      .catch(() => !cancelled && setState({ kind: "error" }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const back = <Link href="/jobs" className="text-sm underline">← All jobs</Link>;

  if (state.kind === "loading") return <p>Loading...</p>;
  if (state.kind === "missing") return <div className="flex flex-col gap-3"><p>Job not found.</p>{back}</div>;
  if (state.kind === "error") return <div className="flex flex-col gap-3"><p role="alert" className="text-red-600">Could not load this job.</p>{back}</div>;

  const job = state.job;
  const rawDiffers = job.salary.isParsed && job.salary.raw;

  return (
    <div className="flex flex-col gap-6">
      {back}
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{job.title}</h1>
        <p className="text-sm text-gray-600">
          {job.companyName}{job.locationRaw ? ` · ${job.locationRaw}` : ""}
          {job.status === "closed" ? " · Closed" : ""}
        </p>
      </header>

      <section aria-labelledby="facts-heading">
        <h2 id="facts-heading" className="mb-2 font-medium">What we read from the posting</h2>
        <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-gray-600">Salary</dt>
          <dd>
            {formatSalary(job.salary)}
            {rawDiffers && <div className="text-xs text-gray-500">Source text: “{job.salary.raw}”</div>}
          </dd>
          <dt className="text-gray-600">Work mode</dt>
          <dd>{formatWorkMode(job.workMode)}</dd>
          <dt className="text-gray-600">Minimum experience</dt>
          <dd>
            {job.minExperienceYears !== null ? `${job.minExperienceYears}+ years` : "Not stated"}
            {job.minExperienceEvidence && <div className="text-xs text-gray-500">“{job.minExperienceEvidence}”</div>}
          </dd>
          <dt className="text-gray-600">Visa sponsorship</dt>
          <dd>
            {formatSponsorship(job.sponsorship)}
            {job.sponsorshipConflict && <div className="text-xs text-amber-700">The posting contains conflicting statements — read it before relying on this.</div>}
            {job.sponsorshipEvidence && <div className="text-xs text-gray-500">“{job.sponsorshipEvidence}”</div>}
          </dd>
          <dt className="text-gray-600">Posted</dt>
          <dd>{formatPosted(job)}</dd>
          <dt className="text-gray-600">Last seen open</dt>
          <dd>{formatDate(job.lastVerifiedAt)}</dd>
          {job.employmentType && (<><dt className="text-gray-600">Employment type</dt><dd>{job.employmentType}</dd></>)}
        </dl>
      </section>

      <section aria-labelledby="postings-heading">
        <h2 id="postings-heading" className="mb-2 font-medium">Where it was found</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {job.postings.map((posting) => {
            const href = safeHttpUrl(posting.url);
            return (
              <li key={posting.id}>
                {posting.sourceLabel} ({posting.sourceKind}) · {posting.status === "open" ? "open" : "closed"} · last seen {formatDate(posting.lastSeenAt)}
                {href && <> · <a href={href} target="_blank" rel="noopener noreferrer" className="underline">View posting</a></>}
              </li>
            );
          })}
        </ul>
      </section>

      {job.duplicateCandidates.length > 0 && (
        <section aria-labelledby="duplicates-heading">
          <h2 id="duplicates-heading" className="mb-1 font-medium">Possible duplicates</h2>
          <p className="mb-2 text-xs text-gray-500">These look similar but were not merged automatically. Judge for yourself.</p>
          <ul className="flex flex-col gap-1 text-sm">
            {job.duplicateCandidates.map((candidate) => (
              <li key={candidate.jobId}>
                <Link href={`/jobs/${candidate.jobId}`} className="underline">{candidate.title}</Link>
                {` · ${candidate.companyName}${candidate.locationRaw ? ` · ${candidate.locationRaw}` : ""} · ${Math.round(candidate.similarity * 100)}% title match`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="description-heading">
        <h2 id="description-heading" className="mb-2 font-medium">Description</h2>
        <pre className="whitespace-pre-wrap text-sm">{job.descriptionText || "No description."}</pre>
      </section>
    </div>
  );
}
```

In `apps/web/src/app/page.tsx`, add these two links to the `<nav>` after the existing career-goal link:

```tsx
        <Link href="/sources" className="underline">
          3. Job sources — add the company boards you want to follow
        </Link>
        <Link href="/jobs" className="underline">
          4. Jobs — browse what was ingested
        </Link>
```

- [ ] **Step 4: Run tests, build and typecheck**

Run: `pnpm --filter web test && pnpm --filter web lint && pnpm --filter web build && pnpm --filter web typecheck`
Expected: PASS; `next build` lists `/sources`, `/jobs`, `/jobs/[id]` and every new `/api/job-sources*` and `/api/jobs*` route (`next build` also type-checks the test files).

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "feat(web): add Jobs browser and link the journey from home"`

---

### Task 18: Extraction evaluation set

CLAUDE.md §10 asks for evaluation datasets for extraction. The extractors are deterministic, so "evaluation" is a labeled set with precision/recall per field that must stay at 100%; it exists to make a regression visible as a number, and to grow whenever a real posting is mis-read. (It caught a real bug while this plan was being validated: `preferably` *after* the years wrongly made a hard requirement optional, and recall on experience was 80%.)

**Files:**
- Create: `packages/ingestion/eval/cases.ts`, `packages/ingestion/eval/score.ts`, `packages/ingestion/eval/scoreExtraction.ts`
- Test: `packages/ingestion/eval/extractionEval.test.ts`
- Modify: `packages/ingestion/package.json` (scripts)

**Interfaces:**
- Consumes: `extractSalary`, `extractMinExperience`, `extractSponsorship` (Tasks 3–4).
- Produces: `CASES: EvalCase[]`, `scoreExtraction(cases): FieldScore[]`, and `pnpm --filter @ai-career/ingestion eval:extraction`.

- [ ] **Step 1: Write the failing test**

`packages/ingestion/eval/extractionEval.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CASES } from "./cases";
import { scoreExtraction } from "./score";

describe("extraction eval set", () => {
  it("is large enough that a regression cannot hide (guards against the set shrinking)", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    const byField = Object.fromEntries(scoreExtraction(CASES).map((s) => [s.field, s.cases]));
    expect(byField.salary).toBeGreaterThanOrEqual(15);
    expect(byField.minExperience).toBeGreaterThanOrEqual(7);
    expect(byField.sponsorship).toBeGreaterThanOrEqual(10);
  });

  it("scores 100% precision and 100% recall on every field (the rules are deterministic, so any drop is a regression)", () => {
    for (const s of scoreExtraction(CASES)) {
      expect(s.precision, `${s.field} precision`).toBe(1);
      expect(s.recall, `${s.field} recall`).toBe(1);
    }
  });

  it("is consistent: scoring twice gives identical results (no hidden state in the extractors' global regexes)", () => {
    expect(scoreExtraction(CASES)).toEqual(scoreExtraction(CASES));
  });

  it("would notice a wrong answer (the scorer itself is not vacuous)", () => {
    const wrong = scoreExtraction([
      { name: "wrong", text: "The salary is $100,000 per year.", salary: { min: 1, max: 2, currency: "USD", period: "year" } },
      { name: "spurious", text: "The salary is $100,000 per year.", salary: null },
      { name: "missed", text: "nothing here", salary: { min: 1, max: 2, currency: "USD", period: "year" } },
    ]).find((s) => s.field === "salary")!;
    expect(wrong).toMatchObject({ tp: 0, fp: 2, fn: 2, tn: 0, precision: 0, recall: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai-career/ingestion test -- eval`
Expected: FAIL — `./cases` and `./score` not found.

- [ ] **Step 3: Write the implementation**

`packages/ingestion/eval/cases.ts`:

```ts
import type { SponsorshipValue } from "../src/types";

/**
 * A hand-labeled evaluation set for the deterministic extractors (CLAUDE.md §10). Each case is a short
 * excerpt in the exact shape of a real posting (formats observed in ~1,430 live Greenhouse/Lever
 * postings on 2026-09-21; wording trimmed). `undefined` means "this case does not test that field";
 * `null` means "the correct answer is: nothing to extract".
 *
 * ADD A CASE whenever a real posting is mis-read, before fixing the rule.
 */
export interface EvalCase {
  name: string;
  text: string;
  salary?: { min: number; max: number; currency: string; period: "year" | "month" | "hour" } | null;
  minExperience?: number | null;
  sponsorship?: SponsorshipValue;
}

const usd = (min: number, max: number) => ({ min, max, currency: "USD", period: "year" as const });

export const CASES: EvalCase[] = [
  // ---- salary: formats that must parse ----
  { name: "salary: plain annual range", text: "The base salary range for this role is $150,000 - $200,000 per year.", salary: usd(150000, 200000) },
  { name: "salary: monthly MXN, trailing code overrides the $ (Airbnb Mexico)", text: "Mexico Monthly Pay Range\n$43,500 — $48,333 MXN", salary: { min: 522000, max: 579996, currency: "MXN", period: "month" } },
  { name: "salary: R$ is BRL, dot thousands (Airbnb Brazil)", text: "Brazil Monthly Pay Range\nR$14.000 — R$17.500 BRL", salary: { min: 168000, max: 210000, currency: "BRL", period: "month" } },
  { name: "salary: European dot thousands", text: "The annual salary range is €71.000 — €84.000 EUR", salary: { min: 71000, max: 84000, currency: "EUR", period: "year" } },
  { name: "salary: repeated trailing code", text: "The salary range is 296,000 PLN — 350,000 PLN per year", salary: { min: 296000, max: 350000, currency: "PLN", period: "year" } },
  { name: "salary: no separator between amounts (Spotify)", text: "The United States base range for this position is $184,050 $262,928 plus equity.", salary: usd(184050, 262928) },
  { name: "salary: per-unit suffix between amounts (Palantir)", text: "The salary range for this position is estimated to be $28/hour to $47/hour.", salary: { min: 58240, max: 97760, currency: "USD", period: "hour" } },
  { name: "salary: k suffix, period inferred from magnitude", text: "Compensation: $120k - $150k", salary: usd(120000, 150000) },
  { name: "salary: explicit CAD", text: "Pay Range\n$83,000 — $98,000 CAD", salary: { min: 83000, max: 98000, currency: "CAD", period: "year" } },
  { name: "salary: GBP with repeated trailing code", text: "Pay Range\n£46,000 — £54,000 GBP", salary: { min: 46000, max: 54000, currency: "GBP", period: "year" } },
  // ---- salary: things that must NOT parse ----
  { name: "no salary: market-size figures (Stripe)", text: "Businesses processing $20M–$50M in annual payment volume. We are attacking a $100B market and moved $1.4T in annual volume.", salary: null },
  { name: "no salary: bonus and equity amounts", text: "This role is also eligible for a signing bonus of $10,000 and equity.", salary: null },
  { name: "no salary: a benefit, not pay", text: "We offer a $500 learning stipend and free lunch.", salary: null },
  { name: "no salary: conflicting regional ranges are left unparsed", text: "US: the base salary range is $150,000 - $200,000. UK: the base salary range is £100,000 - £130,000.", salary: null },
  { name: "no salary: nothing stated", text: "We are hiring a data engineer to build pipelines.", salary: null },
  // ---- minimum experience ----
  { name: "experience: N+ years of experience", text: "Requirements\n- 5+ years of experience in software engineering", minExperience: 5 },
  { name: "experience: words between years and experience", text: "8+ years of sales experience, preferably in a technical product", minExperience: 8 },
  { name: "experience: range takes the lower bound", text: "2-4 years of experience with SQL", minExperience: 2 },
  { name: "experience: nice-to-have line ignored", text: "- 6+ years of experience in sales\n- 2+ years of hospitality experience (nice to have)", minExperience: 6 },
  { name: "experience: company boast ignored", text: "We have over 15 years of experience serving customers.", minExperience: null },
  { name: "experience: no space before 'years'", text: "Minimum 2years post-qualification experience", minExperience: 2 },
  { name: "experience: years in business is not experience", text: "We have been in business for 10 years.", minExperience: null },
  // ---- sponsorship ----
  { name: "sponsorship: not available (real)", text: "Proficiency in Mandarin is required. Visa sponsorship is not available. Location: fully remote.", sponsorship: "not_offered" },
  { name: "sponsorship: unable to offer", text: "We are unable to offer visa sponsorship for this role.", sponsorship: "not_offered" },
  { name: "sponsorship: right to work (real)", text: "Candidates must have the right to work in Ireland by the start date.", sponsorship: "not_offered" },
  { name: "sponsorship: available", text: "Visa sponsorship is available for this position.", sponsorship: "offered" },
  { name: "sponsorship: can sponsor", text: "We can sponsor your visa and help you relocate.", sponsorship: "offered" },
  { name: "sponsorship: event sponsorship is unrelated (real Stripe)", text: "activating Stripe's global sponsorship portfolio to deliver premium experiences", sponsorship: "unknown" },
  { name: "sponsorship: executive sponsor is unrelated (real Stripe)", text: "serving as executive sponsor with key relationships", sponsorship: "unknown" },
  { name: "sponsorship: financial sponsor is unrelated (real Stripe)", text: "Represent Stripe in the financial sponsor ecosystem", sponsorship: "unknown" },
  { name: "sponsorship: contradictory statements stay unknown", text: "Visa sponsorship is available for some roles. We do not sponsor visas for contractors.", sponsorship: "unknown" },
  { name: "sponsorship: silent", text: "Build data pipelines.", sponsorship: "unknown" },
];
```

`packages/ingestion/eval/score.ts`:

```ts
import { extractMinExperience } from "../src/normalize/experience";
import { extractSalary } from "../src/normalize/salary";
import { extractSponsorship } from "../src/normalize/sponsorship";
import type { EvalCase } from "./cases";

export interface FieldScore {
  field: "salary" | "minExperience" | "sponsorship";
  cases: number;
  /** correct extractions */ tp: number;
  /** wrong or spurious extractions */ fp: number;
  /** missed or wrong extractions */ fn: number;
  /** correctly extracted nothing */ tn: number;
  precision: number;
  recall: number;
}

interface Tally {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** expected/predicted use `null` for "nothing extracted". Wrong values count as BOTH a false positive and a false negative. */
function tally<T>(t: Tally, expected: T | null, predicted: T | null, equal: (a: T, b: T) => boolean): void {
  if (expected === null) {
    if (predicted === null) t.tn++;
    else t.fp++;
  } else if (predicted === null) {
    t.fn++;
  } else if (equal(expected, predicted)) {
    t.tp++;
  } else {
    t.fp++;
    t.fn++;
  }
}

const finish = (field: FieldScore["field"], cases: number, t: Tally): FieldScore => ({
  field,
  cases,
  ...t,
  precision: t.tp + t.fp === 0 ? 1 : t.tp / (t.tp + t.fp),
  recall: t.tp + t.fn === 0 ? 1 : t.tp / (t.tp + t.fn),
});

export function scoreExtraction(cases: EvalCase[]): FieldScore[] {
  const salary: Tally = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const experience: Tally = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const sponsorship: Tally = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const counts = { salary: 0, minExperience: 0, sponsorship: 0 };

  for (const c of cases) {
    if (c.salary !== undefined) {
      counts.salary++;
      const s = extractSalary(c.text);
      const predicted = s.isParsed ? { min: s.min!, max: s.max!, currency: s.currency!, period: s.period! } : null;
      tally(salary, c.salary, predicted, (a, b) => a.min === b.min && a.max === b.max && a.currency === b.currency && a.period === b.period);
    }
    if (c.minExperience !== undefined) {
      counts.minExperience++;
      tally(experience, c.minExperience, extractMinExperience(c.text).years, (a, b) => a === b);
    }
    if (c.sponsorship !== undefined) {
      counts.sponsorship++;
      const value = extractSponsorship(c.text).value;
      tally(sponsorship, c.sponsorship === "unknown" ? null : c.sponsorship, value === "unknown" ? null : value, (a, b) => a === b);
    }
  }
  return [
    finish("salary", counts.salary, salary),
    finish("minExperience", counts.minExperience, experience),
    finish("sponsorship", counts.sponsorship, sponsorship),
  ];
}
```

`packages/ingestion/eval/scoreExtraction.ts`:

```ts
// Prints precision/recall per extracted field over the labeled set.  Run: pnpm --filter @ai-career/ingestion eval:extraction
import { CASES } from "./cases";
import { scoreExtraction } from "./score";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const scores = scoreExtraction(CASES);

console.log(`Extraction eval — ${CASES.length} labeled cases\n`);
console.log("field          cases   tp   fp   fn   tn   precision   recall");
for (const s of scores) {
  console.log(
    `${s.field.padEnd(14)} ${String(s.cases).padStart(5)} ${String(s.tp).padStart(4)} ${String(s.fp).padStart(4)} ${String(s.fn).padStart(4)} ${String(s.tn).padStart(4)}   ${pct(s.precision).padStart(9)}   ${pct(s.recall).padStart(6)}`
  );
}
process.exit(scores.every((s) => s.precision === 1 && s.recall === 1) ? 0 : 1);
```

In `packages/ingestion/package.json`, set the `lint` script to `eslint src eval` and add `"eval:extraction": "tsx eval/scoreExtraction.ts"` to `scripts` (the tsconfig already includes `eval`).

- [ ] **Step 4: Run to verify**

Run: `pnpm --filter @ai-career/ingestion test && pnpm --filter @ai-career/ingestion lint && pnpm --filter @ai-career/ingestion eval:extraction`
Expected: tests PASS; the script prints a table and exits 0:

```
field          cases   tp   fp   fn   tn   precision   recall
salary            15   10    0    0    5      100.0%   100.0%
minExperience      7    5    0    0    2      100.0%   100.0%
sponsorship       10    5    0    0    5      100.0%   100.0%
```

- [ ] **Step 5: Checkpoint**

`git status --short`. If authorized: `git commit -m "test(ingestion): add labeled extraction evaluation set with precision/recall"`

---

### Task 19: Fake ATS, end-to-end smoke test and real-browser check

Unit and integration tests cannot show that the web app, the queue, the worker and the database cooperate. This task adds a fake Greenhouse/Lever server and a smoke script that drives the *running* system over HTTP, then a manual browser pass.

**Files:**
- Create: `services/job-ingestion/e2e/fakeAts.ts`, `services/job-ingestion/e2e/smoke.ts`
- Modify: `services/job-ingestion/package.json` (scripts)

**Interfaces:**
- Consumes: everything above; env `GREENHOUSE_API_BASE` / `LEVER_API_BASE` (Task 6) pointing the worker at the fake.
- Produces: `pnpm --filter @ai-career/job-ingestion e2e:fake-ats` (port 4011, board `fakeco` on both APIs) and `e2e:smoke`.

- [ ] **Step 1: Write the fake ATS and the smoke script**

The fake mirrors the real field names and shapes (including entity-escaped Greenhouse `content` and Lever's `{ok:false}` 404), and contains: a job on both boards (cross-source dedup), a same-title different-description job (a flagged duplicate), a market-size-only posting (must not become a salary), a monthly MXN range, a Lever requirements list, and an admin route to drop a job so closing can be exercised.

`services/job-ingestion/e2e/fakeAts.ts`:

```ts
// A tiny fake Greenhouse + Lever for local end-to-end runs. Field names and shapes match the real
// APIs (verified 2026-09-21); job text is synthetic. Point the worker at it with
//   GREENHOUSE_API_BASE=http://localhost:4011 LEVER_API_BASE=http://localhost:4011
// Both boards are called "fakeco".
//   POST /__admin/drop/<greenhouse job id>   removes a job (to exercise closing)
//   POST /__admin/reset                      restores the original board
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_ATS_PORT ?? 4011);

const escape = (html: string) =>
  html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

interface GhJob { id: number; title: string; location: string; html: string; first_published: string }
const GREENHOUSE_ORIGINAL: GhJob[] = [
  {
    id: 1001, title: "Senior Data Engineer", location: "Berlin", first_published: "2026-08-01T09:00:00-04:00",
    html:
      "<p>Build the data platform.</p><ul><li>5+ years of experience with SQL</li>" +
      "<li>2+ years of experience with dbt (nice to have)</li></ul>" +
      "<p>The base salary range is €70,000 - €90,000 per year. Visa sponsorship is available.</p>",
  },
  {
    id: 1002, title: "Product Designer", location: "Remote, United States", first_published: "2026-09-01T09:00:00-04:00",
    html:
      "<p>We are attacking a $100B market opportunity and processed $1.4T in annual volume.</p>" +
      "<p>We cannot sponsor work visas at this time.</p>",
  },
  {
    id: 1003, title: "Security Analyst", location: "Mexico City", first_published: "2026-09-05T09:00:00-04:00",
    html: "<p>Protect our systems.</p><p>Mexico Monthly Pay Range<br>$43,500 — $48,333 MXN</p>",
  },
  { id: 1004, title: "Data Engineer", location: "Berlin", first_published: "2026-09-10T09:00:00-04:00", html: "<p>Shared description text.</p>" },
  { id: 1005, title: "Office Chef", location: "Paris", first_published: "2026-09-12T09:00:00-04:00", html: "<p>Feed the team.</p>" },
];

const LEVER = [
  {
    id: "lv-0001", text: "Data Engineer", hostedUrl: "https://jobs.lever.co/fakeco/lv-0001", createdAt: Date.UTC(2026, 8, 11),
    country: "DE", workplaceType: "onsite", categories: { commitment: "Permanent", location: "Berlin", allLocations: ["Berlin"] },
    descriptionPlain: "Shared description text.", lists: [], additionalPlain: "",
  },
  {
    id: "lv-0002", text: "Site Reliability Engineer", hostedUrl: "https://jobs.lever.co/fakeco/lv-0002", createdAt: Date.UTC(2026, 8, 13),
    country: "GB", workplaceType: "hybrid", categories: { commitment: "Permanent", location: "London", allLocations: ["London"] },
    descriptionPlain: "Keep the lights on.",
    lists: [{ text: "Who You Are", content: "<li>3+ years of experience with Kubernetes</li>" }],
    additionalPlain: "The salary range is £60,000 - £80,000 per year.",
  },
  {
    id: "lv-0003", text: "Staff Data Engineer", hostedUrl: "https://jobs.lever.co/fakeco/lv-0003", createdAt: Date.UTC(2026, 8, 14),
    country: "DE", workplaceType: "unspecified", categories: { commitment: "Permanent", location: "Berlin", allLocations: ["Berlin"] },
    descriptionPlain: "A different description.", lists: [], additionalPlain: "",
  },
];

let greenhouse = [...GREENHOUSE_ORIGINAL];

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/v1/boards/fakeco/jobs") {
    return json(res, 200, {
      jobs: greenhouse.map((j) => ({
        id: j.id, internal_job_id: j.id + 5000000, title: j.title, company_name: "FakeCo",
        absolute_url: `https://boards.greenhouse.io/fakeco/jobs/${j.id}`, location: { name: j.location },
        first_published: j.first_published, updated_at: "2026-09-20T10:00:00-04:00", language: "en", content: escape(j.html),
      })),
      meta: { total: greenhouse.length },
    });
  }
  if (req.method === "GET" && path === "/v0/postings/fakeco") return json(res, 200, LEVER);

  if (req.method === "POST" && path.startsWith("/__admin/drop/")) {
    const id = Number(path.split("/").pop());
    greenhouse = greenhouse.filter((j) => j.id !== id);
    return json(res, 200, { remaining: greenhouse.length });
  }
  if (req.method === "POST" && path === "/__admin/reset") {
    greenhouse = [...GREENHOUSE_ORIGINAL];
    return json(res, 200, { remaining: greenhouse.length });
  }
  // Mirror the real 404 bodies.
  if (path.startsWith("/v0/postings/")) return json(res, 404, { ok: false, error: "Document not found" });
  return json(res, 404, {});
}).listen(PORT, () => console.log(`fake ATS listening on http://localhost:${PORT} (boards: fakeco)`));
```

`services/job-ingestion/e2e/smoke.ts`:

```ts
// End-to-end smoke test over real HTTP, the real queue and the real worker.
// Prerequisites (three terminals, see the plan's Task 19):
//   1. fake ATS:  pnpm --filter @ai-career/job-ingestion e2e:fake-ats
//   2. worker:    GREENHOUSE_API_BASE=http://localhost:4011 LEVER_API_BASE=http://localhost:4011 pnpm --filter @ai-career/job-ingestion start
//   3. web:       pnpm --filter web start     (after `pnpm --filter web build`)
// Then: pnpm --filter @ai-career/job-ingestion e2e:smoke
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const ATS = process.env.FAKE_ATS_URL ?? "http://localhost:4011";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : detail ? `  -> ${detail}` : ""}`);
  if (!ok) failures++;
}
const call = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${WEB}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = (path: string, body?: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const patch = (path: string, body: unknown) =>
  call(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

interface Source { id: string; kind: string; lastRunStatus: string | null; lastRun: { fetched: number; created: number; closed: number } | null }
async function sources(): Promise<Source[]> {
  return (await call("/api/job-sources")).body.sources;
}
async function waitForRun(id: string, previousRunAt: string | null): Promise<Source> {
  for (let i = 0; i < 60; i++) {
    const s = (await sources()).find((x) => x.id === id) as (Source & { lastRunAt: string | null }) | undefined;
    if (s && s.lastRunAt && s.lastRunAt !== previousRunAt && s.lastRunStatus !== "running") return s;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for the run to finish (is the worker running?)");
}
async function ensureSource(kind: "greenhouse" | "lever"): Promise<string> {
  const created = await post("/api/job-sources", { kind, slug: "fakeco", companyName: "FakeCo" });
  if (created.status === 201) return created.body.source.id;
  const existing = (await sources()).find((s) => s.kind === kind);
  if (!existing) throw new Error(`could not create or find the ${kind} source`);
  return existing.id;
}
async function runAndWait(id: string) {
  const before = ((await sources()).find((s) => s.id === id) as { lastRunAt?: string | null }).lastRunAt ?? null;
  const queued = await post(`/api/job-sources/${id}/run`);
  if (queued.status !== 202) throw new Error(`run was not queued: ${queued.status}`);
  return waitForRun(id, before);
}

async function main() {
  await fetch(`${ATS}/__admin/reset`, { method: "POST" });
  const gh = await ensureSource("greenhouse");
  const lv = await ensureSource("lever");

  const refused = await post(`/api/job-sources/${gh}/run`);
  check("a source cannot run before it is enabled and consented (D3)", refused.status === 409);
  const noConsent = await patch(`/api/job-sources/${gh}`, { enabled: true });
  check("enabling without the Terms-of-Service confirmation is refused", noConsent.status === 400);

  for (const id of [gh, lv]) await patch(`/api/job-sources/${id}`, { enabled: true, consentConfirmed: true });
  const ghRun = await runAndWait(gh);
  const lvRun = await runAndWait(lv);
  check("greenhouse run fetched 5 and created 5", ghRun.lastRunStatus === "succeeded" && ghRun.lastRun?.fetched === 5 && ghRun.lastRun.created === 5, JSON.stringify(ghRun.lastRun));
  check("lever run fetched 3 and created 3 (one of them links to an existing job)", lvRun.lastRunStatus === "succeeded" && lvRun.lastRun?.fetched === 3, JSON.stringify(lvRun.lastRun));

  const list = (await call("/api/jobs?status=all")).body;
  const byTitle = (t: string) => list.jobs.find((j: { title: string }) => j.title === t);
  check("7 canonical jobs (8 postings, one cross-source duplicate merged)", list.total === 7, `total=${list.total}`);

  const senior = byTitle("Senior Data Engineer");
  check("salary parsed from text: EUR 70,000-90,000 / year", senior?.salary.isParsed && senior.salary.min === 70000 && senior.salary.max === 90000 && senior.salary.currency === "EUR", JSON.stringify(senior?.salary));
  check("nice-to-have experience ignored: minimum is 5 years", senior?.minExperienceYears === 5);
  check("sponsorship offered", senior?.sponsorship === "offered");
  check("posted date comes from first_published", senior?.postedAt?.startsWith("2026-08-01"), senior?.postedAt);

  const designer = byTitle("Product Designer");
  check("market-size figures ($100B, $1.4T) are not read as a salary", designer && !designer.salary.isParsed && designer.salary.raw === null, JSON.stringify(designer?.salary));
  check("'cannot sponsor work visas' -> not_offered", designer?.sponsorship === "not_offered");

  const analyst = byTitle("Security Analyst");
  check("MXN monthly pay annualized and kept in pesos", analyst?.salary.currency === "MXN" && analyst.salary.period === "month" && analyst.salary.min === 43500 * 12, JSON.stringify(analyst?.salary));

  const sre = byTitle("Site Reliability Engineer");
  check("lever list text is read (3+ years) and its salary parsed in GBP", sre?.minExperienceYears === 3 && sre.salary.currency === "GBP" && sre.workMode === "hybrid", JSON.stringify(sre));

  const merged = (await call(`/api/jobs/${byTitle("Data Engineer").id}`)).body.job;
  check("the same job on both boards is ONE job with two postings", merged.postings.length === 2, `postings=${merged.postings.length}`);
  check("the near-duplicate 'Staff Data Engineer' is flagged, not merged", merged.duplicateCandidates.some((d: { title: string }) => d.title === "Staff Data Engineer"), JSON.stringify(merged.duplicateCandidates));

  await fetch(`${ATS}/__admin/drop/1005`, { method: "POST" });
  const second = await runAndWait(gh);
  check("a job removed from a complete fetch is closed", second.lastRun?.closed === 1, JSON.stringify(second.lastRun));
  const closed = (await call("/api/jobs?status=closed")).body;
  check("it appears under closed jobs, and open jobs drop to 6", closed.total === 1 && closed.jobs[0].title === "Office Chef" && (await call("/api/jobs")).body.total === 6);

  const form = new FormData();
  form.set("file", new File(["title,company,location\nWarehouse Lead,Beta,Leeds\nWarehouse Lead,Beta,Leeds"], "beta.csv"));
  form.set("consentConfirmed", "true");
  const up = await call("/api/job-sources/upload", { method: "POST", body: form });
  check("an uploaded CSV is stored (duplicate row dropped) and queued", up.status === 201 && up.body.count === 1 && up.body.queued === true, JSON.stringify(up.body));

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("smoke test crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
```

In `services/job-ingestion/package.json`, set `"lint": "eslint src e2e"` and add to `scripts`:

```json
    "e2e:fake-ats": "tsx e2e/fakeAts.ts",
    "e2e:smoke": "tsx e2e/smoke.ts"
```

- [ ] **Step 2: Run the whole system**

The database must be migrated (Task 8, Step 5) and `.env` present. Use a clean slate for the default user (`DELETE FROM jobs; DELETE FROM job_sources;` for `00000000-0000-0000-0000-000000000001` in the *dev* database, or point `DATABASE_URL` at a scratch database). In four terminals from the repo root:

```bash
pnpm --filter @ai-career/job-ingestion e2e:fake-ats
GREENHOUSE_API_BASE=http://localhost:4011 LEVER_API_BASE=http://localhost:4011 pnpm --filter @ai-career/job-ingestion start
pnpm --filter web build && pnpm --filter web exec dotenv -e ../../.env -- next start -p 3100
WEB_URL=http://localhost:3100 pnpm --filter @ai-career/job-ingestion e2e:smoke
```

Expected: every line `PASS`, ending `All checks passed.` (18 checks: the D3 gates, 5 + 3 records ingested, 7 canonical jobs from 8 postings, salary/experience/sponsorship/date extraction incl. the market-size and monthly-MXN cases, the flagged near-duplicate, closing on removal, and an upload). If a check fails, the message names it; fix the cause, do not loosen the check.

- [ ] **Step 3: Look at it in a real browser**

Open `http://localhost:3100/sources`, `/jobs` and a job's detail page (Chrome, or drive it with `playwright-core` pointed at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, installed outside the repo). Confirm by eye: the sources list shows last-run counts and a "closed" count on the Greenhouse board; jobs show `MXN 522,000–579,996 / year (annualized from monthly pay)`, "Not stated" where a posting gave no salary, and "First seen … (no posted date)" for the uploaded row; the merged "Data Engineer" lists two postings and two possible duplicates worded "… % title match"; no browser console errors; an unconfirmed source's **Enable** button stays disabled until its Terms checkbox is ticked. Stop the four processes afterwards.

- [ ] **Step 4: Checkpoint**

`git status --short`. If authorized: `git commit -m "test(job-ingestion): add fake ATS and end-to-end smoke test"`

---

### Task 20: CI, documentation, final verification and hand-over

**Files:**
- Modify: `.github/workflows/ci.yml`, `DECISIONS.md`, `FLOW.md`, `docs/architecture.md`, `README.md`, `docs/superpowers/specs/2026-09-21-phase-4-job-intelligence-design.md`

- [ ] **Step 1: CI applies migrations once before the tests**

In `.github/workflows/ci.yml`, add this step immediately after `Write .env for dotenv-cli-wrapped scripts` and before `- run: pnpm lint`:

```yaml
      - name: Apply migrations to the test database once, before any test runs
        # Every suite calls drizzle's migrate() in its own beforeAll, and turbo runs the packages'
        # suites in parallel against this one database. Two simultaneous migrate() calls on an EMPTY
        # database collide creating the same enum ("duplicate key ... pg_type_typname_nsp_index").
        # Migrating here first makes every suite's own migrate() a no-op.
        run: pnpm --filter @ai-career/db db:migrate
```

`MIGRATIONS_DATABASE_URL` in this workflow already points at `career_intel_test`. (The Redis service the worker tests need is already declared.)

- [ ] **Step 2: DECISIONS.md**

Append these entries (before the closing "Entries are appended chronologically" note), dated `2026-09-21 — Phase 4 (Job Intelligence)`:

```markdown
### D31. Job sources: Greenhouse + Lever + file upload; Apify, Ashby and RSS deferred
**Decision:** Phase 4 ships three adapters behind one `SourceAdapter` interface: Greenhouse and Lever public board APIs, and CSV/JSON upload.
**Alternatives considered:** Adding Ashby + RSS; upload + one API only; Apify-first for keyword discovery.
**Why:** Two real API shapes plus the manual path are enough to prove the pipeline and cross-source deduplication without building adapters ahead of need. Greenhouse and Lever expose one board per company, so "discovery" is a watch-list the user curates; market-wide keyword discovery needs Apify, which adds a paid third party and is deferred.
**What it affects:** `packages/ingestion/src/adapters/*`; the Sources page; any future adapter slots in by implementing `SourceAdapter`.

### D32. Ingestion runs in a separate BullMQ worker; logic lives in `packages/ingestion`
**Decision:** `services/job-ingestion` is a thin BullMQ process (scheduler reconcile + worker); adapters, normalization, identity and the DB pipeline live in `packages/ingestion`. No Dockerfile or compose service yet: `docker-compose.yml` runs only infrastructure and the web app is not containerized either.
**Alternatives considered:** An inline API route (D17's pattern); a worker hosted inside Next.js.
**Why:** D17 kept one-shot resume extraction inline and said recurring, high-volume work is what the worker layer is for. Inline breaks at dozens of boards (timeouts, no retries, no schedule); a worker inside Next ties fetch loops to the web server's lifecycle. Concurrency is 1 (one source at a time), which also rules out two runs of one source racing.
**What it affects:** `services/job-ingestion`; the README (how to start the worker); Phases 6–8 reuse the queue.

### D33. Enrichment is rules-only at ingest: no LLM, no embeddings; "unknown" is first-class
**Decision:** Salary, work mode, minimum experience and a sponsorship signal are extracted deterministically, each with an evidence snippet or an explicit unknown. Skill/requirement extraction and job embeddings wait for Phase 5/6 and run only on jobs that survive eligibility.
**Alternatives considered:** Embedding every new job; an LLM call per new job.
**Why:** D8 (deterministic before AI, keep spend tied to intent). The rules were prototyped against ~1,430 real postings and are pinned by a labeled evaluation set (100% precision/recall) that must be extended whenever a real posting is mis-read.
**What it affects:** `packages/ingestion/src/normalize/*`, `packages/ingestion/eval/*`.

### D34. Salary extraction: text scan only, with defensive rules (extends D6)
**Decision:** No structured pay fields appeared in any sampled posting, so salary is read from description text only. A trailing ISO code overrides the currency symbol; magnitude figures (`$100B`), bonus/equity amounts and anything without salary context are rejected; an amount with no stated period is annual only if it is at least 10,000; a bare `$` is USD unless the posting is in CA/AU/NZ/SG/HK; conflicting regional ranges are left unparsed with the raw span kept; an annualized value under 1,000 is rejected.
**Alternatives considered:** Parsing `pay_input_ranges` / `salaryRange` (shapes unverified); an LLM extractor (violates D6).
**Why:** Each rule exists because a real posting broke the previous draft (monthly MXN read as USD; `$1.4T` read as pay; nice-to-have years read as required). Missing salary is `null`, never zero.
**What it affects:** `normalize/salary.ts` and its tests; the `salary_*` columns.

### D35. A canonical job is recomputed from its postings by a pure merge
**Decision:** Each source appearance is a `job_postings` row holding a `normalized` snapshot; `jobs` is rebuilt by `mergePostings` (open before closed, source rank, recency; first *known* value per field group), and `jobs.field_provenance` records which posting supplied each group. `fingerprint` and `content_hash` live on postings. Raw payloads are kept (latest only) so parser fixes re-run without refetching.
**Alternatives considered:** Normalize-on-fetch with no raw store; overwrite-in-place merging.
**Why:** Precedence and provenance become directly testable pure logic; a fix to any extractor can be re-applied to stored data.
**What it affects:** `identity/merge.ts`, `pipeline/recomputeJob.ts`, the `jobs`/`job_postings`/`raw_job_postings` tables.

### D36. Three-tier identity; fuzzy matches are flagged, never merged; closing is conservative
**Decision:** Same `(source, external id)` is the same posting; the same company/title-key/location/description fingerprint links postings across sources; a same-location trigram match (`similarity >= 0.8` on company+title keys) becomes a `pending` duplicate candidate and is never auto-merged. Only a *complete* fetch of a non-upload source may close jobs; a fetch that returns zero records is treated as incomplete; uploads never close anything; a record that fails to normalize still counts as seen.
**Alternatives considered:** Fingerprint only; auto-merging fuzzy matches.
**Why:** A false merge silently hides a real job; a false split shows one extra row. An emptied API response, a half-failed fetch or a one-shot upload must never look like "the job expired". Seniority words are stripped from the comparison key by design, so different levels of one role can appear as candidates; the UI labels the percentage a *title match*.
**What it affects:** `pipeline/persistPosting.ts`, `pipeline/closeMissing.ts`, `pipeline/runIngestion.ts`.

### D37. The consent gate (D3) is enforced in three places, and errors are stored as classes
**Decision:** A source is created disabled and unconsented; enabling requires `consentConfirmed: true` and records `consent_confirmed_at`; the run API refuses unconsented sources; the worker's `runIngestion` refuses them again, recording a failed run. Uploads require an explicit consent field. Runs and sources store only an error *class* (`not_found`, `rate_limited`, ...), never a message (D29).
**Alternatives considered:** A UI-only checkbox.
**Why:** The gate exists so the system, not the user's memory, enforces permission for each source. Adapters call only operator-configured hosts with a validated slug (no user-supplied URLs, redirects not followed).
**What it affects:** `routes under api/job-sources`, `runIngestion`, `adapters/slug.ts`, `adapters/http.ts`.

### D38. Test infrastructure: advisory-locked migration, a CI pre-migrate step, `csv-parse`, a `./testing` entry
**Decision:** New test helpers migrate under a Postgres advisory lock and CI migrates once before the tests, because parallel suites migrating an empty database collide on enum creation (seen in 1 of 3 fresh runs; 0 of 9 after the fix). `csv-parse` is added for upload parsing (a hand-rolled CSV parser is error-prone). `@ai-career/ingestion/testing` exposes test helpers/fixtures without leaking them into production imports.
**Alternatives considered:** Retrofitting the lock into the eight existing `migrate()` callers (left as a follow-up); a hand-written CSV parser.
**Why:** Observed, not theoretical; and Turborepo's strict env means `TEST_*` overrides are invisible to `pnpm test`, so a scratch run can silently migrate the shared test database.
**What it affects:** `.github/workflows/ci.yml`, `packages/ingestion/src/testing/*`, `apps/web/src/test/jobsDb.ts`.
```

- [ ] **Step 3: FLOW.md**

Append this section (it documents call paths as built; match the file's existing style):

````markdown
## 6. Job ingestion: sources → queue → worker → normalized jobs → browser (Phase 4)

### 6a. Managing sources and queueing a run (request-driven)

```
POST /api/job-sources                     apps/web/src/app/api/job-sources/route.ts: POST()
├─ readJsonBody → CreateJobSourceSchema.safeParse        (400 on bad JSON / kind / slug)
├─ createDbClient → withUserContext(DEFAULT_USER_ID)
│  └─ insert job_sources { enabled:false, consent_confirmed_at:null }   (unique violation 23505 → 409)
└─ serializeSource → 201

PATCH /api/job-sources/[id]               .../[id]/route.ts: PATCH()      (params is a Promise)
└─ enabling with no stored consent and consentConfirmed !== true → 400 (D3); else set enabled / consent_confirmed_at

POST /api/job-sources/[id]/run            .../[id]/run/route.ts: POST()
├─ 404 unknown · 409 not enabled · 409 no consent
└─ enqueueIngestion(env, id)              lib/job-ingestion/enqueue.ts
   ├─ Queue.getJob(ingestJobId(id)) pending? → "already_queued" → 409
   └─ Queue.add("ingest-source", { sourceId }, { jobId: ingestJobId(id), attempts:3, backoff, removeOn* }) → 202

POST /api/job-sources/upload              .../upload/route.ts: POST()
├─ content-length cap → formData → consentConfirmed === "true" → parseUploadFile (UploadParseError → 400)
├─ withUserContext → storeUpload: insert upload source (enabled, consented) + raw_job_postings
└─ enqueueIngestion (failure → 201 with queued:false)
```

### 6b. The worker (process-driven)

```
pnpm --filter @ai-career/job-ingestion start          services/job-ingestion/src/main.ts: main()
├─ loadEnv → createDbClient → IORedis(maxRetriesPerRequest:null) → Queue → createAdapterFor → createIngestWorker
├─ reconcileSchedules(refresh:true) then every 60 s      reconcile.ts + schedule.ts: planSchedules()
│  └─ one repeatable scheduler per enabled, consented, non-upload source (DB is the source of truth)
└─ Worker("job-ingestion", concurrency 1)               worker.ts
   └─ runIngestion(db, { userId, sourceId, adapterFor })   packages/ingestion/src/pipeline/runIngestion.ts
      ├─ load source → insert ingestion_runs(running)
      ├─ GUARD: !enabled → "source_disabled"; !consent → "consent_missing"   (recorded, non-retryable)
      ├─ for await record of adapter.fetch(ref)
      │  ├─ greenhouse/lever: fetchJson (timeout, size cap, no redirects) → envelope schema → records
      │  ├─ upload: stored raw_job_postings rows
      │  └─ per record, one withUserContext transaction:
      │     ├─ upsert raw_job_postings (payload, content_hash)
      │     ├─ normalizeRecord(ref, record)              normalize/normalizeRecord.ts (pure)
      │     │  └─ escapedHtmlToText · companyKey/titleKey/locationKey/descriptionHash
      │     │     · extractSalary · extractMinExperience · extractSponsorship · detectWorkMode
      │     │  (throws NormalizeError → counted; the tracked posting's last_seen_at is still bumped)
      │     └─ persistPosting                            pipeline/persistPosting.ts
      │        ├─ tier 1: (source, external id) exists? unchanged hash → touch; else update
      │        ├─ tier 2: same fingerprint on any posting → link to that job; else insert jobs row
      │        ├─ upsert job_postings (normalized snapshot, fingerprint, content_hash)
      │        ├─ recomputeJob → mergePostings → update jobs (+ field_provenance, status)
      │        └─ tier 3 (new job only): flagFuzzyDuplicates → job_duplicate_candidates (pending)
      ├─ complete = fetched > 0; if complete and kind ≠ upload → closeMissingPostings (last_seen < run start)
      └─ finish: ingestion_runs + job_sources.last_run_* (error CLASS only)
   errors: IngestError.retryable (429/5xx/network/timeout/unknown) → BullMQ retry with backoff;
           otherwise → UnrecoverableError (no retry)
```

### 6c. Reading jobs (request-driven)

```
GET /api/jobs?q&status&sourceId&page     api/jobs/route.ts → ListJobsQuerySchema → listJobs(tx, query)
GET /api/jobs/[id]                       api/jobs/[id]/route.ts → getJobDetail(tx, id)  (postings + duplicate candidates)
/sources  → SourcesClient → /api/job-sources*        /jobs → JobsClient → /api/jobs        /jobs/[id] → JobDetailClient
```
````

- [ ] **Step 4: architecture.md, README, spec**

`docs/architecture.md`:
- Line 3: change "Phases 0–3 are implemented (foundation, candidate profile, career goal); job intelligence onward" to "Phases 0–4 are implemented (foundation, candidate profile, career goal, job intelligence); matching onward".
- §3 (Data sourcing boundary): append "Implemented in Phase 4: Greenhouse and Lever board APIs and CSV/JSON upload (`packages/ingestion/src/adapters`). Ashby, RSS and Apify remain unbuilt; each is a new `SourceAdapter`."
- §8 (Data model additions): append a bullet: "`job_sources`, `ingestion_runs`, `raw_job_postings`, `jobs`, `job_postings`, `job_duplicate_candidates` (Phase 4, [D35](../DECISIONS.md)/[D36](../DECISIONS.md)). `jobs` is derived from its postings by a pure merge; salary uses the D6 raw + normalized + currency + period + `is_parsed` shape."
- §10 (What's still open): delete the "Concrete job-identity/dedup algorithm..." bullet (now specified in D36).
- Add a short new section "## 11. Job ingestion (Phase 4)" summarizing the pipeline: `fetch → raw → normalize (rules) → identify (3 tiers) → postings → recompute canonical job → close`, the worker process model (D32) and where the consent gate lives (D37).

`README.md`: under Quick Start add step "7. Start the ingestion worker (needed for scheduled and 'Run now' fetches): `pnpm --filter @ai-career/job-ingestion start`", and a note: "After adding new migrations, migrate the *test* database once before running the whole suite: `MIGRATIONS_DATABASE_URL=postgres://career_intel:career_intel@localhost:5432/career_intel_test pnpm --filter @ai-career/db db:migrate`." Under Status add: "Phase 4 (Job Intelligence) complete: Greenhouse, Lever and CSV/JSON sources behind a consent gate, a BullMQ ingestion worker, deterministic normalization (salary, work mode, experience, sponsorship, posted date), three-tier deduplication and a Sources page and read-only Jobs browser. The home page links each step."

Spec (`docs/superpowers/specs/2026-09-21-phase-4-job-intelligence-design.md`): change the status line to "implemented; see the plan's 'Refinements' R1–R16 for where verification against real APIs changed the design", and add a final section "## 9. Implementation notes" stating that §3–§5 are superseded by that table where they conflict (structured pay fields not implemented; fingerprint/content hash on postings; `location_key` column; `first_published`/`createdAt` as posted dates; widened slug pattern; empty fetch is incomplete; no compose service).

- [ ] **Step 5: Whole-repo verification, in CI order, on a clean database**

Use a throwaway database so the shared test DB is not disturbed: create `career_intel_verify` (with `vector` and `pg_trgm` extensions and the app role's grants, as `infra/postgres/init.sql` does), then run from the repo root:

```bash
export TEST_MIGRATIONS_DATABASE_URL=postgres://career_intel:career_intel@localhost:5432/career_intel_verify
export TEST_APP_DATABASE_URL=postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_verify
MIGRATIONS_DATABASE_URL=$TEST_MIGRATIONS_DATABASE_URL pnpm --filter @ai-career/db db:migrate
pnpm install --frozen-lockfile=false && pnpm lint && pnpm build && pnpm typecheck
pnpm exec turbo run test --env-mode=loose
pnpm --filter @ai-career/ingestion eval:extraction
```

Expected: lint/build/typecheck clean; tests green. As validated while writing this plan (this exact task list, executed end to end on a scratch copy of the repo): config 11, storage 1, ai 137, db 14, ingestion 126 (including the 4 eval tests), job-ingestion 10, web 203 — **502 in total**, of which 298 existed before Phase 4. (If you add cases your counts may be higher; they must not be lower.) Afterwards confirm `career_intel_test` and the dev database were not changed unexpectedly (`select count(*) from drizzle.__drizzle_migrations` should equal the number of migration files that database has actually been migrated with).

- [ ] **Step 6: Review, memory and hand-over**

1. Run `superpowers:requesting-code-review` over the whole branch (correctness, security, error handling, unnecessary complexity), then fix findings.
2. Update `/Users/ak265/.claude/projects/-Users-ak265-Desktop-project/memory/project_careerpilot.md`: mark Phase 4 complete (with the commit range once known), and record the lessons: turbo strict env hides `TEST_*` overrides; parallel `migrate()` on an empty DB races (advisory lock + CI pre-migrate); Greenhouse `content` is entity-escaped and Lever splits requirements into `lists[]`; no structured pay fields were seen; the eval set is the place to add a case whenever a real posting is mis-read; **still unbuilt/never measured** (Ashby/RSS/Apify, real-board volume behavior, the 0.8 trigram threshold, deleting a source, duplicate-candidate resolution, compose service).
3. `superpowers:finishing-a-development-branch` to decide how to integrate.
4. **CLAUDE.md §21 verification.** Summarize what changed and why in a few sentences, then ask the user to explain back, in their own words: (a) why a fetch that returns zero jobs must not close anything; (b) what decides whether two postings become one job, and what happens to a near-match; (c) where the Terms-of-Service gate is enforced and why in more than one place. Do not consider the task complete until they can, or record that they chose to skip it (they skipped it for Phase 3).

---

## Self-review (spec coverage)

| Spec requirement | Task |
|---|---|
| §1 Greenhouse + Lever + upload adapters | 6, 7, 11 |
| §1 separate BullMQ worker, scheduled + on-demand | 12, 13 |
| §1 normalization: salary, work mode, experience, sponsorship, dates | 3, 4, 5 |
| §1 three-tier identity, closing, posted-date tracking | 9, 10, 11 |
| §1 UI: Sources page, Jobs list, Job detail | 16, 17 |
| §3 data model (six tables, RLS, trigram indexes) | 8 |
| §4 pipeline: guard, fetch, raw, normalize, identify, close; failure handling | 10, 11, 12 |
| §4 uploads never close; empty fetch incomplete | 11 |
| §5 rules incl. evidence and "unknown" | 3, 4, 18 |
| §6 API + pages, consent gate, 409/400 semantics, `readJsonBody` | 13, 14, 15 |
| §7 tests (unit, integration, eval, E2E), SSRF/upload/log-hygiene security | 1–19 |
| §7 DECISIONS, FLOW, architecture, README, §21 explain-back | 20 |
| §8 assumptions to verify (real API shapes) | Refinements table; verified before writing |
