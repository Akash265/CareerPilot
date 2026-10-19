# Phase 13b — Missing-Skill Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user answers each required skill a top job lists but their profile lacks — "I have it" (with one evidence sentence), "I don't have it", or "Same as <a profile skill>" — once, on a batched `/skills` page or a per-job panel; answered skills become citable resume evidence everywhere.

**Architecture:** A new `skill_verifications` table (RLS, one row per normalized term) is read by `buildResumeSnapshot`, which adds a `verified_skill` catalog entry per "have" answer and per live alias — so every existing guard, gap check and export sees verified skills as ordinary facts. Gap detection moves into `packages/resume-optimization/src/gaps/` and gains `computeSkillGaps` (covered / declined / unanswered + deterministic alias suggestions). After each matching run the matching worker, outside the BullMQ job, extracts requirements for the top `SKILL_GAP_TOP_N` eligible jobs so the batched page is ready.

**Tech Stack:** TypeScript, Drizzle ORM + Postgres (RLS), BullMQ worker events, Anthropic SDK via `@ai-career/ai`, zod, Next.js 16 route handlers, React client components, Vitest (+ jsdom/testing-library), the `e2e/` Playwright smoke.

**Spec:** `docs/superpowers/specs/2026-10-19-phase-13b-skill-verification-design.md` (read it first; "Planning refinements" below lists what this plan changes — Task 14 copies them into the spec as §13).

## Planning refinements (R1–R6)

- **R1 — Write routes are keyed by body / id, not by term in the path.** Terms like `ci/cd` or `c#` do not survive a path segment reliably. `PUT /api/skill-verifications` (body carries `termDisplay`; the server computes `term_key`) and `DELETE /api/skill-verifications/[id]` (uuid) replace the spec's `[termKey]` routes.
- **R2 — A live alias is a catalog entry too.** `buildResumeSnapshot` adds `{ sourceType: "verified_skill", text: "<term> (same as <profile skill>)" }` for an alias whose profile skill still exists. Without it, the cover-letter and interview-prep gap checks (`computeGapTerms`, which only sees the catalog) would still treat an aliased term as missing.
- **R3 — The requirements step runs after the matching job completes, not inside it.** It is fired from the worker's `completed` event (single-flight per user), so 13a's search run — which waits for matching to finish — is never delayed by up to 25 extraction calls.
- **R4 — Every verified skill is rendered in the resume's Skills section** (selected ones first), not only those the optimizer selected — consistent with D82 (every profile item is rendered).
- **R5 — E2E stops at the verification API and pages.** "Optimize resume → cites the verified fact" is pinned by a `runResumeOptimization` integration test with a fake Anthropic client (Task 5), because the E2E stand-in has no optimizer answer.
- **R6 — The alias table has ~50 groups**, not ~60: only unambiguous equivalents (e.g. `tf`, `cv`, `dl` are left out).

## Global Constraints

- `SKILL_GAP_TOP_N`: optional env, default **25**, int **1–200**.
- Evidence: required for `have`, **1–300** characters after trim; `termDisplay` and `aliasSkillName` **1–200** characters after trim.
- `normalizeTermKey(term)` = trim → lowercase → collapse internal whitespace runs to one space. It is the only way a `term_key` is produced.
- Gap candidates are unchanged (D104): `requirement_level='required'`, `term_type ∈ {skill, tool, certification}`, ≤ 4 words.
- A suggestion never makes a term covered. Only the user's answer (or profile text) covers a term.
- Never log evidence text, job descriptions or profile content; logs carry ids, counts and error class names only.
- Verifying a skill does not change match scores (scoring uses the goal's skills).
- New tables get the RLS `user_isolation` policy; the FK-index guard (`packages/db/src/foreignKeyIndexes.test.ts`) must still pass (the new table has no FKs).
- Test user ids for this phase: `00000000-0000-0000-0000-000000000d10` … `…0d16`. Before using one run `grep -rn "000000000d1X" packages apps services e2e` (X = the digit) and confirm no hit.
- Commits: one per task (the user authorised commits for this phase's workflow); end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Docker infra must be up for DB/Redis tests: `docker compose -f infra/docker-compose.yml up -d`. A fresh worktree needs `pnpm install` and `pnpm --filter web build` once before `tsc` in `apps/web`.
- `apps/web` uses Next.js 16: read `apps/web/AGENTS.md` and the relevant guide under `apps/web/node_modules/next/dist/docs/` before writing route handlers or pages; copy the shape of existing routes (`params` is a Promise).

## Review Focus

1. **A term containing `/`, `#`, `+` or `.`** (`CI/CD`, `C#`, `C++`, `Node.js`) — a reasonable person expects answering it to work and the gap to disappear. Pinned in Task 10 (PUT with `CI/CD` and `C#`) and Task 4 (`C++` covered by a "have" row keyed `c++`).
2. **The user deletes a profile skill that an alias points to** — the gap must come back as unanswered with that skill offered as a suggestion, and the alias must leave the resume catalog. Pinned in Task 4 (stale alias → unanswered + suggestion) and Task 5 (stale alias not in catalog).
3. **The same term written differently by two jobs** (`Kubernetes` vs `kubernetes `, `Apache  Kafka` vs `Apache Kafka`) — one question, counted for both jobs. Pinned in Task 4 (one gap, two requirement ids) and Task 9 (overview `jobCount: 2`).
4. **The AI budget runs out during the post-matching requirements step** — remaining jobs are skipped, the matching run is unaffected, and nothing loops. Pinned in Task 6 (budget error stops after the first job) and Task 7 (errors go to `onError`, never thrown).
5. **A profile save after answering** (`saveProfile` deletes and re-inserts every skill) — answers survive; resume versions show as stale because the snapshot hash changed. Pinned in Task 2 (rows independent of `skills`) and Task 5 (hash changes when a verification is added).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/config/src/env.ts` (+test), `.env.example` | `SKILL_GAP_TOP_N` |
| `packages/db/src/schema/skillVerifications.ts` (new), `schema/index.ts` | table + enum |
| `packages/db/migrations/0035_*.sql`, `0036_skill_verifications_rls.sql`, `package.json` | DDL; RLS |
| `packages/db/src/skillVerificationsTable.rls.test.ts` (new) | RLS + CHECK constraints |
| `packages/{resume-optimization,application-package,document-export,matching}/src/testing/db.ts`, `apps/web/src/test/jobsDb.ts` | wipe the new table |
| `packages/resume-optimization/src/gaps/computeGapTerms.ts` (+test, moved) | gap candidates + boundary-aware match |
| `packages/resume-optimization/src/gaps/normalizeTermKey.ts` (+test) | term key |
| `packages/resume-optimization/src/gaps/aliases.ts` (+test) | built-in equivalence groups |
| `packages/resume-optimization/src/gaps/computeSkillGaps.ts` (+test) | covered / declined / unanswered + suggestion |
| `packages/resume-optimization/src/gaps/topMatchRequirements.ts` (+test) | top-N selection, post-matching extraction |
| `packages/resume-optimization/src/optimization/buildResumeSnapshot.ts` (+test) | `verified_skill` entries |
| `packages/resume-optimization/src/index.ts` | exports |
| `packages/application-package/src/interviewPrep/computeGapTerms.ts`, `src/index.ts` | re-export shim |
| `services/matching-worker/src/requirementsRefresh.ts` (+test), `main.ts`, `package.json` | single-flight post-matching step |
| `packages/document-export/src/model/{resumeProfile,buildResumeModel}.ts`, `pipeline/loadResumeProfile.ts` (+tests) | verified skills in the Skills section |
| `apps/web/src/lib/skillGaps/{loadSkillGaps,verificationBody,saveVerification}.ts` (+tests) | read model, body schema, upsert |
| `apps/web/src/app/api/skill-gaps/route.ts`, `[jobId]/route.ts`, `[jobId]/requirements/route.ts` (+tests) | read routes + "Check requirements" |
| `apps/web/src/app/api/skill-verifications/route.ts`, `[id]/route.ts` (+tests) | PUT / DELETE |
| `apps/web/src/lib/http/rateLimitedRoutes.test.ts` | registry entry for the AI route |
| `apps/web/src/app/skills/{page,SkillsClient,SkillAnswerForm}.tsx` (+tests) | `/skills` page |
| `apps/web/src/app/matches/[jobId]/{SkillGapsPanel,MatchDetailClient,ResumeOptimizationPanel}.tsx` (+tests) | per-job panel + notice |
| `apps/web/src/app/page.tsx` (+test), `matches/page.tsx` | links |
| `e2e/fakeProviders.mjs`, `e2e/smoke.mjs` | requirements stand-in + checks |
| `DECISIONS.md`, `FLOW.md`, `docs/api.md`, `docs/ai-system.md`, spec | docs |

---

### Task 1: Configuration

**Files:**
- Modify: `packages/config/src/env.ts` (after `MATCHING_EXPLANATION_TTL_DAYS`, ~line 44)
- Modify: `packages/config/src/env.test.ts` (append inside the top-level `describe`)
- Modify: `.env.example` (after the Phase 13a block, ~line 140)

**Interfaces:**
- Produces: `Env.SKILL_GAP_TOP_N: number`.

- [ ] **Step 1: Write the failing test** (append to `env.test.ts`, inside the existing top-level `describe`, next to the Phase 13a tests)

```ts
  it("Phase 13b: SKILL_GAP_TOP_N defaults to 25, treats blank as unset, and is bounded 1-200", () => {
    expect(loadEnv(validSource).SKILL_GAP_TOP_N).toBe(25);
    expect(loadEnv({ ...validSource, SKILL_GAP_TOP_N: "" }).SKILL_GAP_TOP_N).toBe(25);
    expect(loadEnv({ ...validSource, SKILL_GAP_TOP_N: "40" }).SKILL_GAP_TOP_N).toBe(40);
    expect(() => loadEnv({ ...validSource, SKILL_GAP_TOP_N: "0" })).toThrow(/SKILL_GAP_TOP_N/);
    expect(() => loadEnv({ ...validSource, SKILL_GAP_TOP_N: "201" })).toThrow(/SKILL_GAP_TOP_N/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ai-career/config test -- -t "Phase 13b"`
Expected: FAIL (`expected undefined to be 25`).

- [ ] **Step 3: Implement**

In `env.ts`, after `MATCHING_EXPLANATION_TTL_DAYS`:

```ts
    // Phase 13b: top eligible matches whose requirements are extracted after each matching run and listed on /skills.
    SKILL_GAP_TOP_N: z.preprocess(blankAsUnset, z.coerce.number().int().min(1).max(200).default(25)),
```

In `.env.example`, after the Phase 13a block:

```
# Phase 13b: after each matching run, required skills are checked for this many top eligible matches (one
# fast-model call per job not checked yet; cached by description). They are listed on /skills.
# SKILL_GAP_TOP_N=25
```

- [ ] **Step 4: Run the config tests**

Run: `pnpm --filter @ai-career/config test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/env.ts packages/config/src/env.test.ts .env.example
git commit -m "feat(config): SKILL_GAP_TOP_N for Phase 13b skill verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `skill_verifications` table, migrations, RLS, wipe helpers

**Files:**
- Create: `packages/db/src/schema/skillVerifications.ts`
- Modify: `packages/db/src/schema/index.ts` (append export)
- Modify: `packages/db/package.json` (custom-migration script)
- Create (generated): `packages/db/migrations/0035_<name>.sql` + `meta/0035_snapshot.json` + `_journal.json` entry
- Create (custom): `packages/db/migrations/0036_skill_verifications_rls.sql`
- Create: `packages/db/src/skillVerificationsTable.rls.test.ts`
- Modify: `packages/resume-optimization/src/testing/db.ts`, `packages/application-package/src/testing/db.ts`, `packages/document-export/src/testing/db.ts`, `packages/matching/src/testing/db.ts` (`wipeUser`), `apps/web/src/test/jobsDb.ts` (`wipeMatchingData`)

**Interfaces:**
- Produces: `schema.skillVerifications` (columns `id, userId, termKey, termDisplay, status, evidence, aliasSkillName, answeredAt, updatedAt`), `schema.skillVerificationStatusEnum`, type `SkillVerificationStatus = "have" | "dont_have" | "alias"`.

- [ ] **Step 1: Write the failing test** — `packages/db/src/skillVerificationsTable.rls.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { withUserContext } from "./rls";
import { createDbClient, closeDbClient } from "./client";
import { schema } from "./index";

const MIGRATIONS_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
const adminSql = postgres(process.env.TEST_MIGRATIONS_DATABASE_URL ?? "postgres://career_intel:career_intel@localhost:5432/career_intel_test", { onnotice: () => undefined });
const db = createDbClient({ DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test" });

// Phase 13b test users (…0d10/…0d11); verify unused with grep before relying on them.
const USER_A = "00000000-0000-0000-0000-000000000d10";
const USER_B = "00000000-0000-0000-0000-000000000d11";
const MIGRATION_LOCK = 7420001;

const wipe = async () => {
  await adminSql`DELETE FROM skill_verifications WHERE user_id IN (${USER_A}, ${USER_B})`;
  await adminSql`DELETE FROM skills WHERE user_id IN (${USER_A}, ${USER_B})`;
};

beforeAll(async () => {
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
});
beforeEach(wipe);
afterAll(async () => {
  await wipe();
  await adminSql.end();
  await closeDbClient(db);
});

const violates = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23514" }) });

describe("skill_verifications (Phase 13b)", () => {
  it("isolates answers by user", async () => {
    for (const user of [USER_A, USER_B]) {
      await withUserContext(db, user, (tx) =>
        tx.insert(schema.skillVerifications).values({ termKey: "kubernetes", termDisplay: "Kubernetes", status: "dont_have" }));
    }
    const rows = await withUserContext(db, USER_A, (tx) => tx.select().from(schema.skillVerifications));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: USER_A, status: "dont_have", evidence: null, aliasSkillName: null });
  });

  it("allows one answer per term per user", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      await tx.insert(schema.skillVerifications).values({ termKey: "dbt", termDisplay: "dbt", status: "dont_have" });
      await expect(tx.transaction((sp) => sp.insert(schema.skillVerifications).values({ termKey: "dbt", termDisplay: "DBT", status: "dont_have" })))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: "23505" }) });
    });
  });

  it("requires evidence exactly for 'have' and a skill name exactly for 'alias'", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      const ins = (v: Partial<typeof schema.skillVerifications.$inferInsert>) =>
        tx.transaction((sp) => sp.insert(schema.skillVerifications).values({ termKey: "k", termDisplay: "K", status: "have", ...v }));
      await violates(ins({ status: "have", evidence: null }));
      await violates(ins({ status: "have", evidence: "   " }));
      await violates(ins({ status: "have", evidence: "x".repeat(301) }));
      await violates(ins({ status: "have", evidence: "Used it", aliasSkillName: "Docker" }));
      await violates(ins({ status: "dont_have", evidence: "Used it" }));
      await violates(ins({ status: "alias", aliasSkillName: null }));
      await violates(ins({ status: "alias", aliasSkillName: "Docker", evidence: "x" }));
      await violates(ins({ termKey: "", status: "dont_have" }));
      await ins({ status: "have", evidence: "Ran our staging cluster for a year." });
    });
  });

  it("survives a profile save that deletes and re-inserts every skill", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      await tx.insert(schema.skills).values({ name: "Postgres" });
      await tx.insert(schema.skillVerifications).values({ termKey: "postgresql", termDisplay: "PostgreSQL", status: "alias", aliasSkillName: "Postgres" });
      await tx.delete(schema.skills);
      await tx.insert(schema.skills).values({ name: "Postgres" });
    });
    const rows = await withUserContext(db, USER_A, (tx) => tx.select().from(schema.skillVerifications));
    expect(rows).toEqual([expect.objectContaining({ termKey: "postgresql", aliasSkillName: "Postgres" })]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ai-career/db test -- skillVerificationsTable`
Expected: FAIL (TypeScript/`schema.skillVerifications` undefined).

- [ ] **Step 3: Write the schema** — `packages/db/src/schema/skillVerifications.ts`

```ts
import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";

export const skillVerificationStatusEnum = pgEnum("skill_verification_status", ["have", "dont_have", "alias"]);
export type SkillVerificationStatus = (typeof skillVerificationStatusEnum.enumValues)[number];

/**
 * Phase 13b: the user's answer to "this job requires <term>; do you have it?", one row per normalized term
 * (normalizeTermKey in @ai-career/resume-optimization). Deliberately separate from `skills`: saveProfile deletes and
 * re-inserts every skills row, so an answer stored there would be lost on the next profile edit. An alias names the
 * profile skill by name, not id, for the same reason. "have" rows (and live aliases) become `verified_skill`
 * entries in the resume evidence catalog (buildResumeSnapshot).
 */
export const skillVerifications = pgTable(
  "skill_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    termKey: text("term_key").notNull(),
    termDisplay: text("term_display").notNull(),
    status: skillVerificationStatusEnum("status").notNull(),
    evidence: text("evidence"),
    aliasSkillName: text("alias_skill_name"),
    answeredAt: timestamp("answered_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userTermUniq: uniqueIndex("skill_verifications_user_term_uniq").on(t.userId, t.termKey),
    fieldsMatchStatus: check(
      "skill_verifications_fields_match_status",
      sql`(${t.status} = 'have' AND ${t.evidence} IS NOT NULL AND ${t.aliasSkillName} IS NULL)
        OR (${t.status} = 'dont_have' AND ${t.evidence} IS NULL AND ${t.aliasSkillName} IS NULL)
        OR (${t.status} = 'alias' AND ${t.evidence} IS NULL AND ${t.aliasSkillName} IS NOT NULL)`
    ),
    evidenceLength: check(
      "skill_verifications_evidence_length",
      sql`${t.evidence} IS NULL OR char_length(btrim(${t.evidence})) BETWEEN 1 AND 300`
    ),
    termLength: check(
      "skill_verifications_term_length",
      sql`char_length(${t.termKey}) BETWEEN 1 AND 200 AND char_length(btrim(${t.termDisplay})) BETWEEN 1 AND 200`
    ),
    aliasLength: check(
      "skill_verifications_alias_length",
      sql`${t.aliasSkillName} IS NULL OR char_length(btrim(${t.aliasSkillName})) BETWEEN 1 AND 200`
    ),
  })
);
```

Append to `packages/db/src/schema/index.ts`: `export * from "./skillVerifications";`

- [ ] **Step 4: Generate the DDL migration**

Run: `pnpm --filter @ai-career/db db:generate`
Expected: a new `packages/db/migrations/0035_<random>.sql` with `CREATE TYPE "public"."skill_verification_status"`, `CREATE TABLE "skill_verifications"`, the four CHECKs and the unique index — nothing else. If it contains unrelated statements, stop and report (the schema drifted).

- [ ] **Step 5: Add the RLS migration**

Add to `packages/db/package.json` scripts, after `db:generate:custom:search-runs-rls`:

```json
    "db:generate:custom:skill-verifications-rls": "dotenv -e ../../.env -- drizzle-kit generate --custom --name=skill_verifications_rls",
```

Run: `pnpm --filter @ai-career/db db:generate:custom:skill-verifications-rls`, then fill the empty `0036_skill_verifications_rls.sql` with:

```sql
-- Custom SQL migration: RLS drizzle-kit cannot generate for Phase 13b. Follows 0034.

ALTER TABLE skill_verifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON skill_verifications
  USING (user_id = current_setting('app.current_user_id')::uuid);
```

- [ ] **Step 6: Wipe the new table in every test helper that wipes profile/match data**

Add as the first statement of each function:
- `packages/resume-optimization/src/testing/db.ts` → `wipeUser`
- `packages/application-package/src/testing/db.ts` → `wipeUser`
- `packages/document-export/src/testing/db.ts` → `wipeUser`
- `packages/matching/src/testing/db.ts` → `wipeUser`
- `apps/web/src/test/jobsDb.ts` → `wipeMatchingData` (after the `ai_calls` line)

```ts
  await adminSql`DELETE FROM skill_verifications WHERE user_id = ${userId}`;
```

- [ ] **Step 7: Run the DB tests**

Run: `pnpm --filter @ai-career/db test`
Expected: PASS, including `foreignKeyIndexes.test.ts` and the new file.

- [ ] **Step 8: Migrate the dev database**

Run: `pnpm --filter @ai-career/db db:migrate`
Expected: applies 0035 and 0036.

- [ ] **Step 9: Commit**

```bash
git add packages/db packages/resume-optimization/src/testing/db.ts packages/application-package/src/testing/db.ts packages/document-export/src/testing/db.ts packages/matching/src/testing/db.ts apps/web/src/test/jobsDb.ts
git commit -m "feat(db): skill_verifications table with RLS (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Move gap detection; term keys and the alias table

**Files:**
- Move: `packages/application-package/src/interviewPrep/computeGapTerms.ts` → `packages/resume-optimization/src/gaps/computeGapTerms.ts` (`git mv`, then edit)
- Move: `packages/application-package/src/interviewPrep/computeGapTerms.test.ts` → `packages/resume-optimization/src/gaps/computeGapTerms.test.ts` (`git mv`, fix imports only)
- Create: `packages/application-package/src/interviewPrep/computeGapTerms.ts` (re-export shim)
- Create: `packages/resume-optimization/src/gaps/normalizeTermKey.ts` (+ `.test.ts`)
- Create: `packages/resume-optimization/src/gaps/aliases.ts` (+ `.test.ts`)
- Modify: `packages/resume-optimization/src/index.ts`

**Interfaces:**
- Produces (from `@ai-career/resume-optimization`): `computeGapTerms(requirements: RequirementForGapDetection[], catalog: EvidenceCatalogEntry[]): GapTerm[]`, `containsTerm(haystackLower: string, termLower: string): boolean`, `isGapCandidate(r: RequirementForGapDetection): boolean`, `MAX_GAP_TERM_WORDS = 4`, types `GapTerm = { term: string; requirementId: string }`, `RequirementTermType`, `RequirementForGapDetection = { id: string; termText: string; requirementLevel: "required" | "preferred"; termType: RequirementTermType }`; `normalizeTermKey(term: string): string`; `aliasGroupOf(termKey: string): readonly string[] | undefined`; `ALIAS_GROUPS: readonly (readonly string[])[]`.

- [ ] **Step 1: Move the files**

```bash
git mv packages/application-package/src/interviewPrep/computeGapTerms.ts packages/resume-optimization/src/gaps/computeGapTerms.ts
git mv packages/application-package/src/interviewPrep/computeGapTerms.test.ts packages/resume-optimization/src/gaps/computeGapTerms.test.ts
```

- [ ] **Step 2: Make the moved module self-contained**

In `packages/resume-optimization/src/gaps/computeGapTerms.ts`, replace the three import lines at the top with:

```ts
import type { EvidenceCatalogEntry } from "../optimization/buildResumeSnapshot";

/** A required job term not found in the profile (formerly application-package's GapTerm; same shape). */
export interface GapTerm {
  term: string;
  requirementId: string;
}
```

and replace the `RequirementForGapDetection` interface (which extended application-package's `RequirementForEvidence`) with:

```ts
/** What computeGapTerms needs from a job_requirements row: the evidence fields plus the term's type (D104). */
export interface RequirementForGapDetection {
  id: string;
  termText: string;
  requirementLevel: "required" | "preferred";
  termType: RequirementTermType;
}
```

Leave every function body unchanged. In the moved test, change only import paths (e.g. `@ai-career/resume-optimization` type imports → `../optimization/buildResumeSnapshot`, `./computeGapTerms` stays). If it imported application-package test helpers, inline the tiny fixtures it needs.

- [ ] **Step 3: Re-export from application-package** — new `packages/application-package/src/interviewPrep/computeGapTerms.ts`

```ts
// Phase 13b: gap detection moved to @ai-career/resume-optimization (src/gaps/), shared with skill verification and the
// resume. Re-exported here so the cover-letter and interview-prep code keeps its imports.
export {
  computeGapTerms, containsTerm, isGapCandidate, MAX_GAP_TERM_WORDS, type RequirementForGapDetection, type RequirementTermType,
} from "@ai-career/resume-optimization";
```

`application-package/src/types.ts`'s own `GapTerm` stays (structurally identical; no change).

- [ ] **Step 4: Write the failing tests for term keys and aliases**

`packages/resume-optimization/src/gaps/normalizeTermKey.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeTermKey } from "./normalizeTermKey";

describe("normalizeTermKey", () => {
  it("trims, lowercases and collapses whitespace", () => {
    expect(normalizeTermKey("  Apache\t  Kafka ")).toBe("apache kafka");
  });
  it("keeps punctuation that distinguishes skills", () => {
    expect(normalizeTermKey("C++")).toBe("c++");
    expect(normalizeTermKey("C#")).toBe("c#");
    expect(normalizeTermKey("CI/CD")).toBe("ci/cd");
    expect(normalizeTermKey("Node.js")).toBe("node.js");
  });
});
```

`packages/resume-optimization/src/gaps/aliases.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ALIAS_GROUPS, aliasGroupOf } from "./aliases";
import { normalizeTermKey } from "./normalizeTermKey";

describe("alias table", () => {
  it("stores only normalized keys", () => {
    for (const group of ALIAS_GROUPS) for (const key of group) expect(key).toBe(normalizeTermKey(key));
  });
  it("never lists a key in two groups, and every group has at least two names", () => {
    const seen = new Set<string>();
    for (const group of ALIAS_GROUPS) {
      expect(group.length).toBeGreaterThanOrEqual(2);
      for (const key of group) {
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
      }
    }
  });
  it("finds a term's group, or nothing", () => {
    expect(aliasGroupOf("postgresql")).toContain("postgres");
    expect(aliasGroupOf("k8s")).toContain("kubernetes");
    expect(aliasGroupOf("cobol")).toBeUndefined();
  });
});
```

- [ ] **Step 5: Run them to verify they fail**

Run: `pnpm --filter @ai-career/resume-optimization test -- gaps`
Expected: FAIL (modules not found) for the two new files; `computeGapTerms.test.ts` PASSES.

- [ ] **Step 6: Implement**

`packages/resume-optimization/src/gaps/normalizeTermKey.ts`:

```ts
/** Phase 13b: the one way a skill_verifications.term_key is made. Punctuation is kept ("c++" is not "c"). */
export function normalizeTermKey(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}
```

`packages/resume-optimization/src/gaps/aliases.ts`:

```ts
/**
 * Phase 13b: names that mean the same skill. Used only to SUGGEST "same as your <profile skill>?" for an unanswered
 * gap; a suggestion never covers a term. Only unambiguous equivalents (no "tf", "cv", "dl"). Keys are normalized
 * (normalizeTermKey); aliases.test.ts checks that and that no key is in two groups.
 */
export const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["postgres", "postgresql"],
  ["javascript", "js", "ecmascript"],
  ["typescript", "ts"],
  ["kubernetes", "k8s"],
  ["aws", "amazon web services"],
  ["gcp", "google cloud", "google cloud platform"],
  ["azure", "microsoft azure"],
  ["machine learning", "ml"],
  ["artificial intelligence", "ai"],
  ["natural language processing", "nlp"],
  ["large language models", "llm", "llms"],
  ["ci/cd", "cicd", "ci-cd", "continuous integration and delivery", "continuous integration/continuous delivery"],
  ["node.js", "nodejs", "node"],
  ["react", "react.js", "reactjs"],
  ["vue", "vue.js", "vuejs"],
  ["next.js", "nextjs"],
  ["go", "golang"],
  ["c#", "csharp", "c sharp"],
  ["c++", "cpp"],
  [".net", "dotnet"],
  ["python", "python 3", "python3"],
  ["scikit-learn", "sklearn", "scikit learn"],
  ["pytorch", "torch"],
  ["power bi", "powerbi"],
  ["excel", "microsoft excel", "ms excel"],
  ["spark", "apache spark"],
  ["kafka", "apache kafka"],
  ["airflow", "apache airflow"],
  ["dbt", "data build tool"],
  ["elasticsearch", "elastic search"],
  ["mongodb", "mongo"],
  ["sql server", "microsoft sql server", "mssql", "ms sql"],
  ["s3", "amazon s3", "aws s3"],
  ["redshift", "amazon redshift", "aws redshift"],
  ["bigquery", "google bigquery"],
  ["ec2", "amazon ec2", "aws ec2"],
  ["lambda", "aws lambda"],
  ["terraform", "hashicorp terraform"],
  ["github actions", "gh actions"],
  ["rest", "rest api", "rest apis", "restful api", "restful apis"],
  ["graphql", "graph ql"],
  ["ruby on rails", "rails", "ror"],
  ["ux", "user experience"],
  ["ui", "user interface"],
  ["ui/ux", "ux/ui"],
  ["seo", "search engine optimization"],
  ["etl", "extract transform load", "extract, transform, load"],
  ["bi", "business intelligence"],
  ["a/b testing", "ab testing", "split testing"],
  ["oop", "object-oriented programming", "object oriented programming"],
  ["tdd", "test-driven development", "test driven development"],
  ["html", "html5"],
  ["css", "css3"],
  ["sass", "scss"],
  ["salesforce", "sfdc"],
  ["bash", "bash scripting"],
];

const GROUP_BY_KEY = new Map<string, readonly string[]>(ALIAS_GROUPS.flatMap((group) => group.map((key) => [key, group] as const)));

export function aliasGroupOf(termKey: string): readonly string[] | undefined {
  return GROUP_BY_KEY.get(termKey);
}
```

Append to `packages/resume-optimization/src/index.ts`:

```ts
export {
  computeGapTerms, containsTerm, isGapCandidate, MAX_GAP_TERM_WORDS,
  type GapTerm, type RequirementForGapDetection, type RequirementTermType,
} from "./gaps/computeGapTerms";
export { normalizeTermKey } from "./gaps/normalizeTermKey";
export { ALIAS_GROUPS, aliasGroupOf } from "./gaps/aliases";
```

- [ ] **Step 7: Run both packages' tests and typecheck**

Run: `pnpm --filter @ai-career/resume-optimization test && pnpm --filter @ai-career/application-package test && pnpm --filter @ai-career/application-package typecheck && pnpm --filter @ai-career/application-package lint`
Expected: PASS. The application-package eval scripts (`eval/score*GroundingEval.ts`) still import `../src/interviewPrep/computeGapTerms` — the shim keeps them compiling.

- [ ] **Step 8: Commit**

```bash
git add packages/resume-optimization packages/application-package
git commit -m "refactor(gaps): move gap detection to resume-optimization; add term keys and alias table (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `computeSkillGaps`

**Files:**
- Create: `packages/resume-optimization/src/gaps/computeSkillGaps.ts` (+ `.test.ts`)
- Modify: `packages/resume-optimization/src/index.ts`

**Interfaces:**
- Consumes: Task 3's `isGapCandidate`, `containsTerm`, `normalizeTermKey`, `aliasGroupOf`, `RequirementForGapDetection`; `EvidenceCatalogEntry`.
- Produces:

```ts
export interface SkillVerificationForGaps { termKey: string; status: "have" | "dont_have" | "alias"; aliasSkillName: string | null }
export type SkillGapState = "covered" | "declined" | "unanswered";
export interface SkillGap { termKey: string; termDisplay: string; requirementIds: string[]; state: SkillGapState; suggestion: string | null }
export function computeSkillGaps(
  requirements: RequirementForGapDetection[], catalog: EvidenceCatalogEntry[],
  verifications: SkillVerificationForGaps[], profileSkillNames: string[],
): SkillGap[];
```

- [ ] **Step 1: Write the failing test** — `computeSkillGaps.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { computeSkillGaps, type SkillVerificationForGaps } from "./computeSkillGaps";
import type { RequirementForGapDetection } from "./computeGapTerms";
import type { EvidenceCatalogEntry } from "../optimization/buildResumeSnapshot";

const req = (id: string, termText: string, over: Partial<RequirementForGapDetection> = {}): RequirementForGapDetection =>
  ({ id, termText, requirementLevel: "required", termType: "skill", ...over });
const entry = (text: string): EvidenceCatalogEntry => ({ sourceFactId: `f-${text}`, sourceType: "skill", text, context: null });
const v = (termKey: string, status: SkillVerificationForGaps["status"], aliasSkillName: string | null = null): SkillVerificationForGaps =>
  ({ termKey, status, aliasSkillName });

describe("computeSkillGaps", () => {
  it("ignores preferred, 'other'-typed and phrase-shaped requirements (D104)", () => {
    const gaps = computeSkillGaps([
      req("1", "Rust", { requirementLevel: "preferred" }),
      req("2", "Teamwork", { termType: "other" }),
      req("3", "Production data pipeline building experience"),
    ], [], [], []);
    expect(gaps).toEqual([]);
  });

  it("marks a term found in profile text as covered", () => {
    expect(computeSkillGaps([req("1", "Python")], [entry("Python")], [], [])).toEqual([
      { termKey: "python", termDisplay: "Python", requirementIds: ["1"], state: "covered", suggestion: null },
    ]);
  });

  it("merges the same term written differently into one gap with every requirement id", () => {
    const gaps = computeSkillGaps([req("b", "Apache  Kafka"), req("a", " apache kafka")], [], [], []);
    expect(gaps).toEqual([{ termKey: "apache kafka", termDisplay: "Apache Kafka", requirementIds: ["a", "b"], state: "unanswered", suggestion: null }]);
  });

  it("covers a 'have' answer, including punctuated terms", () => {
    const gaps = computeSkillGaps([req("1", "C++"), req("2", "Kubernetes")], [], [v("c++", "have"), v("kubernetes", "have")], []);
    expect(gaps.map((g) => [g.termKey, g.state])).toEqual([["c++", "covered"], ["kubernetes", "covered"]]);
  });

  it("marks 'dont_have' declined, but profile text still wins", () => {
    const gaps = computeSkillGaps([req("1", "dbt"), req("2", "SQL")], [entry("SQL")], [v("dbt", "dont_have"), v("sql", "dont_have")], []);
    expect(gaps.map((g) => [g.termKey, g.state])).toEqual([["dbt", "declined"], ["sql", "covered"]]);
  });

  it("covers a live alias and reopens a stale one with the old skill as the suggestion", () => {
    const live = computeSkillGaps([req("1", "PostgreSQL")], [], [v("postgresql", "alias", "Postgres")], ["Postgres"]);
    expect(live[0]).toMatchObject({ state: "covered", suggestion: null });
    const stale = computeSkillGaps([req("1", "PostgreSQL")], [], [v("postgresql", "alias", "Postgres")], ["Python"]);
    expect(stale[0]).toMatchObject({ state: "unanswered", suggestion: "Postgres" });
  });

  it("suggests a profile skill from the alias table without covering the term", () => {
    const gaps = computeSkillGaps([req("1", "PostgreSQL"), req("2", "K8s")], [], [], ["Postgres", "Kubernetes"]);
    expect(gaps).toEqual([
      { termKey: "k8s", termDisplay: "K8s", requirementIds: ["2"], state: "unanswered", suggestion: "Kubernetes" },
      { termKey: "postgresql", termDisplay: "PostgreSQL", requirementIds: ["1"], state: "unanswered", suggestion: "Postgres" },
    ]);
  });

  it("does not treat 'Go' inside 'Google' as covered (boundary-aware)", () => {
    expect(computeSkillGaps([req("1", "Go")], [entry("Google Analytics")], [], [])[0].state).toBe("unanswered");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ai-career/resume-optimization test -- computeSkillGaps`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `computeSkillGaps.ts`

```ts
import type { EvidenceCatalogEntry } from "../optimization/buildResumeSnapshot";
import { containsTerm, isGapCandidate, type RequirementForGapDetection } from "./computeGapTerms";
import { normalizeTermKey } from "./normalizeTermKey";
import { aliasGroupOf } from "./aliases";

export interface SkillVerificationForGaps {
  termKey: string;
  status: "have" | "dont_have" | "alias";
  aliasSkillName: string | null;
}
export type SkillGapState = "covered" | "declined" | "unanswered";
export interface SkillGap {
  termKey: string;
  termDisplay: string;
  requirementIds: string[];
  state: SkillGapState;
  suggestion: string | null;
}

/**
 * Phase 13b design §5.2: every gap candidate (isGapCandidate, D104) of one job, grouped by normalized term and
 * classified. covered = the user said "have", or aliased it to a skill still in the profile, or profile text contains
 * it (computeGapTerms' boundary-aware rule; profile text wins over "dont_have"). declined = "dont_have". Otherwise
 * unanswered, with a suggestion: a stale alias's old skill, else a profile skill in the same alias group. A suggestion
 * never covers a term. Sorted by term key; requirement ids sorted.
 */
export function computeSkillGaps(
  requirements: RequirementForGapDetection[],
  catalog: EvidenceCatalogEntry[],
  verifications: SkillVerificationForGaps[],
  profileSkillNames: string[]
): SkillGap[] {
  const haystack = catalog.map((e) => (e.context ? `${e.context}: ${e.text}` : e.text)).join("\n").toLowerCase();
  const profileByKey = new Map(profileSkillNames.map((name) => [normalizeTermKey(name), name]));
  const answerByKey = new Map(verifications.map((answer) => [answer.termKey, answer]));

  const byKey = new Map<string, { termDisplay: string; requirementIds: string[] }>();
  for (const r of requirements.filter(isGapCandidate)) {
    const key = normalizeTermKey(r.termText);
    const existing = byKey.get(key);
    if (existing) existing.requirementIds.push(r.id);
    else byKey.set(key, { termDisplay: r.termText.trim().replace(/\s+/g, " "), requirementIds: [r.id] });
  }

  const gaps: SkillGap[] = [];
  for (const [termKey, { termDisplay, requirementIds }] of byKey) {
    const answer = answerByKey.get(termKey);
    const liveAlias = answer?.status === "alias" && answer.aliasSkillName !== null && profileByKey.has(normalizeTermKey(answer.aliasSkillName));
    let state: SkillGapState;
    if (answer?.status === "have" || liveAlias || containsTerm(haystack, termKey)) state = "covered";
    else if (answer?.status === "dont_have") state = "declined";
    else state = "unanswered";
    gaps.push({
      termKey, termDisplay, requirementIds: [...requirementIds].sort(), state,
      suggestion: state === "unanswered" ? suggestionFor(termKey, answer, profileByKey) : null,
    });
  }
  return gaps.sort((a, b) => (a.termKey < b.termKey ? -1 : a.termKey > b.termKey ? 1 : 0));
}

function suggestionFor(termKey: string, answer: SkillVerificationForGaps | undefined, profileByKey: Map<string, string>): string | null {
  if (answer?.status === "alias" && answer.aliasSkillName) return answer.aliasSkillName;
  for (const key of aliasGroupOf(termKey) ?? []) {
    const name = key === termKey ? undefined : profileByKey.get(key);
    if (name) return name;
  }
  return null;
}
```

Append to `index.ts`:

```ts
export { computeSkillGaps, type SkillGap, type SkillGapState, type SkillVerificationForGaps } from "./gaps/computeSkillGaps";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @ai-career/resume-optimization test -- gaps`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/resume-optimization/src/gaps packages/resume-optimization/src/index.ts
git commit -m "feat(gaps): computeSkillGaps classifies covered/declined/unanswered with alias suggestions (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `verified_skill` in the resume evidence catalog

**Files:**
- Modify: `packages/resume-optimization/src/optimization/buildResumeSnapshot.ts`
- Modify: `packages/resume-optimization/src/optimization/buildResumeSnapshot.test.ts`
- Modify: `packages/resume-optimization/src/optimization/optimizeResume.ts` (one prompt sentence)
- Modify: `packages/resume-optimization/src/pipeline/runResumeOptimization.test.ts`

**Interfaces:**
- Consumes: `schema.skillVerifications` (Task 2), `normalizeTermKey` (Task 3).
- Produces: `EvidenceSourceType` gains `"verified_skill"`. Catalog entries: "have" → `{ sourceFactId: <verification id>, sourceType: "verified_skill", text: "<termDisplay>: <evidence>", context: "Verified by you" }`; live alias → same with `text: "<termDisplay> (same as <aliasSkillName>)"`; appended after skills, ordered by `term_key`.

- [ ] **Step 1: Write the failing tests** (append to the `describe` in `buildResumeSnapshot.test.ts`; uses its existing `USER`, `testDb`)

```ts
  it("adds 'have' answers and live aliases as verified_skill evidence, never 'dont_have' or stale aliases", async () => {
    await testDb.adminSql`INSERT INTO skills (user_id, name) VALUES (${USER}, 'Postgres')`;
    await testDb.adminSql`
      INSERT INTO skill_verifications (user_id, term_key, term_display, status, evidence, alias_skill_name) VALUES
        (${USER}, 'kubernetes', 'Kubernetes', 'have', 'Ran our staging cluster for a year.', NULL),
        (${USER}, 'postgresql', 'PostgreSQL', 'alias', NULL, 'Postgres'),
        (${USER}, 'mysql', 'MySQL', 'alias', NULL, 'MariaDB'),
        (${USER}, 'dbt', 'dbt', 'dont_have', NULL, NULL)`;

    const { catalog } = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));

    expect(catalog.filter((e) => e.sourceType === "verified_skill")).toEqual([
      { sourceFactId: expect.any(String), sourceType: "verified_skill", text: "Kubernetes: Ran our staging cluster for a year.", context: "Verified by you" },
      { sourceFactId: expect.any(String), sourceType: "verified_skill", text: "PostgreSQL (same as Postgres)", context: "Verified by you" },
    ]);
  });

  it("changes the content hash when an answer is added", async () => {
    const before = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
    await testDb.adminSql`
      INSERT INTO skill_verifications (user_id, term_key, term_display, status, evidence) VALUES (${USER}, 'rust', 'Rust', 'have', 'Wrote a CLI.')`;
    const after = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
    expect(after.contentHash).not.toBe(before.contentHash);
  });
```

In `runResumeOptimization.test.ts`, add one case next to the existing happy-path test, following that file's own seeding helpers and fake-client setup: seed one `have` verification (`'kubernetes', 'Kubernetes', 'have', 'Ran our staging cluster for a year.'`), make the fake optimizer answer cite that verification's id with `changeType: "unchanged"`, run, and assert:

```ts
    expect(result.optimization.selectedBullets).toEqual([
      expect.objectContaining({ sourceFactId: verificationId, sourceType: "verified_skill", originalText: "Kubernetes: Ran our staging cluster for a year." }),
    ]);
    expect(result.optimization.rejectedClaims).toEqual([]);
```

(Read the verification id back with `SELECT id FROM skill_verifications WHERE user_id = ${USER}`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ai-career/resume-optimization test -- buildResumeSnapshot runResumeOptimization`
Expected: FAIL (no `verified_skill` entries; the cited id is rejected as unknown).

- [ ] **Step 3: Implement**

In `buildResumeSnapshot.ts`:
- Extend the destructure: `const { workExperiences, …, skills, skillVerifications } = schema;` and import `normalizeTermKey` from `"../gaps/normalizeTermKey"`.
- Add `| "verified_skill"` to `EvidenceSourceType`.
- Add `tx.select().from(skillVerifications).orderBy(asc(skillVerifications.termKey))` as the eighth query in the `Promise.all` (destructure as `verificationRows`).
- After the skills loop:

```ts
  // Phase 13b: the user's own answers. A "have" carries their evidence sentence; an alias counts only while the
  // profile skill it names still exists (saveProfile re-creates skills, so it is matched by name, not id).
  const profileSkillKeys = new Set(skillRows.map((s) => normalizeTermKey(s.name)));
  for (const v of verificationRows) {
    if (v.status === "have" && v.evidence) {
      catalog.push({ sourceFactId: v.id, sourceType: "verified_skill", text: `${v.termDisplay}: ${v.evidence}`, context: "Verified by you" });
    } else if (v.status === "alias" && v.aliasSkillName && profileSkillKeys.has(normalizeTermKey(v.aliasSkillName))) {
      catalog.push({ sourceFactId: v.id, sourceType: "verified_skill", text: `${v.termDisplay} (same as ${v.aliasSkillName})`, context: "Verified by you" });
    }
  }
```

- Update the doc comment: "six tables" → "the six profile tables plus skill_verifications (Phase 13b)".

In `optimizeResume.ts`, in the instruction string near "Never invent a skill…" (~line 78), add one sentence:

```ts
      `Entries of type "verified_skill" are skills the candidate confirmed themselves; cite them like any other entry. ` +
```

- [ ] **Step 4: Run the package tests, typecheck and lint**

Run: `pnpm --filter @ai-career/resume-optimization test && pnpm --filter @ai-career/resume-optimization typecheck && pnpm --filter @ai-career/resume-optimization lint`
Expected: PASS. Then `pnpm typecheck` at the root — fix any exhaustive `Record<EvidenceSourceType, …>` the compiler reports (none were found during planning).

- [ ] **Step 5: Commit**

```bash
git add packages/resume-optimization
git commit -m "feat(resume): verified skills become citable verified_skill evidence (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Top-match selection and post-matching requirements extraction

**Files:**
- Create: `packages/resume-optimization/src/gaps/topMatchRequirements.ts` (+ `.test.ts`)
- Modify: `packages/resume-optimization/src/index.ts`

**Interfaces:**
- Consumes: `ensureJobRequirements`, `JobForRequirements`; `schema.jobMatches`, `schema.jobs`; `AiBudgetExceededError`, `AnthropicFor` from `@ai-career/ai`; `withUserContext` from `@ai-career/db`.
- Produces:

```ts
export interface TopMatchJob extends JobForRequirements { companyName: string }
export function selectTopMatchJobs(tx: DbClient, limit: number): Promise<TopMatchJob[]>;
export interface TopMatchRequirementsResult { jobs: number; failed: number; budgetStopped: boolean }
export function ensureTopMatchRequirements(db: DbClient, opts: {
  userId: string; env: { ANTHROPIC_MODEL_FAST: string; SKILL_GAP_TOP_N: number }; anthropicFor: AnthropicFor;
  onJobError?: (jobId: string, error: unknown) => void;
}): Promise<TopMatchRequirementsResult>;
```

- [ ] **Step 1: Write the failing test** — `topMatchRequirements.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { withUserContext } from "@ai-career/db";
import { AiBudgetExceededError, type AnthropicFor } from "@ai-career/ai";
import { openTestDb, wipeUser, type TestDb } from "../testing/db";
import { ensureTopMatchRequirements, selectTopMatchJobs } from "./topMatchRequirements";

// Phase 13b test user (…0d12); verify unused with grep first.
const USER = "00000000-0000-0000-0000-000000000d12";
let t: TestDb;
beforeAll(async () => { t = await openTestDb(); });
afterAll(() => t.close());
beforeEach(() => wipeUser(t.adminSql, USER));

async function seedMatch(title: string, score: number | null, opts: { eligible?: boolean; status?: "open" | "closed" } = {}) {
  const [goal] = await t.adminSql`
    INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
    VALUES (${USER}, 'g', 1, 'parsed', 'confirmed', false) RETURNING id`;
  const [job] = await t.adminSql`
    INSERT INTO jobs (user_id, company_name, company_key, title, title_key, description_text, description_hash, status, first_seen_at, last_verified_at)
    VALUES (${USER}, 'Acme', 'acme', ${title}, ${title.toLowerCase()}, 'Needs Kubernetes.', ${"h-" + title}, ${opts.status ?? "open"}, now(), now())
    RETURNING id`;
  await t.adminSql`
    INSERT INTO job_matches (user_id, job_id, career_goal_id, eligible, overall_score, computed_at)
    VALUES (${USER}, ${job.id}, ${goal.id}, ${opts.eligible ?? true}, ${score}, now())`;
  return job.id as string;
}

const toolAnswer = {
  content: [{ type: "tool_use", id: "t1", name: "record_job_requirements",
    input: { requirements: [{ termText: "Kubernetes", termType: "tool", requirementLevel: "required", evidenceQuote: null }] } }],
  stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
};
const ENV = { ANTHROPIC_MODEL_FAST: "fast-model", SKILL_GAP_TOP_N: 2 };

describe("selectTopMatchJobs", () => {
  it("returns open, eligible matches by score, highest first, up to the limit", async () => {
    const low = await seedMatch("Low", 50);
    const high = await seedMatch("High", 90);
    await seedMatch("Mid", 70);
    await seedMatch("Closed", 99, { status: "closed" });
    await seedMatch("Ineligible", null, { eligible: false });
    const jobs = await withUserContext(t.db, USER, (tx) => selectTopMatchJobs(tx, 2));
    expect(jobs.map((j) => j.title)).toEqual(["High", "Mid"]);
    expect(jobs[0]).toMatchObject({ id: high, companyName: "Acme", descriptionHash: "h-High" });
    expect(jobs.map((j) => j.id)).not.toContain(low);
  });
});

describe("ensureTopMatchRequirements", () => {
  it("extracts only for jobs without fresh requirements", async () => {
    await seedMatch("A", 90);
    await seedMatch("B", 80);
    const create = vi.fn(async () => toolAnswer);
    const anthropicFor: AnthropicFor = () => ({ messages: { create } }) as never;
    const first = await ensureTopMatchRequirements(t.db, { userId: USER, env: ENV, anthropicFor });
    expect(first).toEqual({ jobs: 2, failed: 0, budgetStopped: false });
    expect(create).toHaveBeenCalledTimes(2);
    await ensureTopMatchRequirements(t.db, { userId: USER, env: ENV, anthropicFor });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("skips a failing job and reports it, then stops at the AI budget", async () => {
    const a = await seedMatch("A", 90);
    await seedMatch("B", 80);
    const onJobError = vi.fn();
    const failing: AnthropicFor = () => ({ messages: { create: vi.fn(async () => { throw new Error("boom"); }) } }) as never;
    expect(await ensureTopMatchRequirements(t.db, { userId: USER, env: ENV, anthropicFor: failing, onJobError }))
      .toEqual({ jobs: 2, failed: 2, budgetStopped: false });
    expect(onJobError).toHaveBeenCalledWith(a, expect.any(Error));

    const create = vi.fn(async () => { throw new AiBudgetExceededError(20, 20); });
    const broke: AnthropicFor = () => ({ messages: { create } }) as never;
    expect(await ensureTopMatchRequirements(t.db, { userId: USER, env: ENV, anthropicFor: broke }))
      .toEqual({ jobs: 2, failed: 0, budgetStopped: true });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
```

Before running: open `packages/ai/src/usage/budget.ts` and use `AiBudgetExceededError`'s real constructor arguments in place of `(20, 20)`; open `extractJobRequirements.test.ts` and, if its fake response shape differs from `toolAnswer`, copy that shape instead.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ai-career/resume-optimization test -- topMatchRequirements`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `topMatchRequirements.ts`

```ts
import { and, asc, eq, sql } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { AiBudgetExceededError, type AnthropicFor } from "@ai-career/ai";
import { ensureJobRequirements, type JobForRequirements } from "../requirements/ensureJobRequirements";

const { jobMatches, jobs } = schema;

export interface TopMatchJob extends JobForRequirements {
  companyName: string;
}

/** Phase 13b: the jobs /skills lists gaps for -- open, eligible matches, highest score first (ties by job id). */
export async function selectTopMatchJobs(tx: DbClient, limit: number): Promise<TopMatchJob[]> {
  return tx
    .select({
      id: jobs.id, title: jobs.title, companyName: jobs.companyName,
      descriptionText: jobs.descriptionText, descriptionHash: jobs.descriptionHash,
    })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobMatches.jobId, jobs.id))
    .where(and(eq(jobMatches.eligible, true), eq(jobs.status, "open")))
    .orderBy(sql`${jobMatches.overallScore} DESC NULLS LAST`, asc(jobs.id))
    .limit(limit);
}

export interface TopMatchRequirementsResult {
  jobs: number;
  failed: number;
  budgetStopped: boolean;
}

/**
 * Phase 13b design §6.1 (R3: called after the matching job completes, never inside it). One transaction per job, as
 * runResumeOptimization does, so a request that dies mid-write never leaves job_requirements half-replaced (D58).
 * ensureJobRequirements is a no-op for a job whose requirements match its description hash. A job's failure is
 * reported and skipped; the AI budget stops the remaining jobs.
 */
export async function ensureTopMatchRequirements(
  db: DbClient,
  opts: {
    userId: string;
    env: { ANTHROPIC_MODEL_FAST: string; SKILL_GAP_TOP_N: number };
    anthropicFor: AnthropicFor;
    onJobError?: (jobId: string, error: unknown) => void;
  }
): Promise<TopMatchRequirementsResult> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, opts.userId, fn);
  const top = await inUserContext((tx) => selectTopMatchJobs(tx, opts.env.SKILL_GAP_TOP_N));
  let failed = 0;
  for (const job of top) {
    try {
      await inUserContext((tx) => ensureJobRequirements(tx, opts.env, opts.anthropicFor("job_requirements_extraction"), job));
    } catch (error) {
      if (error instanceof AiBudgetExceededError) return { jobs: top.length, failed, budgetStopped: true };
      failed++;
      opts.onJobError?.(job.id, error);
    }
  }
  return { jobs: top.length, failed, budgetStopped: false };
}
```


Append to `index.ts`:

```ts
export {
  selectTopMatchJobs, ensureTopMatchRequirements, type TopMatchJob, type TopMatchRequirementsResult,
} from "./gaps/topMatchRequirements";
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @ai-career/resume-optimization test && pnpm --filter @ai-career/resume-optimization lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/resume-optimization
git commit -m "feat(gaps): extract requirements for the top eligible matches (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Matching worker runs the requirements step after each run

**Files:**
- Create: `services/matching-worker/src/requirementsRefresh.ts` (+ `.test.ts`)
- Modify: `services/matching-worker/src/main.ts`
- Modify: `services/matching-worker/package.json` (add `"@ai-career/resume-optimization": "workspace:*"`), then `pnpm install`

**Interfaces:**
- Consumes: `ensureTopMatchRequirements` (Task 6).
- Produces: `createRequirementsRefresh(deps: { run: (userId: string) => Promise<void>; onError: (error: unknown) => void }): (userId: string | undefined) => Promise<void>` — single-flight per user; a call while one is running schedules exactly one more pass.

- [ ] **Step 1: Write the failing test** — `requirementsRefresh.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { createRequirementsRefresh } from "./requirementsRefresh";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("createRequirementsRefresh", () => {
  it("ignores a missing user id", async () => {
    const run = vi.fn(async () => undefined);
    await createRequirementsRefresh({ run, onError: vi.fn() })(undefined);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs once per user at a time and once more if asked while running", async () => {
    const gate = deferred();
    const run = vi.fn(async () => { if (run.mock.calls.length === 1) await gate.promise; });
    const refresh = createRequirementsRefresh({ run, onError: vi.fn() });
    const first = refresh("u1");
    void refresh("u1");
    void refresh("u1");
    gate.resolve();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs different users independently", async () => {
    const run = vi.fn(async () => undefined);
    const refresh = createRequirementsRefresh({ run, onError: vi.fn() });
    await Promise.all([refresh("u1"), refresh("u2")]);
    expect(run.mock.calls.map((c) => c[0]).sort()).toEqual(["u1", "u2"]);
  });

  it("reports an error and never rejects; the next call runs again", async () => {
    const onError = vi.fn();
    const run = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue(undefined);
    const refresh = createRequirementsRefresh({ run, onError });
    await expect(refresh("u1")).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    await refresh("u1");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @ai-career/matching-worker test -- requirementsRefresh`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `requirementsRefresh.ts`

```ts
/**
 * Phase 13b (R3): after a matching run completes, extract requirements for the top matches -- outside the BullMQ job,
 * so a search run waiting on matching (Phase 13a) is never delayed by these AI calls. One pass per user at a time; a
 * request during a pass schedules exactly one more (new matches may have arrived). Never rejects.
 */
export function createRequirementsRefresh(deps: { run: (userId: string) => Promise<void>; onError: (error: unknown) => void }) {
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();

  const start = (userId: string): Promise<void> => {
    const pass = (async () => {
      try {
        do {
          again.delete(userId);
          await deps.run(userId);
        } while (again.has(userId));
      } catch (error) {
        again.delete(userId);
        deps.onError(error);
      } finally {
        running.delete(userId);
      }
    })();
    running.set(userId, pass);
    return pass;
  };

  return (userId: string | undefined): Promise<void> => {
    if (!userId) return Promise.resolve();
    const current = running.get(userId);
    if (current) {
      again.add(userId);
      return current;
    }
    return start(userId);
  };
}
```

- [ ] **Step 4: Wire it in `main.ts`**

Add imports:

```ts
import { ensureTopMatchRequirements } from "@ai-career/resume-optimization";
import { createRequirementsRefresh } from "./requirementsRefresh";
```

After `const followUp = createFollowUp(...)`:

```ts
  // Phase 13b (R3): requirements for the top matches, so /skills can list their missing skills. Logs carry ids, counts
  // and error class names only -- never job text.
  const errorClass = (error: unknown) => (error instanceof Error ? error.name : "unknown");
  const refreshRequirements = createRequirementsRefresh({
    run: async (userId) => {
      const { anthropicFor } = aiFor(userId);
      const result = await ensureTopMatchRequirements(db, {
        userId, env, anthropicFor,
        onJobError: (jobId, error) => log.warn("requirements_failed", { jobId, errorClass: errorClass(error) }),
      });
      log.info("requirements_checked", { ...result });
    },
    onError: (error) => log.error("requirements_refresh_failed", { errorClass: errorClass(error) }),
  });
```

After the existing `worker.on("completed", (job) => void followUp(job.data.userId));`:

```ts
  worker.on("completed", (job) => void refreshRequirements(job.data.userId));
```

Add `"@ai-career/resume-optimization": "workspace:*"` to `services/matching-worker/package.json` dependencies (alphabetical), run `pnpm install`.

- [ ] **Step 5: Run the worker tests, typecheck and lint**

Run: `pnpm --filter @ai-career/matching-worker test && pnpm --filter @ai-career/matching-worker typecheck && pnpm --filter @ai-career/matching-worker lint`
Expected: PASS (the existing `worker.test.ts` is unaffected: the step lives in `main.ts`).

- [ ] **Step 6: Commit**

```bash
git add services/matching-worker pnpm-lock.yaml
git commit -m "feat(matching-worker): check top matches' requirements after each run (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Verified skills in the exported resume

**Files:**
- Modify: `packages/document-export/src/model/resumeProfile.ts`
- Modify: `packages/document-export/src/pipeline/loadResumeProfile.ts`
- Modify: `packages/document-export/src/model/buildResumeModel.ts`
- Modify: `packages/document-export/src/model/buildResumeModel.test.ts`
- Modify: `packages/document-export/src/pipeline/exportResume.test.ts`
- Modify: any other test/fixture constructing a `ResumeProfile` literal (the compiler lists them) — add `verifiedSkills: []`

**Interfaces:**
- Consumes: `schema.skillVerifications`, `normalizeTermKey`.
- Produces: `ResumeProfile.verifiedSkills: { id: string; term: string }[]` (have rows + live aliases, `term_key` order — the same set `buildResumeSnapshot` puts in the catalog).

- [ ] **Step 1: Write the failing tests** (in `buildResumeModel.test.ts`, using its existing profile fixture builder — add `verifiedSkills` to it)

```ts
  it("renders verified skills in the Skills section, selected ones first, using the job's term (R4)", () => {
    const profile = { ...baseProfile(), skills: [{ id: "s1", name: "SQL" }], verifiedSkills: [{ id: "v1", term: "Docker" }, { id: "v2", term: "Kubernetes" }] };
    const applied = [{ sourceFactId: "v2", sourceType: "verified_skill" as const, originalText: "Kubernetes: Ran it.", optimizedText: "x", changeType: "unchanged" as const, justification: "j" }];
    const model = buildResumeModel(profile, applied);
    const i = model.blocks.findIndex((b) => b.type === "heading" && b.text === "Skills");
    expect(model.blocks[i + 1]).toEqual({ type: "paragraph", text: "SQL, Kubernetes, Docker" });
  });

  it("shows the Skills section when only verified skills exist", () => {
    const model = buildResumeModel({ ...baseProfile(), skills: [], verifiedSkills: [{ id: "v1", term: "Docker" }] }, []);
    expect(model.blocks).toContainEqual({ type: "paragraph", text: "Docker" });
  });

  it("still rejects a verified_skill id that is not in the profile", () => {
    const applied = [{ sourceFactId: "nope", sourceType: "verified_skill" as const, originalText: "", optimizedText: "", changeType: "unchanged" as const, justification: "" }];
    expect(() => buildResumeModel({ ...baseProfile(), verifiedSkills: [] }, applied)).toThrow(/unknown source fact/);
  });
```

(If the fixture builder is named differently, use it; keep the assertions.) In `exportResume.test.ts`, add one case: seed a `have` verification for the fixture user, insert an optimization whose `selected_bullets` cites it (`sourceType: "verified_skill"`) **after** seeding (so `source_profile_content_hash` is computed from a snapshot that includes it — use the file's existing `insertOptimization` helper, which hashes the current snapshot), export, and assert success (`profile_changed` must not be thrown).

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @ai-career/document-export test -- buildResumeModel exportResume`
Expected: FAIL (`unknown source fact v2`; missing paragraph).

- [ ] **Step 3: Implement**

`resumeProfile.ts` — add to `ResumeProfile`, after `skills`:

```ts
  /** Phase 13b: skills the user verified (a "have" answer, or an alias to a skill still in the profile), as the job wrote them. */
  verifiedSkills: { id: string; term: string }[];
```

`loadResumeProfile.ts` — add `skillVerifications` to the destructure, import `normalizeTermKey` from `@ai-career/resume-optimization`, add the query `tx.select().from(skillVerifications).orderBy(asc(skillVerifications.termKey))` to the `Promise.all` (as `verifs`), and return:

```ts
    // Same set buildResumeSnapshot puts in the catalog (have rows and live aliases), so applied ids always resolve.
    verifiedSkills: verifs
      .filter((v) => (v.status === "have" && v.evidence !== null)
        || (v.status === "alias" && v.aliasSkillName !== null && skls.some((s) => normalizeTermKey(s.name) === normalizeTermKey(v.aliasSkillName!))))
      .map((v) => ({ id: v.id, term: v.termDisplay })),
```

`buildResumeModel.ts`:
- Add to `knownIds`: `...profile.verifiedSkills.map((v) => \`verified_skill:${v.id}\`),`
- Replace the Skills block with:

```ts
  if (profile.skills.length > 0 || profile.verifiedSkills.length > 0) {
    blocks.push({ type: "heading", text: "Skills" });
    // Names only, never the optimizer's text: profile skills in selection order, then verified skills (Phase 13b, R4)
    // in selection order, each list followed by its unselected items.
    const ordered = [
      ...selectedFirst(profile.skills, applied, "skill", (s) => s.name).map(({ item }) => item.name),
      ...selectedFirst(profile.verifiedSkills, applied, "verified_skill", (v) => v.term).map(({ item }) => item.term),
    ];
    blocks.push({ type: "paragraph", text: ordered.join(", ") });
  }
```

- Update the function's doc comment: "Education, certifications and skill names are never reworded" → "…skill names and verified skill terms are never reworded".

Fix every `ResumeProfile` literal the compiler flags (`pnpm --filter @ai-career/document-export typecheck`) by adding `verifiedSkills: []`.

- [ ] **Step 4: Run the package tests, typecheck and lint**

Run: `pnpm --filter @ai-career/document-export test && pnpm --filter @ai-career/document-export typecheck && pnpm --filter @ai-career/document-export lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/document-export
git commit -m "feat(export): verified skills in the resume's Skills section (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Skill-gap read model and read routes

**Files:**
- Create: `apps/web/src/lib/skillGaps/loadSkillGaps.ts` (+ `.test.ts`)
- Create: `apps/web/src/app/api/skill-gaps/route.ts` (+ `route.test.ts`)
- Create: `apps/web/src/app/api/skill-gaps/[jobId]/route.ts` (+ `route.test.ts`)
- Create: `apps/web/src/app/api/skill-gaps/[jobId]/requirements/route.ts` (+ `route.test.ts`)
- Modify: `apps/web/src/lib/http/rateLimitedRoutes.test.ts` (registry)
- Modify: `apps/web/package.json` only if `@ai-career/resume-optimization` is not already a dependency (it is used by `/api/resume-optimizations`, so it should be)

**Interfaces:**
- Consumes: `selectTopMatchJobs`, `computeSkillGaps`, `buildResumeSnapshot`, `ensureJobRequirements`, `JobRequirementExtractionValidationError` (resume-optimization); `schema.skillVerifications`, `schema.jobRequirements`, `schema.skills`, `schema.jobMatches`, `schema.jobs`.
- Produces (JSON shapes the UI tasks rely on):

```ts
export interface GapJobRef { jobId: string; title: string; companyName: string }
export interface UnansweredGapView { termKey: string; termDisplay: string; suggestion: string | null; jobCount: number; jobs: GapJobRef[] }
export interface VerificationView {
  id: string; termKey: string; termDisplay: string; status: "have" | "dont_have" | "alias";
  evidence: string | null; aliasSkillName: string | null; updatedAt: string;
}
export interface SkillGapsOverview {
  topN: number; unanswered: UnansweredGapView[]; answered: VerificationView[]; jobsWithoutRequirements: number; profileSkills: string[];
}
export interface JobSkillGapsView {
  requirementsStatus: "ready" | "missing";
  unanswered: { termKey: string; termDisplay: string; suggestion: string | null }[];
  coveredCount: number; declinedCount: number; profileSkills: string[];
}
export function loadSkillGapsOverview(tx: DbClient, topN: number): Promise<SkillGapsOverview>;
export function loadJobSkillGaps(tx: DbClient, jobId: string): Promise<JobSkillGapsView | null>; // null: no match row
export function toVerificationView(row: typeof schema.skillVerifications.$inferSelect): VerificationView;
```

Routes:
- `GET /api/skill-gaps` → `200 SkillGapsOverview` (empty lists when there are no matches).
- `GET /api/skill-gaps/[jobId]` → `200 JobSkillGapsView`; `404 { error: "Job not found" }` for a non-uuid or a job with no `job_matches` row.
- `POST /api/skill-gaps/[jobId]/requirements` → runs `ensureJobRequirements` for that job, then `200 JobSkillGapsView`; `404` as above; budget → `budgetExceededResponse`; `Anthropic.APIError` / `JobRequirementExtractionValidationError` → `502 { error: "Could not check this job's requirements. Try again." }`. Rate-limited `"ai"`.

- [ ] **Step 1: Write the failing read-model test** — `apps/web/src/lib/skillGaps/loadSkillGaps.test.ts`

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { createDbClient, closeDbClient, withUserContext, type DbClient } from "@ai-career/db";
import { openAdminDb, wipeMatchingData, insertCareerGoal, insertJob, insertMatch } from "../../test/jobsDb";
import { loadJobSkillGaps, loadSkillGapsOverview } from "./loadSkillGaps";

// Phase 13b test user (…0d13); verify unused with grep first.
const USER = "00000000-0000-0000-0000-000000000d13";
let admin: postgres.Sql;
let db: DbClient;
const wipe = async () => {
  await admin`DELETE FROM skills WHERE user_id = ${USER}`;
  await wipeMatchingData(admin, USER);
};
beforeAll(async () => {
  admin = await openAdminDb();
  db = createDbClient({ DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test" });
});
beforeEach(wipe);
afterAll(async () => { await wipe(); await admin.end(); await closeDbClient(db); });

async function jobWith(title: string, score: number, terms: string[]) {
  const goal = await insertCareerGoal(admin, USER, { isActive: false });
  const jobId = await insertJob(admin, USER, { title });
  await insertMatch(admin, USER, jobId, goal, { overallScore: score });
  for (const term of terms) {
    await admin`
      INSERT INTO job_requirements (user_id, job_id, term_text, term_type, requirement_level, extraction_model, extraction_source_description_hash)
      VALUES (${USER}, ${jobId}, ${term}, 'tool', 'required', 'm', ${"hash-" + title})`;
  }
  return jobId;
}

describe("loadSkillGapsOverview", () => {
  it("groups unanswered gaps across top jobs, most-blocking first, and counts jobs without requirements", async () => {
    const a = await jobWith("A", 90, ["Kubernetes", "dbt"]);
    const b = await jobWith("B", 80, ["kubernetes "]);
    await jobWith("C", 70, []);
    await admin`INSERT INTO skills (user_id, name) VALUES (${USER}, 'Postgres')`;
    await admin`INSERT INTO skill_verifications (user_id, term_key, term_display, status) VALUES (${USER}, 'dbt', 'dbt', 'dont_have')`;

    const o = await withUserContext(db, USER, (tx) => loadSkillGapsOverview(tx, 25));

    expect(o.unanswered).toEqual([{
      termKey: "kubernetes", termDisplay: "Kubernetes", suggestion: null, jobCount: 2,
      jobs: [{ jobId: a, title: "A", companyName: "Acme" }, { jobId: b, title: "B", companyName: "Acme" }],
    }]);
    expect(o.answered).toEqual([expect.objectContaining({ termKey: "dbt", status: "dont_have" })]);
    expect(o).toMatchObject({ topN: 25, jobsWithoutRequirements: 1, profileSkills: ["Postgres"] });
  });

  it("treats requirements extracted from an older description as missing", async () => {
    const id = await jobWith("A", 90, ["Kubernetes"]);
    await admin`UPDATE jobs SET description_hash = 'changed' WHERE id = ${id}`;
    const o = await withUserContext(db, USER, (tx) => loadSkillGapsOverview(tx, 25));
    expect(o).toMatchObject({ unanswered: [], jobsWithoutRequirements: 1 });
  });
});

describe("loadJobSkillGaps", () => {
  it("returns one job's unanswered gaps with covered and declined counts", async () => {
    const id = await jobWith("A", 90, ["Kubernetes", "dbt", "PostgreSQL", "Python"]);
    await admin`INSERT INTO skills (user_id, name) VALUES (${USER}, 'Python'), (${USER}, 'Postgres')`;
    await admin`INSERT INTO skill_verifications (user_id, term_key, term_display, status) VALUES (${USER}, 'dbt', 'dbt', 'dont_have')`;
    const v = await withUserContext(db, USER, (tx) => loadJobSkillGaps(tx, id));
    expect(v).toEqual({
      requirementsStatus: "ready",
      unanswered: [
        { termKey: "kubernetes", termDisplay: "Kubernetes", suggestion: null },
        { termKey: "postgresql", termDisplay: "PostgreSQL", suggestion: "Postgres" },
      ],
      coveredCount: 1, declinedCount: 1, profileSkills: ["Postgres", "Python"],
    });
  });

  it("says requirements are missing, and returns null for a job without a match", async () => {
    const id = await jobWith("A", 90, []);
    expect(await withUserContext(db, USER, (tx) => loadJobSkillGaps(tx, id))).toMatchObject({ requirementsStatus: "missing", unanswered: [] });
    const lone = await insertJob(admin, USER, { title: "Lone" });
    expect(await withUserContext(db, USER, (tx) => loadJobSkillGaps(tx, lone))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter web test -- loadSkillGaps`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — `apps/web/src/lib/skillGaps/loadSkillGaps.ts`

```ts
import { asc, eq, inArray } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import {
  buildResumeSnapshot, computeSkillGaps, selectTopMatchJobs, type SkillGap,
} from "@ai-career/resume-optimization";

const { jobMatches, jobs, jobRequirements, skills, skillVerifications } = schema;

export interface GapJobRef { jobId: string; title: string; companyName: string }
export interface UnansweredGapView { termKey: string; termDisplay: string; suggestion: string | null; jobCount: number; jobs: GapJobRef[] }
export interface VerificationView {
  id: string; termKey: string; termDisplay: string; status: "have" | "dont_have" | "alias";
  evidence: string | null; aliasSkillName: string | null; updatedAt: string;
}
export interface SkillGapsOverview {
  topN: number; unanswered: UnansweredGapView[]; answered: VerificationView[]; jobsWithoutRequirements: number; profileSkills: string[];
}
export interface JobSkillGapsView {
  requirementsStatus: "ready" | "missing";
  unanswered: { termKey: string; termDisplay: string; suggestion: string | null }[];
  coveredCount: number; declinedCount: number; profileSkills: string[];
}

type RequirementRow = typeof jobRequirements.$inferSelect;

export function toVerificationView(row: typeof skillVerifications.$inferSelect): VerificationView {
  return {
    id: row.id, termKey: row.termKey, termDisplay: row.termDisplay, status: row.status,
    evidence: row.evidence, aliasSkillName: row.aliasSkillName, updatedAt: row.updatedAt.toISOString(),
  };
}

/** Everything computeSkillGaps needs besides the requirements; one read per request. */
async function loadAnswerContext(tx: DbClient) {
  const [snapshot, verifications, skillRows] = await Promise.all([
    buildResumeSnapshot(tx),
    tx.select().from(skillVerifications).orderBy(asc(skillVerifications.termKey)),
    tx.select({ name: skills.name }).from(skills).orderBy(asc(skills.name)),
  ]);
  return { catalog: snapshot.catalog, verifications, profileSkills: skillRows.map((s) => s.name) };
}

/** Requirements count only when every row was extracted from the job's current description (ensureJobRequirements' rule). */
function freshRequirements(rows: RequirementRow[], descriptionHash: string): RequirementRow[] | null {
  return rows.length > 0 && rows.every((r) => r.extractionSourceDescriptionHash === descriptionHash) ? rows : null;
}

function gapsFor(rows: RequirementRow[], ctx: Awaited<ReturnType<typeof loadAnswerContext>>): SkillGap[] {
  return computeSkillGaps(rows, ctx.catalog, ctx.verifications, ctx.profileSkills);
}

/** Phase 13b design §6.2: the /skills page. Unanswered gaps across the top N matches, most-blocking first. */
export async function loadSkillGapsOverview(tx: DbClient, topN: number): Promise<SkillGapsOverview> {
  const ctx = await loadAnswerContext(tx);
  const top = await selectTopMatchJobs(tx, topN);
  const rows = top.length === 0 ? [] : await tx.select().from(jobRequirements).where(inArray(jobRequirements.jobId, top.map((j) => j.id)));

  let jobsWithoutRequirements = 0;
  const byKey = new Map<string, UnansweredGapView>();
  for (const job of top) {
    const fresh = freshRequirements(rows.filter((r) => r.jobId === job.id), job.descriptionHash);
    if (!fresh) {
      jobsWithoutRequirements++;
      continue;
    }
    for (const gap of gapsFor(fresh, ctx)) {
      if (gap.state !== "unanswered") continue;
      const view = byKey.get(gap.termKey) ?? { termKey: gap.termKey, termDisplay: gap.termDisplay, suggestion: gap.suggestion, jobCount: 0, jobs: [] };
      view.jobCount++;
      view.jobs.push({ jobId: job.id, title: job.title, companyName: job.companyName });
      byKey.set(gap.termKey, view);
    }
  }
  const unanswered = [...byKey.values()].sort((a, b) => b.jobCount - a.jobCount || (a.termKey < b.termKey ? -1 : a.termKey > b.termKey ? 1 : 0));
  return { topN, unanswered, answered: ctx.verifications.map(toVerificationView), jobsWithoutRequirements, profileSkills: ctx.profileSkills };
}

/** Phase 13b design §6.2: one job's gaps (any job with a match row, not only the top N). Null when there is no match row. */
export async function loadJobSkillGaps(tx: DbClient, jobId: string): Promise<JobSkillGapsView | null> {
  const [job] = await tx
    .select({ descriptionHash: jobs.descriptionHash })
    .from(jobMatches)
    .innerJoin(jobs, eq(jobMatches.jobId, jobs.id))
    .where(eq(jobMatches.jobId, jobId))
    .limit(1);
  if (!job) return null;
  const ctx = await loadAnswerContext(tx);
  const fresh = freshRequirements(await tx.select().from(jobRequirements).where(eq(jobRequirements.jobId, jobId)), job.descriptionHash);
  if (!fresh) return { requirementsStatus: "missing", unanswered: [], coveredCount: 0, declinedCount: 0, profileSkills: ctx.profileSkills };
  const gaps = gapsFor(fresh, ctx);
  return {
    requirementsStatus: "ready",
    unanswered: gaps.filter((g) => g.state === "unanswered").map(({ termKey, termDisplay, suggestion }) => ({ termKey, termDisplay, suggestion })),
    coveredCount: gaps.filter((g) => g.state === "covered").length,
    declinedCount: gaps.filter((g) => g.state === "declined").length,
    profileSkills: ctx.profileSkills,
  };
}
```

Run `pnpm --filter web test -- loadSkillGaps` → PASS.

- [ ] **Step 4: Write the failing route tests**

`apps/web/src/app/api/skill-gaps/route.test.ts` (same mocking pattern as `api/search-runs/route.test.ts`):

```ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import type postgres from "postgres";
import { openAdminDb, wipeMatchingData } from "../../../test/jobsDb";

// Phase 13b test user (…0d14); verify unused with grep first.
const USER = "00000000-0000-0000-0000-000000000d14";
vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000d14",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    REDIS_URL: "redis://localhost:6379", SKILL_GAP_TOP_N: 25, ANTHROPIC_MODEL_FAST: "fast",
    RATE_LIMIT_AI_PER_MINUTE: 0, RATE_LIMIT_JOBS_PER_MINUTE: 0,
  }),
}));

let admin: postgres.Sql;
beforeAll(async () => { admin = await openAdminDb(); });
beforeEach(() => wipeMatchingData(admin, USER));
afterAll(async () => { await wipeMatchingData(admin, USER); await admin.end(); });

const { GET } = await import("./route");

describe("GET /api/skill-gaps (Phase 13b)", () => {
  it("returns an empty overview when there are no matches", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ topN: 25, unanswered: [], answered: [], jobsWithoutRequirements: 0, profileSkills: [] });
  });
});
```

`apps/web/src/app/api/skill-gaps/[jobId]/route.test.ts` — same header (user `…0d14`), then:

```ts
const { GET } = await import("./route");
const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });

describe("GET /api/skill-gaps/[jobId] (Phase 13b)", () => {
  it("404s for a non-uuid and for a job without a match", async () => {
    expect((await GET(new Request("http://x"), ctx("nope"))).status).toBe(404);
    const jobId = await insertJob(admin, USER, {});
    expect((await GET(new Request("http://x"), ctx(jobId))).status).toBe(404);
  });

  it("returns the job's gaps", async () => {
    const goal = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, {});
    await insertMatch(admin, USER, jobId, goal);
    const res = await GET(new Request("http://x"), ctx(jobId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requirementsStatus: "missing", unanswered: [] });
  });
});
```

(import `insertJob`, `insertCareerGoal`, `insertMatch` from `../../../../test/jobsDb`.)

`apps/web/src/app/api/skill-gaps/[jobId]/requirements/route.test.ts` — same header, plus mock the AI client factory so no network call is made:

```ts
const create = vi.fn();
vi.mock("@ai-career/ai", async (orig) => ({
  ...(await orig<typeof import("@ai-career/ai")>()),
  createAnthropicFor: () => () => ({ messages: { create } }),
}));
const { POST } = await import("./route");

describe("POST /api/skill-gaps/[jobId]/requirements (Phase 13b)", () => {
  it("extracts the job's requirements and returns its gaps", async () => {
    create.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "t", name: "record_job_requirements",
        input: { requirements: [{ termText: "Kubernetes", termType: "tool", requirementLevel: "required", evidenceQuote: null }] } }],
      stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 },
    });
    const goal = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, {});
    await insertMatch(admin, USER, jobId, goal);
    const res = await POST(new Request("http://x", { method: "POST" }), ctx(jobId));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requirementsStatus: "ready", unanswered: [{ termKey: "kubernetes" }] });
  });

  it("answers 502 when the model's answer is invalid", async () => {
    create.mockResolvedValueOnce({ content: [{ type: "text", text: "no" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    const goal = await insertCareerGoal(admin, USER);
    const jobId = await insertJob(admin, USER, {});
    await insertMatch(admin, USER, jobId, goal);
    expect((await POST(new Request("http://x", { method: "POST" }), ctx(jobId))).status).toBe(502);
  });
});
```

If `createUsageSink` needs env keys the mock lacks, add them to the mocked `loadEnv` (copy from `api/resume-optimizations/[jobId]/run/route.test.ts`).

Add to the `LIMITED` registry in `rateLimitedRoutes.test.ts`:

```ts
  "/api/skill-gaps/[jobId]/requirements": { POST: "ai" },
```

- [ ] **Step 5: Run them to verify they fail**

Run: `pnpm --filter web test -- skill-gaps rateLimitedRoutes`
Expected: FAIL (route modules not found).

- [ ] **Step 6: Implement the routes**

`apps/web/src/app/api/skill-gaps/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { loadSkillGapsOverview } from "../../../lib/skillGaps/loadSkillGaps";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";

/** Phase 13b: the /skills page -- unanswered required skills across the top matches, and every answer given. */
async function handleGET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    return NextResponse.json(await withUserContext(db, env.DEFAULT_USER_ID, (tx) => loadSkillGapsOverview(tx, env.SKILL_GAP_TOP_N)));
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/skill-gaps", handleGET);
```

`apps/web/src/app/api/skill-gaps/[jobId]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { loadJobSkillGaps } from "../../../../lib/skillGaps/loadSkillGaps";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleGET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const view = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => loadJobSkillGaps(tx, jobId));
    return view ? NextResponse.json(view) : NextResponse.json({ error: "Job not found" }, { status: 404 });
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/skill-gaps/[jobId]", handleGET);
```

`apps/web/src/app/api/skill-gaps/[jobId]/requirements/route.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { AiBudgetExceededError, createAnthropicFor } from "@ai-career/ai";
import { ensureJobRequirements, JobRequirementExtractionValidationError } from "@ai-career/resume-optimization";
import { loadJobSkillGaps } from "../../../../../lib/skillGaps/loadSkillGaps";
import { createUsageSink } from "../../../../../lib/aiUsage/createUsageSink";
import { budgetExceededResponse } from "../../../../../lib/aiUsage/budgetResponse";
import { withRouteErrors } from "../../../../../lib/http/withRouteErrors";
import { withRateLimit } from "../../../../../lib/http/rateLimit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Job not found" }, { status: 404 });

/** Phase 13b: "Check requirements" for one job -- the same cached extraction the resume optimizer uses. */
async function handlePOST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return notFound();
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const inUserContext = <T>(fn: (tx: typeof db) => Promise<T>) => withUserContext(db, env.DEFAULT_USER_ID, fn);
    const [job] = await inUserContext((tx) =>
      tx.select({ id: schema.jobs.id, title: schema.jobs.title, descriptionText: schema.jobs.descriptionText, descriptionHash: schema.jobs.descriptionHash })
        .from(schema.jobMatches).innerJoin(schema.jobs, eq(schema.jobMatches.jobId, schema.jobs.id))
        .where(eq(schema.jobMatches.jobId, jobId)).limit(1));
    if (!job) return notFound();
    const anthropicFor = createAnthropicFor(env, createUsageSink(db, env));
    await inUserContext((tx) => ensureJobRequirements(tx, env, anthropicFor("job_requirements_extraction"), job));
    const view = await inUserContext((tx) => loadJobSkillGaps(tx, jobId));
    return view ? NextResponse.json(view) : notFound();
  } catch (error) {
    if (error instanceof AiBudgetExceededError) return budgetExceededResponse(error);
    if (error instanceof Anthropic.APIError || error instanceof JobRequirementExtractionValidationError) {
      return NextResponse.json({ error: "Could not check this job's requirements. Try again." }, { status: 502 });
    }
    throw error;
  } finally {
    await closeDbClient(db);
  }
}

export const POST = withRouteErrors("/api/skill-gaps/[jobId]/requirements", withRateLimit("ai", "/api/skill-gaps/[jobId]/requirements", handlePOST));
```

(If `apps/web` does not list `@anthropic-ai/sdk`, check how another web route detects `Anthropic.APIError`, and copy that import.)

- [ ] **Step 7: Run the web tests, typecheck and lint**

Run: `pnpm --filter web test -- skill-gaps loadSkillGaps rateLimitedRoutes allRoutesWrapped && pnpm --filter web typecheck && pnpm --filter web lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/skillGaps apps/web/src/app/api/skill-gaps apps/web/src/lib/http/rateLimitedRoutes.test.ts
git commit -m "feat(web): skill-gap read model and routes (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Answer routes — `PUT /api/skill-verifications`, `DELETE /api/skill-verifications/[id]`

**Files:**
- Create: `apps/web/src/lib/skillGaps/verificationBody.ts` (+ `.test.ts`)
- Create: `apps/web/src/lib/skillGaps/saveVerification.ts`
- Create: `apps/web/src/app/api/skill-verifications/route.ts` (+ `route.test.ts`)
- Create: `apps/web/src/app/api/skill-verifications/[id]/route.ts` (+ `route.test.ts`)

**Interfaces:**
- Consumes: `normalizeTermKey`; `toVerificationView` (Task 9); `readJsonBody`, `formatValidationError` (existing `apps/web/src/lib`).
- Produces:
  - `SkillVerificationBodySchema` (zod discriminated union on `status`): `{ status: "have", termDisplay, evidence }` | `{ status: "dont_have", termDisplay }` | `{ status: "alias", termDisplay, aliasSkillName }` — strings trimmed; `termDisplay`/`aliasSkillName` 1–200, `evidence` 1–300; unknown keys rejected (`.strict()`).
  - `saveVerification(tx, body): Promise<{ kind: "saved"; verification: VerificationView } | { kind: "unknown_skill" }>` — upsert by `(user_id, term_key)`, last write wins; an alias must name a current profile skill (matched by `normalizeTermKey`), stored with the profile's spelling.
  - `PUT /api/skill-verifications` → `200 { verification }`; `400` invalid JSON/body; `422 { error: "Pick one of your profile skills" }`.
  - `DELETE /api/skill-verifications/[id]` → `204`; `404` if not found or non-uuid.
  - Neither route is rate-limited (no AI, no background work — D178's rule).

- [ ] **Step 1: Write the failing tests**

`verificationBody.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SkillVerificationBodySchema } from "./verificationBody";

const ok = (v: unknown) => SkillVerificationBodySchema.safeParse(v).success;

describe("SkillVerificationBodySchema", () => {
  it("accepts the three answers and trims", () => {
    expect(SkillVerificationBodySchema.parse({ status: "have", termDisplay: " CI/CD ", evidence: " Set up GitHub Actions. " }))
      .toEqual({ status: "have", termDisplay: "CI/CD", evidence: "Set up GitHub Actions." });
    expect(ok({ status: "dont_have", termDisplay: "C#" })).toBe(true);
    expect(ok({ status: "alias", termDisplay: "PostgreSQL", aliasSkillName: "Postgres" })).toBe(true);
  });
  it("rejects a 'have' without evidence, blank or overlong fields, and extra keys", () => {
    expect(ok({ status: "have", termDisplay: "K8s" })).toBe(false);
    expect(ok({ status: "have", termDisplay: "K8s", evidence: "   " })).toBe(false);
    expect(ok({ status: "have", termDisplay: "K8s", evidence: "x".repeat(301) })).toBe(false);
    expect(ok({ status: "dont_have", termDisplay: "" })).toBe(false);
    expect(ok({ status: "dont_have", termDisplay: "x".repeat(201) })).toBe(false);
    expect(ok({ status: "dont_have", termDisplay: "K8s", evidence: "sneaky" })).toBe(false);
    expect(ok({ status: "maybe", termDisplay: "K8s" })).toBe(false);
  });
});
```

`apps/web/src/app/api/skill-verifications/route.test.ts` (header as in Task 9 with user `…0d15`; wipe also `DELETE FROM skills WHERE user_id = ${USER}`):

```ts
const { PUT } = await import("./route");
const put = (body: unknown) => PUT(new Request("http://x/api/skill-verifications", {
  method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
}));
const rows = () => admin`SELECT term_key, term_display, status, evidence, alias_skill_name FROM skill_verifications WHERE user_id = ${USER} ORDER BY term_key`;

describe("PUT /api/skill-verifications (Phase 13b)", () => {
  it("stores answers for punctuated terms under their normalized key", async () => {
    expect((await put({ status: "have", termDisplay: "CI/CD", evidence: "Set up GitHub Actions." })).status).toBe(200);
    expect((await put({ status: "dont_have", termDisplay: "C#" })).status).toBe(200);
    expect(await rows()).toEqual([
      { term_key: "c#", term_display: "C#", status: "dont_have", evidence: null, alias_skill_name: null },
      { term_key: "ci/cd", term_display: "CI/CD", status: "have", evidence: "Set up GitHub Actions.", alias_skill_name: null },
    ]);
  });

  it("replaces an earlier answer for the same term (last write wins)", async () => {
    await put({ status: "dont_have", termDisplay: "Kubernetes" });
    const res = await put({ status: "have", termDisplay: "kubernetes", evidence: "Ran staging." });
    expect(await res.json()).toMatchObject({ verification: { termKey: "kubernetes", status: "have", evidence: "Ran staging." } });
    expect(await rows()).toHaveLength(1);
  });

  it("stores an alias with the profile's spelling, and refuses a skill not in the profile", async () => {
    await admin`INSERT INTO skills (user_id, name) VALUES (${USER}, 'Postgres')`;
    expect((await put({ status: "alias", termDisplay: "PostgreSQL", aliasSkillName: "postgres" })).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ alias_skill_name: "Postgres" });
    expect((await put({ status: "alias", termDisplay: "MySQL", aliasSkillName: "MariaDB" })).status).toBe(422);
  });

  it("answers 400 for invalid JSON or an invalid body", async () => {
    expect((await put("{nope")).status).toBe(400);
    expect((await put({ status: "have", termDisplay: "K8s" })).status).toBe(400);
  });
});
```

`apps/web/src/app/api/skill-verifications/[id]/route.test.ts` (same header):

```ts
const { DELETE } = await import("./route");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("DELETE /api/skill-verifications/[id] (Phase 13b)", () => {
  it("removes an answer, then 404s", async () => {
    const [row] = await admin`
      INSERT INTO skill_verifications (user_id, term_key, term_display, status) VALUES (${USER}, 'dbt', 'dbt', 'dont_have') RETURNING id`;
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx(row.id))).status).toBe(204);
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx(row.id))).status).toBe(404);
    expect((await DELETE(new Request("http://x", { method: "DELETE" }), ctx("nope"))).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter web test -- verificationBody skill-verifications`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`verificationBody.ts`:

```ts
import { z } from "zod";

const termDisplay = z.string().trim().min(1).max(200);

/** Phase 13b: one answer. The server derives term_key from termDisplay (normalizeTermKey) -- the client never sends a key. */
export const SkillVerificationBodySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("have"), termDisplay, evidence: z.string().trim().min(1).max(300) }).strict(),
  z.object({ status: z.literal("dont_have"), termDisplay }).strict(),
  z.object({ status: z.literal("alias"), termDisplay, aliasSkillName: z.string().trim().min(1).max(200) }).strict(),
]);
export type SkillVerificationBody = z.infer<typeof SkillVerificationBodySchema>;
```

`saveVerification.ts`:

```ts
import { sql } from "drizzle-orm";
import { schema, type DbClient } from "@ai-career/db";
import { normalizeTermKey } from "@ai-career/resume-optimization";
import { toVerificationView, type VerificationView } from "./loadSkillGaps";
import type { SkillVerificationBody } from "./verificationBody";

const { skills, skillVerifications } = schema;

/** Upsert by (user, term_key): the last answer wins. An alias must name a current profile skill; its spelling is stored. */
export async function saveVerification(
  tx: DbClient,
  body: SkillVerificationBody
): Promise<{ kind: "saved"; verification: VerificationView } | { kind: "unknown_skill" }> {
  let aliasSkillName: string | null = null;
  if (body.status === "alias") {
    const wanted = normalizeTermKey(body.aliasSkillName);
    const match = (await tx.select({ name: skills.name }).from(skills)).find((s) => normalizeTermKey(s.name) === wanted);
    if (!match) return { kind: "unknown_skill" };
    aliasSkillName = match.name;
  }
  const values = {
    termKey: normalizeTermKey(body.termDisplay),
    termDisplay: body.termDisplay,
    status: body.status,
    evidence: body.status === "have" ? body.evidence : null,
    aliasSkillName,
  };
  const [row] = await tx
    .insert(skillVerifications)
    .values(values)
    .onConflictDoUpdate({
      target: [skillVerifications.userId, skillVerifications.termKey],
      set: { termDisplay: values.termDisplay, status: values.status, evidence: values.evidence, aliasSkillName: values.aliasSkillName, updatedAt: sql`now()` },
    })
    .returning();
  return { kind: "saved", verification: toVerificationView(row) };
}
```

`apps/web/src/app/api/skill-verifications/route.ts` — read the body with the existing `readJsonBody` helper and format errors with `formatValidationError`, copying exactly how an existing PUT/PATCH route uses them (e.g. `apps/web/src/app/api/discovery/providers/[provider]/route.ts` or `api/profile/route.ts`):

```ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { readJsonBody } from "../../../lib/readJsonBody";
import { formatValidationError } from "../../../lib/formatValidationError";
import { SkillVerificationBodySchema } from "../../../lib/skillGaps/verificationBody";
import { saveVerification } from "../../../lib/skillGaps/saveVerification";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";

/** Phase 13b: answer one missing skill. Evidence is user text: stored, never logged. */
async function handlePUT(request: Request) {
  const json = await readJsonBody(request);
  if (!json.ok) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const parsed = SkillVerificationBodySchema.safeParse(json.value);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => saveVerification(tx, parsed.data));
    if (result.kind === "unknown_skill") return NextResponse.json({ error: "Pick one of your profile skills" }, { status: 422 });
    return NextResponse.json({ verification: result.verification });
  } finally {
    await closeDbClient(db);
  }
}

export const PUT = withRouteErrors("/api/skill-verifications", handlePUT);
```

(Adapt the `readJsonBody` result handling to its real return type.)

`apps/web/src/app/api/skill-verifications/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Phase 13b: undo an answer -- the term becomes unanswered again. */
async function handleDELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Answer not found" }, { status: 404 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const deleted = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.delete(schema.skillVerifications).where(eq(schema.skillVerifications.id, id)).returning({ id: schema.skillVerifications.id }));
    return deleted.length === 0 ? NextResponse.json({ error: "Answer not found" }, { status: 404 }) : new NextResponse(null, { status: 204 });
  } finally {
    await closeDbClient(db);
  }
}

export const DELETE = withRouteErrors("/api/skill-verifications/[id]", handleDELETE);
```

- [ ] **Step 4: Run the web tests, typecheck and lint**

Run: `pnpm --filter web test -- verificationBody skill-verifications rateLimitedRoutes allRoutesWrapped && pnpm --filter web typecheck && pnpm --filter web lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/skillGaps apps/web/src/app/api/skill-verifications
git commit -m "feat(web): answer and undo missing-skill questions (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: `/skills` page

**Files:**
- Create: `apps/web/src/app/skills/SkillAnswerForm.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/app/skills/SkillsClient.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/app/skills/page.tsx`
- Modify: `apps/web/src/app/page.tsx` (+ `page.test.tsx`), `apps/web/src/app/matches/page.tsx`

**Interfaces:**
- Consumes: Task 9/10 JSON shapes (`SkillGapsOverview`, `VerificationView`, `PUT`/`DELETE` routes).
- Produces: `SkillAnswerForm({ termDisplay, suggestion, profileSkills, onSaved }: { termDisplay: string; suggestion: string | null; profileSkills: string[]; onSaved: () => void })`; `SKILL_GAPS_CHANGED_EVENT = "skill-gaps-changed"` (dispatched on `window` after every save/undo).

- [ ] **Step 1: Write the failing tests**

`SkillAnswerForm.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SkillAnswerForm, SKILL_GAPS_CHANGED_EVENT } from "./SkillAnswerForm";

const okFetch = () => {
  const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ verification: {} }) } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
};
beforeEach(() => vi.unstubAllGlobals());
const sent = (fn: ReturnType<typeof vi.fn>) => JSON.parse(fn.mock.calls[0][1].body as string);

describe("SkillAnswerForm", () => {
  it("requires evidence before saving 'I have it'", async () => {
    const fetchFn = okFetch();
    const onSaved = vi.fn();
    render(<SkillAnswerForm termDisplay="Kubernetes" suggestion={null} profileSkills={[]} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "I have it" }));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Where you used Kubernetes"), { target: { value: "Ran our staging cluster." } });
    expect(screen.getByText("24/300")).toBeInTheDocument();
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchFn.mock.calls[0][0]).toBe("/api/skill-verifications");
    expect(sent(fetchFn)).toEqual({ status: "have", termDisplay: "Kubernetes", evidence: "Ran our staging cluster." });
  });

  it("saves 'I don't have it' in one click and announces the change", async () => {
    const fetchFn = okFetch();
    const listener = vi.fn();
    window.addEventListener(SKILL_GAPS_CHANGED_EVENT, listener);
    render(<SkillAnswerForm termDisplay="dbt" suggestion={null} profileSkills={[]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "I don't have it" }));
    await waitFor(() => expect(listener).toHaveBeenCalled());
    expect(sent(fetchFn)).toEqual({ status: "dont_have", termDisplay: "dbt" });
    window.removeEventListener(SKILL_GAPS_CHANGED_EVENT, listener);
  });

  it("pre-selects and labels the suggested profile skill for 'Same as…'", async () => {
    const fetchFn = okFetch();
    render(<SkillAnswerForm termDisplay="PostgreSQL" suggestion="Postgres" profileSkills={["Postgres", "Python"]} onSaved={vi.fn()} />);
    expect(screen.getByText(/suggested: Postgres/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Same as…" }));
    expect(screen.getByLabelText("Same as which of your skills")).toHaveValue("Postgres");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(sent(fetchFn)).toEqual({ status: "alias", termDisplay: "PostgreSQL", aliasSkillName: "Postgres" });
  });

  it("shows the server's error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ error: "Pick one of your profile skills" }) } as Response));
    render(<SkillAnswerForm termDisplay="MySQL" suggestion={null} profileSkills={["Postgres"]} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Same as…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick one of your profile skills");
  });
});
```

`SkillsClient.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SkillsClient } from "./SkillsClient";

const overview = {
  topN: 25, jobsWithoutRequirements: 2, profileSkills: ["Postgres"],
  unanswered: [{ termKey: "kubernetes", termDisplay: "Kubernetes", suggestion: null, jobCount: 7,
    jobs: [{ jobId: "j1", title: "Data Engineer", companyName: "Acme" }] }],
  answered: [{ id: "v1", termKey: "dbt", termDisplay: "dbt", status: "dont_have", evidence: null, aliasSkillName: null, updatedAt: "2026-10-19T00:00:00Z" }],
};
const respond = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
beforeEach(() => vi.unstubAllGlobals());

describe("SkillsClient", () => {
  it("lists unanswered skills by how many top jobs they block, and the answered ones", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(overview)));
    render(<SkillsClient />);
    expect(await screen.findByText("Required by 7 of your top 25 matches")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Acme — Data Engineer" })).toHaveAttribute("href", "/matches/j1");
    expect(screen.getByText("2 top matches have no requirements checked yet.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Your answers" })).getByText(/dbt — you don't have it/)).toBeInTheDocument();
  });

  it("undoes an answer and reloads", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(respond(overview)).mockResolvedValueOnce(respond(null, 204)).mockResolvedValueOnce(respond({ ...overview, answered: [] }));
    vi.stubGlobal("fetch", fetchFn);
    render(<SkillsClient />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo dbt" }));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(3));
    expect(fetchFn.mock.calls[1]).toEqual(["/api/skill-verifications/v1", { method: "DELETE" }]);
  });

  it("shows an empty state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ ...overview, unanswered: [], answered: [], jobsWithoutRequirements: 0 })));
    render(<SkillsClient />);
    expect(await screen.findByText(/no unanswered required skills/i)).toBeInTheDocument();
  });
});
```

In `apps/web/src/app/page.test.tsx`, add:

```tsx
    expect(screen.getByRole("link", { name: "5a. Verify skills — confirm the skills your top matches require" })).toHaveAttribute("href", "/skills");
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter web test -- skills page.test`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/web/src/app/skills/SkillAnswerForm.tsx`:

```tsx
"use client";

import { useState } from "react";

/** Dispatched on window after every answer or undo, so other panels on the page (resume notice, job panel) reload. */
export const SKILL_GAPS_CHANGED_EVENT = "skill-gaps-changed";
const MAX_EVIDENCE = 300;

type Mode = "idle" | "have" | "alias";

/** Phase 13b design §7: the three answers to "this job requires <term>". "I have it" needs one evidence sentence. */
export function SkillAnswerForm({ termDisplay, suggestion, profileSkills, onSaved }: {
  termDisplay: string; suggestion: string | null; profileSkills: string[]; onSaved: () => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [evidence, setEvidence] = useState("");
  const [alias, setAlias] = useState(suggestion ?? profileSkills[0] ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (body: Record<string, string>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/skill-verifications", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ termDisplay, ...body }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setError(payload?.error ?? "Could not save your answer.");
        return;
      }
      window.dispatchEvent(new Event(SKILL_GAPS_CHANGED_EVENT));
      onSaved();
    } catch {
      setError("Could not save your answer.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" onClick={() => setMode("have")} disabled={saving} className="rounded border px-2 py-1">I have it</button>
        <button type="button" onClick={() => save({ status: "dont_have" })} disabled={saving} className="rounded border px-2 py-1">I don&apos;t have it</button>
        <button type="button" onClick={() => setMode("alias")} disabled={saving || profileSkills.length === 0} className="rounded border px-2 py-1">Same as…</button>
        {suggestion && <span className="text-gray-600">Suggested: {suggestion}</span>}
      </div>
      {mode === "have" && (
        <div className="flex flex-col gap-1">
          <label className="text-sm" htmlFor={`evidence-${termDisplay}`}>Where you used {termDisplay}</label>
          <textarea
            id={`evidence-${termDisplay}`}
            value={evidence}
            maxLength={MAX_EVIDENCE}
            onChange={(e) => setEvidence(e.target.value)}
            className="rounded border p-2 text-sm"
            rows={2}
          />
          <span className="text-xs text-gray-500">{evidence.length}/{MAX_EVIDENCE}</span>
          <button type="button" onClick={() => save({ status: "have", evidence })} disabled={saving || evidence.trim().length === 0}
            className="self-start rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50">Save</button>
        </div>
      )}
      {mode === "alias" && (
        <div className="flex items-center gap-2">
          <label className="text-sm" htmlFor={`alias-${termDisplay}`}>Same as which of your skills</label>
          <select id={`alias-${termDisplay}`} value={alias} onChange={(e) => setAlias(e.target.value)} className="rounded border p-1 text-sm">
            {profileSkills.map((name) => <option key={name} value={name}>{name}{name === suggestion ? " (suggested)" : ""}</option>)}
          </select>
          <button type="button" onClick={() => save({ status: "alias", aliasSkillName: alias })} disabled={saving || !alias}
            className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50">Save</button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

`apps/web/src/app/skills/SkillsClient.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SkillAnswerForm, SKILL_GAPS_CHANGED_EVENT } from "./SkillAnswerForm";

interface GapJobRef { jobId: string; title: string; companyName: string }
interface UnansweredGapView { termKey: string; termDisplay: string; suggestion: string | null; jobCount: number; jobs: GapJobRef[] }
interface VerificationView {
  id: string; termKey: string; termDisplay: string; status: "have" | "dont_have" | "alias";
  evidence: string | null; aliasSkillName: string | null; updatedAt: string;
}
interface SkillGapsOverview { topN: number; unanswered: UnansweredGapView[]; answered: VerificationView[]; jobsWithoutRequirements: number; profileSkills: string[] }

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; overview: SkillGapsOverview };

function answerText(v: VerificationView): string {
  if (v.status === "have") return `${v.termDisplay} — you have it: ${v.evidence}`;
  if (v.status === "alias") return `${v.termDisplay} — same as ${v.aliasSkillName}`;
  return `${v.termDisplay} — you don't have it`;
}

/** Phase 13b design §7: the batched verification page. */
export function SkillsClient() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [editing, setEditing] = useState<string | null>(null);

  // A promise chain, as in ResumeOptimizationPanel (react-hooks/set-state-in-effect).
  const load = () =>
    fetch("/api/skill-gaps")
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((overview: SkillGapsOverview) => setState({ kind: "ready", overview }))
      .catch(() => setState({ kind: "error" }));

  useEffect(() => {
    load();
  }, []);

  const undo = async (v: VerificationView) => {
    await fetch(`/api/skill-verifications/${v.id}`, { method: "DELETE" }).catch(() => null);
    window.dispatchEvent(new Event(SKILL_GAPS_CHANGED_EVENT));
    await load();
  };

  if (state.kind === "loading") return <p>Loading skills...</p>;
  if (state.kind === "error") return <p role="alert" className="text-red-600">Could not load your skills.</p>;
  const { overview } = state;

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="unanswered-heading" className="flex flex-col gap-4">
        <h2 id="unanswered-heading" className="font-medium">Skills your top matches require</h2>
        {overview.jobsWithoutRequirements > 0 && (
          <p className="text-sm text-gray-600">{overview.jobsWithoutRequirements} top matches have no requirements checked yet.</p>
        )}
        {overview.unanswered.length === 0 ? (
          <p className="text-sm text-gray-600">No unanswered required skills in your top {overview.topN} matches.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {overview.unanswered.map((gap) => (
              <li key={gap.termKey} className="flex flex-col gap-2 rounded border p-3">
                <div className="font-medium">{gap.termDisplay}</div>
                <details className="text-sm">
                  <summary>Required by {gap.jobCount} of your top {overview.topN} matches</summary>
                  <ul className="ml-4 list-disc">
                    {gap.jobs.map((j) => (
                      <li key={j.jobId}><Link href={`/matches/${j.jobId}`} className="underline">{j.companyName} — {j.title}</Link></li>
                    ))}
                  </ul>
                </details>
                <SkillAnswerForm termDisplay={gap.termDisplay} suggestion={gap.suggestion} profileSkills={overview.profileSkills} onSaved={load} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="answered-heading" className="flex flex-col gap-2">
        <h2 id="answered-heading" className="font-medium">Your answers</h2>
        {overview.answered.length === 0 ? (
          <p className="text-sm text-gray-600">No answers yet.</p>
        ) : (
          <ul aria-label="Your answers" className="flex flex-col gap-2 text-sm">
            {overview.answered.map((v) => (
              <li key={v.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span>{answerText(v)}</span>
                  <button type="button" onClick={() => setEditing(editing === v.id ? null : v.id)} className="underline" aria-label={`Change ${v.termDisplay}`}>Change</button>
                  <button type="button" onClick={() => undo(v)} className="underline" aria-label={`Undo ${v.termDisplay}`}>Undo</button>
                </div>
                {editing === v.id && (
                  <SkillAnswerForm termDisplay={v.termDisplay} suggestion={v.aliasSkillName} profileSkills={overview.profileSkills}
                    onSaved={() => { setEditing(null); load(); }} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

`apps/web/src/app/skills/page.tsx`:

```tsx
import { SkillsClient } from "./SkillsClient";

export default function SkillsPage() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-2 text-2xl font-semibold">Verify skills</h1>
      <p className="mb-6 text-sm text-gray-600">
        Required skills your top matches ask for that we couldn&apos;t find in your profile. Answer each once: a skill you
        have — with one sentence on where you used it — can then appear in your resumes and cover letters. Answers do not
        change match scores.
      </p>
      <SkillsClient />
    </main>
  );
}
```

`apps/web/src/app/page.tsx` — after the Matches link:

```tsx
        <Link href="/skills" className="underline">
          5a. Verify skills — confirm the skills your top matches require
        </Link>
```

`apps/web/src/app/matches/page.tsx` — change the intro paragraph to:

```tsx
      <p className="mb-6 text-sm text-gray-600">
        Jobs ranked against your confirmed career goal, with why each one scored the way it did.{" "}
        <Link href="/skills" className="underline">Verify the skills they require</Link>.
      </p>
```

(add `import Link from "next/link";`).

- [ ] **Step 4: Run the web tests, typecheck and lint**

Run: `pnpm --filter web test -- skills page.test MatchesClient && pnpm --filter web typecheck && pnpm --filter web lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/skills apps/web/src/app/page.tsx apps/web/src/app/page.test.tsx apps/web/src/app/matches/page.tsx
git commit -m "feat(web): /skills page to verify missing skills (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Per-job panel and resume notice

**Files:**
- Create: `apps/web/src/app/matches/[jobId]/SkillGapsPanel.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/app/matches/[jobId]/MatchDetailClient.tsx` (render the panel before `ResumeOptimizationPanel`)
- Modify: `apps/web/src/app/matches/[jobId]/ResumeOptimizationPanel.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/app/matches/[jobId]/MatchDetailClient.test.tsx` only if its fetch mock sequence breaks (route the new `/api/skill-gaps/` URL to a stub)

**Interfaces:**
- Consumes: `GET /api/skill-gaps/[jobId]`, `POST /api/skill-gaps/[jobId]/requirements` (Task 9); `SkillAnswerForm`, `SKILL_GAPS_CHANGED_EVENT` (Task 11).
- Produces: `SkillGapsPanel({ jobId }: { jobId: string })`, section with heading "Required skills to verify" and `id="skill-gaps"` (the resume notice links to `#skill-gaps`).

- [ ] **Step 1: Write the failing tests**

`SkillGapsPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SkillGapsPanel } from "./SkillGapsPanel";

const respond = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const ready = {
  requirementsStatus: "ready", coveredCount: 3, declinedCount: 1, profileSkills: ["Postgres"],
  unanswered: [{ termKey: "postgresql", termDisplay: "PostgreSQL", suggestion: "Postgres" }],
};
beforeEach(() => vi.unstubAllGlobals());

describe("SkillGapsPanel", () => {
  it("lists this job's unanswered skills with the answer controls and the counts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(ready)));
    render(<SkillGapsPanel jobId="j1" />);
    expect(await screen.findByText("PostgreSQL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I have it" })).toBeInTheDocument();
    expect(screen.getByText("3 covered by your profile · 1 you don't have")).toBeInTheDocument();
  });

  it("offers to check requirements when they are missing", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(respond({ ...ready, requirementsStatus: "missing", unanswered: [], coveredCount: 0, declinedCount: 0 }))
      .mockResolvedValueOnce(respond(ready));
    vi.stubGlobal("fetch", fetchFn);
    render(<SkillGapsPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check requirements" }));
    expect(await screen.findByText("PostgreSQL")).toBeInTheDocument();
    expect(fetchFn.mock.calls[1]).toEqual(["/api/skill-gaps/j1/requirements", { method: "POST" }]);
  });

  it("says when every required skill is answered", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond({ ...ready, unanswered: [] })));
    render(<SkillGapsPanel jobId="j1" />);
    expect(await screen.findByText("Every required skill is covered or answered.")).toBeInTheDocument();
  });

  it("shows a failed check's error", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(respond({ ...ready, requirementsStatus: "missing", unanswered: [] }))
      .mockResolvedValueOnce(respond({ error: "Could not check this job's requirements. Try again." }, 502)));
    render(<SkillGapsPanel jobId="j1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Check requirements" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check this job's requirements");
  });
});
```

In `ResumeOptimizationPanel.test.tsx`, add (adapting to its fetch-mock helper; the panel now makes two GETs on mount — optimizations and skill gaps — so route by URL):

```tsx
  it("notes unanswered required skills without blocking optimization", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.startsWith("/api/skill-gaps/")
        ? ({ ok: true, status: 200, json: async () => ({ requirementsStatus: "ready", unanswered: [{ termKey: "a" }, { termKey: "b" }], coveredCount: 0, declinedCount: 0, profileSkills: [] }) } as Response)
        : ({ ok: true, status: 200, json: async () => ({ optimizations: [] }) } as Response)));
    render(<ResumeOptimizationPanel jobId="j1" />);
    expect(await screen.findByText(/2 required skills are unanswered/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "answer them" })).toHaveAttribute("href", "#skill-gaps");
    expect(screen.getByRole("button", { name: "Optimize Resume" })).toBeEnabled();
  });
```

Existing `ResumeOptimizationPanel` tests that mock fetch by call order must keep passing: make the skill-gap fetch failure-tolerant (a rejected or non-OK response hides the notice), and if a test's `mockResolvedValueOnce` sequence now gets consumed by the new call, switch that test to the URL-routing mock above.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter web test -- SkillGapsPanel ResumeOptimizationPanel`
Expected: FAIL.

- [ ] **Step 3: Implement**

`SkillGapsPanel.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { SkillAnswerForm, SKILL_GAPS_CHANGED_EVENT } from "../../skills/SkillAnswerForm";

interface JobSkillGapsView {
  requirementsStatus: "ready" | "missing";
  unanswered: { termKey: string; termDisplay: string; suggestion: string | null }[];
  coveredCount: number; declinedCount: number; profileSkills: string[];
}
type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; view: JobSkillGapsView };

/** Phase 13b design §7: this job's required skills not found in the profile, answered in place. */
export function SkillGapsPanel({ jobId }: { jobId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const load = () =>
    fetch(`/api/skill-gaps/${encodeURIComponent(jobId)}`)
      .then((res) => {
        if (!res.ok) throw new Error("load failed");
        return res.json();
      })
      .then((view: JobSkillGapsView) => setState({ kind: "ready", view }))
      .catch(() => setState({ kind: "error" }));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const check = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      const res = await fetch(`/api/skill-gaps/${encodeURIComponent(jobId)}/requirements`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setCheckError(body?.error ?? "Could not check this job's requirements.");
        return;
      }
      setState({ kind: "ready", view: body as JobSkillGapsView });
      window.dispatchEvent(new Event(SKILL_GAPS_CHANGED_EVENT));
    } catch {
      setCheckError("Could not check this job's requirements.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <section id="skill-gaps" aria-labelledby="skill-gaps-heading" className="flex flex-col gap-3">
      <h2 id="skill-gaps-heading" className="font-medium">Required skills to verify</h2>
      {state.kind === "loading" && <p>Loading required skills...</p>}
      {state.kind === "error" && <p role="alert" className="text-red-600">Could not load this job&apos;s required skills.</p>}
      {state.kind === "ready" && state.view.requirementsStatus === "missing" && (
        <div className="flex items-center gap-2 text-sm">
          <span>This job&apos;s requirements haven&apos;t been checked yet.</span>
          <button type="button" onClick={check} disabled={checking} className="rounded border px-2 py-1 disabled:opacity-50">
            {checking ? "Checking..." : "Check requirements"}
          </button>
        </div>
      )}
      {state.kind === "ready" && state.view.requirementsStatus === "ready" && (
        <>
          <p className="text-sm text-gray-600">{state.view.coveredCount} covered by your profile · {state.view.declinedCount} you don&apos;t have</p>
          {state.view.unanswered.length === 0 ? (
            <p className="text-sm">Every required skill is covered or answered.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {state.view.unanswered.map((gap) => (
                <li key={gap.termKey} className="flex flex-col gap-1 rounded border p-3">
                  <span className="font-medium">{gap.termDisplay}</span>
                  <SkillAnswerForm termDisplay={gap.termDisplay} suggestion={gap.suggestion} profileSkills={state.view.profileSkills} onSaved={load} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {checkError && <p role="alert" className="text-sm text-red-600">{checkError}</p>}
    </section>
  );
}
```

`MatchDetailClient.tsx` — import `SkillGapsPanel` and render `{showWorkspace && <SkillGapsPanel jobId={jobId} />}` immediately before the `ResumeOptimizationPanel` line.

`ResumeOptimizationPanel.tsx` — add:

```tsx
import { SKILL_GAPS_CHANGED_EVENT } from "../../skills/SkillAnswerForm";
```

state `const [unansweredCount, setUnansweredCount] = useState(0);`, a loader and an effect:

```tsx
  // Phase 13b: a non-blocking reminder; any failure just hides it.
  const loadGaps = () =>
    fetch(`/api/skill-gaps/${encodeURIComponent(jobId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((view) => setUnansweredCount(view?.requirementsStatus === "ready" ? view.unanswered.length : 0))
      .catch(() => setUnansweredCount(0));

  useEffect(() => {
    loadGaps();
    window.addEventListener(SKILL_GAPS_CHANGED_EVENT, loadGaps);
    return () => window.removeEventListener(SKILL_GAPS_CHANGED_EVENT, loadGaps);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
```

and, right after the `generateError` paragraph:

```tsx
      {unansweredCount > 0 && (
        <p className="text-sm text-amber-700">
          {unansweredCount} required {unansweredCount === 1 ? "skill is" : "skills are"} unanswered —{" "}
          <a href="#skill-gaps" className="underline">answer them</a> so the resume can use them.
        </p>
      )}
```

(Notice placement must not depend on `state.kind`; render it only in the `ready` branch, which is where the existing JSX lives.)

- [ ] **Step 4: Run the web tests, typecheck and lint**

Run: `pnpm --filter web test && pnpm --filter web typecheck && pnpm --filter web lint`
Expected: PASS (whole web suite — panel changes can ripple into `MatchDetailClient.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/matches
git commit -m "feat(web): per-job skill verification panel and resume notice (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: E2E smoke

**Files:**
- Modify: `e2e/fakeProviders.mjs` (`TOOL_INPUTS`)
- Modify: `e2e/smoke.mjs` (new block after the Phase 13a block)

**Interfaces:**
- Consumes: everything above, running for real (`pnpm e2e`).

- [ ] **Step 1: Add the requirements stand-in** — in `TOOL_INPUTS`:

```js
  // Phase 13b: every job "requires" SQL (in the profile) and Kubernetes (not), so /skills has exactly one gap.
  record_job_requirements: {
    requirements: [
      { termText: "SQL", termType: "skill", requirementLevel: "required", evidenceQuote: null },
      { termText: "Kubernetes", termType: "tool", requirementLevel: "required", evidenceQuote: null },
    ],
  },
```

- [ ] **Step 2: Add the checks** — in `smoke.mjs`, after the `/matches shows the Find matching jobs button` check:

```js
    // --- Phase 13b missing-skill verification ---------------------------------------------------------------------
    const gaps = await waitFor("the top matches' requirements to be checked", async () => {
      const o = await json(await api.get(`${ctx.base}/api/skill-gaps`));
      return o?.unanswered?.some((g) => g.termKey === "kubernetes") ? o : null;
    });
    const k8s = gaps.unanswered.find((g) => g.termKey === "kubernetes");
    await check("/api/skill-gaps lists Kubernetes for the top matches, not SQL", k8s.jobCount >= 1 && !gaps.unanswered.some((g) => g.termKey === "sql"), gaps);
    const jobGaps = await json(await api.get(`${ctx.base}/api/skill-gaps/${k8s.jobs[0].jobId}`));
    await check("the job's panel data lists the same gap", jobGaps?.unanswered?.some((g) => g.termKey === "kubernetes"), jobGaps);
    const answer = await api.put(`${ctx.base}/api/skill-verifications`, { data: { status: "have", termDisplay: "Kubernetes", evidence: "Ran the staging cluster." } });
    await check("answering 'I have it' with evidence is saved", answer.status() === 200, await json(answer));
    const after = await json(await api.get(`${ctx.base}/api/skill-gaps`));
    await check("the answered skill leaves the list and shows as an answer",
      !after.unanswered.some((g) => g.termKey === "kubernetes") && after.answered.some((a) => a.termKey === "kubernetes" && a.status === "have"), after);
    const afterJob = await json(await api.get(`${ctx.base}/api/skill-gaps/${k8s.jobs[0].jobId}`));
    await check("the job's panel data no longer lists it", !afterJob.unanswered.some((g) => g.termKey === "kubernetes"), afterJob);
    await page.goto(`${ctx.base}/skills`);
    await check("/skills renders the answer", await visible(page.getByText(/Kubernetes — you have it/)));
```

If `/skills` is not covered by the gate redirect checks, nothing else is needed (the page uses the same session cookie).

- [ ] **Step 3: Run the E2E suite**

Run: `pnpm build && pnpm e2e`
Expected: all checks pass (previously 47 + 7 new). On failure the run prints the failed check and saves a screenshot; fix the cause, do not loosen the check.

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): missing-skill verification smoke (Phase 13b)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Documentation

**Files:**
- Modify: `DECISIONS.md` (append D199–D204)
- Modify: `FLOW.md` (append §21)
- Modify: `docs/api.md`, `docs/ai-system.md`
- Modify: `docs/superpowers/specs/2026-10-19-phase-13b-skill-verification-design.md` (status line + §13 Planning refinements = R1–R6 verbatim)

- [ ] **Step 1: DECISIONS.md** — append, in the file's existing format (`### DNNN. Title` / **Decision:** / **Alternatives considered:** / **Why:** / **What it affects:**):

- **D199. Phase 13b: verified skills live in their own table** — `skill_verifications`, one row per normalized term; alias by skill name. Alternatives: writing into `skills` (wiped by `saveProfile`), per-job answers (asks the same question per job). Why: survives profile edits; one answer applies everywhere.
- **D200. Phase 13b: "I have it" requires an evidence sentence and becomes a `verified_skill` catalog entry** — user choice B; the catalog is the single source for every guard (D60/D61), so no guard changed. Live aliases are entries too (R2) so `computeGapTerms` sees them.
- **D201. Phase 13b: gap detection moved to resume-optimization; `computeSkillGaps`** — covered / declined / unanswered; profile text beats "dont_have"; application-package re-exports.
- **D202. Phase 13b: deterministic alias suggestions only** — user choice; ~50 unambiguous groups; a suggestion never covers a term; AI suggester deferred.
- **D203. Phase 13b: requirements for the top N after matching, outside the job** — R3; single-flight per user; budget stops the step; never fails matching. Alternative: extraction on page open (slow first load).
- **D204. Phase 13b: answer routes keyed by body / id; every verified skill rendered in Skills** — R1, R4.

- [ ] **Step 2: FLOW.md §21** — trace, in the file's style:

```
## 21. Phase 13b — Missing-Skill Verification

### 21a. After matching (process-driven)
matching worker "completed" event (services/matching-worker/src/main.ts)
  → createRequirementsRefresh (requirementsRefresh.ts; single-flight per user)
  → ensureTopMatchRequirements (packages/resume-optimization/src/gaps/topMatchRequirements.ts)
     ├─ selectTopMatchJobs: open + eligible job_matches by overall_score DESC, limit SKILL_GAP_TOP_N
     └─ per job, own transaction: ensureJobRequirements (cache hit = no AI call); budget error stops; other errors skipped + logged by id

### 21b. Reading gaps (request-driven)
GET /api/skill-gaps → lib/skillGaps/loadSkillGaps.ts loadSkillGapsOverview
  ├─ buildResumeSnapshot (catalog incl. verified_skill), skill_verifications, skills names
  ├─ selectTopMatchJobs + job_requirements (fresh only: hash = jobs.description_hash)
  └─ computeSkillGaps per job → unanswered grouped by term_key, jobCount desc
GET /api/skill-gaps/[jobId] → loadJobSkillGaps (any matched job)
POST /api/skill-gaps/[jobId]/requirements → ensureJobRequirements → loadJobSkillGaps   (rate limit "ai")

### 21c. Answering (request-driven)
SkillAnswerForm (app/skills) → PUT /api/skill-verifications → SkillVerificationBodySchema → saveVerification
  (term_key = normalizeTermKey(termDisplay); upsert; alias must be a profile skill) → SKILL_GAPS_CHANGED_EVENT
Undo → DELETE /api/skill-verifications/[id]

### 21d. Where answers are used
buildResumeSnapshot → verified_skill entries ("have": "<term>: <evidence>"; live alias: "<term> (same as <skill>)")
  → applyDeterministicGuard (unchanged: catalog ids), computeGapTerms haystack (cover letter / interview prep),
    loadResumeProfile.verifiedSkills → buildResumeModel Skills section (selected first)
```

- [ ] **Step 3: docs/api.md** — add the five routes with request/response shapes and status codes from Tasks 9–10. **docs/ai-system.md** — add a short "Skill verification" paragraph: no new prompts; one sentence added to the optimizer prompt about `verified_skill`; requirements extraction now also runs after matching for the top N; evidence is user-written untrusted text inside the catalog.

- [ ] **Step 4: Spec** — set `Status: implemented on branch phase-13b-skill-verification (2026-10-19).` and append `## 13. Planning refinements (2026-10-19)` with R1–R6 copied from this plan.

- [ ] **Step 5: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm run test --force`
Expected: all green; record the test count in the final report.

- [ ] **Step 6: Commit**

```bash
git add DECISIONS.md FLOW.md docs
git commit -m "docs: Phase 13b decisions, flow, API and AI-system notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
