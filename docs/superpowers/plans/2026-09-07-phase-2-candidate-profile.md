# Phase 2 (Candidate Profile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement resume upload + storage, AI-assisted structured extraction with mandatory user review, the normalized candidate-profile data model, and `profile_facts` generation/embedding — full-stack (DB + API + UI) — completing the spec's "Upload Master Resume → Build Candidate Profile" step.

**Architecture:** Two new packages (`@ai-career/storage` for MinIO, `@ai-career/ai` for text extraction + Anthropic/Voyage calls) alongside the existing `@ai-career/config`/`@ai-career/db`. `apps/web` gains upload/confirm/profile API routes and a profile UI. All DB writes go through `withUserContext`; extraction runs synchronously in the upload request; `profile_facts` are derived from the confirmed profile (not raw resume text) and embedded via a content-hash cache.

**Tech Stack:** Drizzle ORM (new tables + pgvector `vector` column), `minio` SDK, `@anthropic-ai/sdk`, `pdf-parse`, `mammoth`, `file-type`, Voyage AI REST API (via `fetch`, no SDK), Zod, Vitest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-07-phase-2-candidate-profile-design.md` and `DECISIONS.md` D14–D18.

## Global Constraints

- Every new user-scoped table gets `user_id UUID NOT NULL DEFAULT current_setting('app.current_user_id')::uuid` + RLS `CREATE POLICY user_isolation ... USING (user_id = current_setting('app.current_user_id')::uuid)` (D2/D12) — hand-written follow-up migration, same as `0001_users_rls.sql`.
- All DB access goes through `withUserContext` (`@ai-career/db`) — never a raw client.
- No test may make a real network call to Anthropic or Voyage (both are paid APIs) — mock at the client-injection boundary. Real credentials are only used in actual local/dev usage.
- Model selection is by env var, never a hardcoded model string (D7) — this phase introduces `ANTHROPIC_MODEL_FAST` and `VOYAGE_EMBEDDING_MODEL`.
- File type is validated by content-sniffing, never trusted from client-supplied `Content-Type` or extension alone; 10MB max upload size (spec §6/§9).
- TypeScript `strict: true` in every package; Vitest for tests; Zod for all structured-output/API-input validation.
- Single active resume per user (D18); `profile_facts` derived from the confirmed profile, keyed by `content_hash` for embedding reuse (D16/D8).

---

## Task 1: `packages/config` — add model-selection env vars

**Files:**
- Modify: `packages/config/src/env.ts`
- Modify: `packages/config/src/env.test.ts`
- Modify: `.env.example` (root)

**Interfaces:**
- Produces: `Env.ANTHROPIC_MODEL_FAST: string`, `Env.VOYAGE_EMBEDDING_MODEL: string` — consumed by Task 4 (`@ai-career/ai`) and Task 7 (confirm route).

- [ ] **Step 1: Write the failing tests**

Add to `packages/config/src/env.test.ts`'s `validSource` object:
```typescript
ANTHROPIC_MODEL_FAST: "claude-haiku-4-5-20251001",
VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
```
Add a new test:
```typescript
it("rejects a missing ANTHROPIC_MODEL_FAST", () => {
  const { ANTHROPIC_MODEL_FAST, ...rest } = validSource;
  expect(() => loadEnv(rest)).toThrow(/ANTHROPIC_MODEL_FAST/);
});

it("rejects a missing VOYAGE_EMBEDDING_MODEL", () => {
  const { VOYAGE_EMBEDDING_MODEL, ...rest } = validSource;
  expect(() => loadEnv(rest)).toThrow(/VOYAGE_EMBEDDING_MODEL/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ai-career/config test`
Expected: FAIL — `validSource` now has extra untyped keys is fine (Zod ignores unknown keys aren't the issue); the two new tests fail because `ANTHROPIC_MODEL_FAST`/`VOYAGE_EMBEDDING_MODEL` aren't in the schema yet, so removing them doesn't change validation outcome (the assertion `.toThrow(/ANTHROPIC_MODEL_FAST/)` fails since no such error is thrown).

- [ ] **Step 3: Add the fields to the schema**

In `packages/config/src/env.ts`, add inside `envSchema`'s `z.object({...})`, after `VOYAGE_API_KEY`:
```typescript
ANTHROPIC_MODEL_FAST: z.string().min(1),
VOYAGE_EMBEDDING_MODEL: z.string().min(1),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ai-career/config test`
Expected: PASS — all tests green.

- [ ] **Step 5: Update `.env.example`**

Add after the `VOYAGE_API_KEY` line:
```bash
# Fast/cheap-tier model for straightforward tasks like resume extraction —
# role-based selection, not a hardcoded version string (DECISIONS.md D7).
ANTHROPIC_MODEL_FAST=claude-haiku-4-5-20251001

# Determines profile_facts.embedding's vector dimension
# (packages/db/src/schema/profileFacts.ts, PROFILE_FACT_EMBEDDING_DIMENSIONS).
# If you change this, verify the new model's output dimension against
# Voyage's current docs and update that constant + regenerate the Task 2
# migration before applying it — pgvector requires a fixed dimension at
# column creation.
VOYAGE_EMBEDDING_MODEL=voyage-3.5
```

- [ ] **Step 6: Commit**

```bash
git add packages/config .env.example
git commit -m "$(cat <<'EOF'
feat(config): add ANTHROPIC_MODEL_FAST and VOYAGE_EMBEDDING_MODEL env vars

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 2: `packages/db` — Candidate Profile schema, migrations, RLS

**Files:**
- Modify: `packages/db/package.json` (add `db:generate:custom` script)
- Create: `packages/db/src/schema/candidateProfiles.ts`
- Create: `packages/db/src/schema/resumeDocuments.ts`
- Create: `packages/db/src/schema/education.ts`
- Create: `packages/db/src/schema/workExperiences.ts`
- Create: `packages/db/src/schema/skills.ts`
- Create: `packages/db/src/schema/projects.ts`
- Create: `packages/db/src/schema/certifications.ts`
- Create: `packages/db/src/schema/achievements.ts`
- Create: `packages/db/src/schema/companyPreferences.ts`
- Create: `packages/db/src/schema/profileFacts.ts`
- Create: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/client.ts`
- Test: `packages/db/src/profileTables.rls.test.ts`

**Interfaces:**
- Consumes: `withUserContext`, `createDbClient` (existing).
- Produces: `schema.candidateProfiles`, `schema.resumeDocuments`, `schema.education`, `schema.workExperiences`, `schema.workExperienceBullets`, `schema.skills`, `schema.projects`, `schema.certifications`, `schema.achievements`, `schema.companyPreferences`, `schema.profileFacts` Drizzle tables, all exported from `@ai-career/db`'s `schema` namespace. `PROFILE_FACT_EMBEDDING_DIMENSIONS` constant. Consumed by Tasks 6–8.

- [ ] **Step 1: Write the schema files**

`packages/db/src/schema/candidateProfiles.ts`:
```typescript
import { sql } from "drizzle-orm";
import {
  pgTable, uuid, text, integer, numeric, boolean, timestamp, pgEnum,
} from "drizzle-orm/pg-core";

export const workModePreferenceEnum = pgEnum("work_mode_preference", [
  "remote", "hybrid", "onsite", "any",
]);

export const candidateProfiles = pgTable("candidate_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  phoneNumber: text("phone_number"),
  linkedinUrl: text("linkedin_url"),
  addressLine1: text("address_line1"),
  yearsOfExperience: integer("years_of_experience"),
  workModePreference: workModePreferenceEnum("work_mode_preference")
    .notNull()
    .default("any"),
  salaryExpectationMin: numeric("salary_expectation_min"),
  salaryExpectationMax: numeric("salary_expectation_max"),
  salaryCurrency: text("salary_currency"),
  visaSponsorshipRequired: boolean("visa_sponsorship_required")
    .notNull()
    .default(false),
  workAuthorizationNotes: text("work_authorization_notes"),
  preferredRoleTitles: text("preferred_role_titles")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  preferredIndustries: text("preferred_industries")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  excludedIndustries: text("excluded_industries")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

`packages/db/src/schema/resumeDocuments.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const extractionStatusEnum = pgEnum("extraction_status", [
  "pending", "extracted", "failed",
]);

export const resumeDocuments = pgTable("resume_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  objectKey: text("object_key").notNull(),
  originalFilename: text("original_filename").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSizeBytes: integer("file_size_bytes").notNull(),
  extractionStatus: extractionStatusEnum("extraction_status")
    .notNull()
    .default("pending"),
  extractionError: text("extraction_error"),
  isActive: boolean("is_active").notNull().default(true),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

`packages/db/src/schema/education.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

// Dates are free text (e.g. "Sep 2020", "2020") rather than a strict date
// type — resumes rarely give full ISO dates, and structured date parsing
// isn't needed until a later phase actually sorts/filters on it.
export const education = pgTable("education", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  institution: text("institution").notNull(),
  degree: text("degree").notNull(),
  fieldOfStudy: text("field_of_study"),
  startDate: text("start_date"),
  endDate: text("end_date"),
  gpa: text("gpa"),
});
```

`packages/db/src/schema/workExperiences.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer } from "drizzle-orm/pg-core";

export const workExperiences = pgTable("work_experiences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  company: text("company").notNull(),
  title: text("title").notNull(),
  location: text("location"),
  employmentType: text("employment_type"),
  startDate: text("start_date"),
  endDate: text("end_date"), // null = current role
});

export const workExperienceBullets = pgTable("work_experience_bullets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  workExperienceId: uuid("work_experience_id")
    .notNull()
    .references(() => workExperiences.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
});
```

`packages/db/src/schema/skills.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

export const skills = pgTable("skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  name: text("name").notNull(),
  category: text("category"),
});
```

`packages/db/src/schema/projects.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  name: text("name").notNull(),
  description: text("description").notNull(),
  url: text("url"),
});
```

`packages/db/src/schema/certifications.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

export const certifications = pgTable("certifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  name: text("name").notNull(),
  issuer: text("issuer").notNull(),
  issueDate: text("issue_date"),
  expiryDate: text("expiry_date"),
});
```

`packages/db/src/schema/achievements.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

export const achievements = pgTable("achievements", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  description: text("description").notNull(),
});
```

`packages/db/src/schema/companyPreferences.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, pgEnum } from "drizzle-orm/pg-core";

export const companyPreferenceListTypeEnum = pgEnum(
  "company_preference_list_type",
  ["preferred", "excluded"]
);

export const companyPreferences = pgTable("company_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  companyName: text("company_name").notNull(),
  listType: companyPreferenceListTypeEnum("list_type").notNull(),
});
```

`packages/db/src/schema/profileFacts.ts`:
```typescript
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, pgEnum, vector } from "drizzle-orm/pg-core";

export const profileFactSourceTypeEnum = pgEnum("profile_fact_source_type", [
  "education", "work_experience_bullet", "skill", "project", "certification", "achievement",
]);

// voyage-3.5's output dimension (VOYAGE_EMBEDDING_MODEL, see .env.example).
// If that env var is ever changed to a model with a different output size,
// this constant and the migration generated from it must be updated first —
// pgvector's vector(n) column has a fixed dimension.
export const PROFILE_FACT_EMBEDDING_DIMENSIONS = 1024;

export const profileFacts = pgTable("profile_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .default(sql`current_setting('app.current_user_id')::uuid`),
  sourceType: profileFactSourceTypeEnum("source_type").notNull(),
  // App-enforced polymorphic reference (paired with sourceType), not a DB
  // foreign key — Postgres can't FK one column to different target tables
  // by discriminator (DECISIONS.md D14).
  sourceId: uuid("source_id").notNull().unique(),
  factText: text("fact_text").notNull(),
  embedding: vector("embedding", { dimensions: PROFILE_FACT_EMBEDDING_DIMENSIONS }),
  embeddingModel: text("embedding_model"),
  contentHash: text("content_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

Note for the implementer: confirm `vector(...)` is exported from `drizzle-orm/pg-core` in the installed `drizzle-orm@^0.36.0`. If it isn't, use `drizzle-orm`'s `customType` helper to define an equivalent pgvector column (`customType<{ data: number[] }>({ dataType: () => \`vector(${PROFILE_FACT_EMBEDDING_DIMENSIONS})\` })`) — check the installed package's type definitions before assuming either API, per the same verify-don't-guess practice as `packages/db/src/rls.ts`'s D12-era note.

`packages/db/src/schema/index.ts`:
```typescript
export * from "./users";
export * from "./candidateProfiles";
export * from "./resumeDocuments";
export * from "./education";
export * from "./workExperiences";
export * from "./skills";
export * from "./projects";
export * from "./certifications";
export * from "./achievements";
export * from "./companyPreferences";
export * from "./profileFacts";
```

- [ ] **Step 2: Wire the schema barrel into the client**

In `packages/db/src/client.ts`, replace:
```typescript
import * as schema from "./schema/users";
```
with:
```typescript
import * as schema from "./schema";
```

- [ ] **Step 3: Generate the migration**

Run: `pnpm --filter @ai-career/db db:generate`
Expected: a new file `packages/db/migrations/000X_<generated-name>.sql` containing `CREATE TYPE`/`CREATE TABLE` statements for all 11 new tables/enums. Note the generated filename for the next step.

- [ ] **Step 4: Write the hand-written RLS follow-up migration**

Drizzle-kit doesn't generate `ENABLE ROW LEVEL SECURITY`/`CREATE POLICY` (same as `0001_users_rls.sql`). Rather than hand-editing `packages/db/migrations/meta/_journal.json` (error-prone — wrong `idx`/timestamp silently breaks migration ordering), use drizzle-kit's custom-migration command so the file is created and registered in the journal correctly.

Add a script to `packages/db/package.json` (alongside the existing `db:generate`/`db:migrate`, using the same `dotenv-cli` wrapper — `drizzle.config.ts` calls `loadEnv()` at load time and throws if the required env vars aren't in `process.env`, so this can't be run as a bare `drizzle-kit` invocation):
```json
"db:generate:custom": "dotenv -e ../../.env -- drizzle-kit generate --custom --name=candidate_profile_rls"
```
Run: `pnpm --filter @ai-career/db db:generate:custom`
Expected: an empty `packages/db/migrations/000Y_candidate_profile_rls.sql` is created and a matching entry is appended to `meta/_journal.json` automatically (verify `meta/_journal.json` now has three entries, in the same shape as the `0000`/`0001` entries).

Fill in the generated (empty) file:
```sql
-- Follow-up to 000X_<generated-name>.sql — see 0001_users_rls.sql for why
-- these statements are hand-written (drizzle-kit does not generate RLS).
ALTER TABLE candidate_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON candidate_profiles
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE resume_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON resume_documents
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE education ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON education
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE work_experiences ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON work_experiences
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE work_experience_bullets ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON work_experience_bullets
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON skills
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON projects
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE certifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON certifications
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE achievements ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON achievements
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE company_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON company_preferences
  USING (user_id = current_setting('app.current_user_id')::uuid);

ALTER TABLE profile_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON profile_facts
  USING (user_id = current_setting('app.current_user_id')::uuid);
```

- [ ] **Step 5: Apply migrations to local dev/test databases**

Run: `pnpm --filter @ai-career/db db:migrate`
Expected: no errors. Verify: `docker compose -f infra/docker-compose.yml exec postgres psql -U career_intel -d career_intel -c "\dt"` lists all 11 new tables.

- [ ] **Step 6: Write the RLS regression test**

Create `packages/db/src/profileTables.rls.test.ts`, following the exact pattern of `packages/db/src/rls.test.ts` (real shipped migrations applied via `migrate()`, real `career_intel_app` least-privilege role, `createDbClient`/`withUserContext` — never a synthetic parallel table or the superuser role):
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { withUserContext } from "./rls";
import { createDbClient } from "./client";
import { workExperiences, workExperienceBullets, skills, profileFacts } from "./schema";
import { eq } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../migrations");

const TEST_MIGRATIONS_DATABASE_URL =
  process.env.TEST_MIGRATIONS_DATABASE_URL ??
  "postgres://career_intel:career_intel@localhost:5432/career_intel_test";
const APP_ROLE = "career_intel_app";
const APP_ROLE_PASSWORD = "career_intel_app";
const APP_DATABASE_URL =
  process.env.TEST_APP_DATABASE_URL ??
  `postgres://${APP_ROLE}:${APP_ROLE_PASSWORD}@localhost:5432/career_intel_test`;

const adminSql = postgres(TEST_MIGRATIONS_DATABASE_URL);
const adminDb = drizzle(adminSql);
const db = createDbClient({ DATABASE_URL: APP_DATABASE_URL });

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";

beforeAll(async () => {
  await migrate(adminDb, { migrationsFolder: MIGRATIONS_FOLDER });
  await adminSql.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await adminSql.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`
  );
  await adminSql`DELETE FROM work_experience_bullets`;
  await adminSql`DELETE FROM work_experiences`;
  await adminSql`DELETE FROM skills`;
  await adminSql`DELETE FROM profile_facts`;
});

afterAll(async () => {
  await adminSql.end();
});

describe("candidate profile tables RLS isolation", () => {
  it("isolates work_experiences + work_experience_bullets by user_id", async () => {
    await withUserContext(db, USER_A, async (tx) => {
      const [exp] = await tx
        .insert(workExperiences)
        .values({ company: "Acme", title: "Engineer" })
        .returning({ id: workExperiences.id });
      await tx.insert(workExperienceBullets).values({
        workExperienceId: exp.id,
        text: "Built things",
        displayOrder: 0,
      });
    });
    await withUserContext(db, USER_B, async (tx) => {
      const rows = await tx.select().from(workExperiences);
      expect(rows).toHaveLength(0);
      const bulletRows = await tx.select().from(workExperienceBullets);
      expect(bulletRows).toHaveLength(0);
    });
    await withUserContext(db, USER_A, async (tx) => {
      const rows = await tx.select().from(workExperiences);
      expect(rows).toHaveLength(1);
    });
  });

  it("isolates skills by user_id", async () => {
    await withUserContext(db, USER_A, (tx) =>
      tx.insert(skills).values({ name: "SQL", category: "language" })
    );
    await withUserContext(db, USER_B, async (tx) => {
      const rows = await tx.select().from(skills);
      expect(rows).toHaveLength(0);
    });
  });

  it("round-trips a profile_facts embedding and isolates it by user_id", async () => {
    const embedding = new Array(1024).fill(0).map((_, i) => i / 1024);
    await withUserContext(db, USER_A, (tx) =>
      tx.insert(profileFacts).values({
        sourceType: "skill",
        sourceId: "00000000-0000-0000-0000-0000000000aa",
        factText: "SQL",
        embedding,
        embeddingModel: "voyage-3.5",
        contentHash: "hash-a",
      })
    );
    await withUserContext(db, USER_B, async (tx) => {
      const rows = await tx.select().from(profileFacts);
      expect(rows).toHaveLength(0);
    });
    await withUserContext(db, USER_A, async (tx) => {
      const [row] = await tx
        .select()
        .from(profileFacts)
        .where(eq(profileFacts.contentHash, "hash-a"));
      expect(row.embedding).toHaveLength(1024);
    });
  });
});
```

- [ ] **Step 7: Run the test**

Run: `pnpm --filter @ai-career/db test`
Expected: PASS — all assertions in both `rls.test.ts` and the new `profileTables.rls.test.ts` green.

- [ ] **Step 8: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): add candidate profile schema, migrations, and RLS

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 3: `packages/storage` — MinIO resume storage

**Files:**
- Create: `packages/storage/package.json`
- Create: `packages/storage/tsconfig.json`
- Create: `packages/storage/src/client.ts`
- Create: `packages/storage/src/resumeStorage.ts`
- Create: `packages/storage/src/index.ts`
- Test: `packages/storage/src/resumeStorage.test.ts`

**Interfaces:**
- Consumes: `Env` from `@ai-career/config`.
- Produces: `createStorageClient(env): Minio.Client`, `uploadResume(client, { userId, buffer, fileExtension }): Promise<{ objectKey: string }>`, `deleteResume(client, objectKey): Promise<void>`, `RESUME_BUCKET` — consumed by Task 6 and Task 8.

- [ ] **Step 1: Scaffold the package**

`packages/storage/package.json`:
```json
{
  "name": "@ai-career/storage",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ai-career/config": "workspace:*",
    "minio": "^8.0.2"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "typescript": "^5.7.0",
    "@types/node": "^22.10.0"
  }
}
```
`packages/storage/tsconfig.json`: identical to `packages/db/tsconfig.json`.

- [ ] **Step 2: Write the failing test**

`packages/storage/src/resumeStorage.test.ts` (integration test against the real MinIO service from `infra/docker-compose.yml`, matching the project's established pattern of testing against real local services rather than mocking them):
```typescript
import { describe, it, expect, afterAll } from "vitest";
import { createStorageClient } from "./client";
import { uploadResume, deleteResume, RESUME_BUCKET } from "./resumeStorage";

const client = createStorageClient({
  MINIO_ENDPOINT: process.env.TEST_MINIO_ENDPOINT ?? "http://localhost:9000",
  MINIO_ACCESS_KEY: process.env.TEST_MINIO_ACCESS_KEY ?? "minioadmin",
  MINIO_SECRET_KEY: process.env.TEST_MINIO_SECRET_KEY ?? "minioadmin",
});

const uploadedKeys: string[] = [];

afterAll(async () => {
  for (const key of uploadedKeys) {
    await deleteResume(client, key).catch(() => {});
  }
});

describe("uploadResume / deleteResume", () => {
  it("uploads a buffer and makes it retrievable, then deletes it", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    const buffer = Buffer.from("%PDF-1.4 fake resume content");

    const { objectKey } = await uploadResume(client, {
      userId,
      buffer,
      fileExtension: "pdf",
    });
    uploadedKeys.push(objectKey);

    expect(objectKey.startsWith(`${userId}/`)).toBe(true);
    expect(objectKey.endsWith(".pdf")).toBe(true);

    const stat = await client.statObject(RESUME_BUCKET, objectKey);
    expect(stat.size).toBe(buffer.length);

    await deleteResume(client, objectKey);
    await expect(client.statObject(RESUME_BUCKET, objectKey)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/storage && pnpm install && pnpm test`
Expected: FAIL — `Cannot find module './client'` / `'./resumeStorage'`.

- [ ] **Step 4: Implement the client**

`packages/storage/src/client.ts`:
```typescript
import { Client } from "minio";
import type { Env } from "@ai-career/config";

export function createStorageClient(
  env: Pick<Env, "MINIO_ENDPOINT" | "MINIO_ACCESS_KEY" | "MINIO_SECRET_KEY">
): Client {
  const url = new URL(env.MINIO_ENDPOINT);
  return new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
    useSSL: url.protocol === "https:",
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
  });
}
```

- [ ] **Step 5: Implement resume storage operations**

`packages/storage/src/resumeStorage.ts`:
```typescript
import { randomUUID } from "node:crypto";
import type { Client } from "minio";

export const RESUME_BUCKET = "resumes";

async function ensureBucketExists(client: Client, bucket: string): Promise<void> {
  const exists = await client.bucketExists(bucket).catch(() => false);
  if (!exists) {
    await client.makeBucket(bucket);
  }
}

export async function uploadResume(
  client: Client,
  params: { userId: string; buffer: Buffer; fileExtension: string }
): Promise<{ objectKey: string }> {
  await ensureBucketExists(client, RESUME_BUCKET);
  const objectKey = `${params.userId}/${randomUUID()}.${params.fileExtension}`;
  await client.putObject(RESUME_BUCKET, objectKey, params.buffer, params.buffer.length);
  return { objectKey };
}

export async function deleteResume(client: Client, objectKey: string): Promise<void> {
  await client.removeObject(RESUME_BUCKET, objectKey);
}
```

`packages/storage/src/index.ts`:
```typescript
export { createStorageClient } from "./client";
export { uploadResume, deleteResume, RESUME_BUCKET } from "./resumeStorage";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test` (with `docker compose up -d` running)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/storage
git commit -m "$(cat <<'EOF'
feat(storage): add MinIO resume upload/delete package

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 4: `packages/ai` — file detection, text extraction, structured extraction

**Files:**
- Create: `packages/ai/package.json`
- Create: `packages/ai/tsconfig.json`
- Create: `packages/ai/src/fileDetection.ts`
- Create: `packages/ai/src/textExtraction.ts`
- Create: `packages/ai/src/extractionSchema.ts`
- Create: `packages/ai/src/extractProfile.ts`
- Create: `packages/ai/src/index.ts`
- Test: `packages/ai/src/fileDetection.test.ts`
- Test: `packages/ai/src/textExtraction.test.ts`
- Test: `packages/ai/src/extractProfile.test.ts`

**Interfaces:**
- Consumes: `Env` from `@ai-career/config`.
- Produces: `detectResumeFileType(buffer, filename): Promise<'pdf'|'docx'|'tex'>`, `UnsupportedFileTypeError`, `extractText(buffer, fileType): Promise<string>`, `ResumeExtractionSchema`, `ResumeExtractionDraft` type, `extractProfileFromResume(client, env, text): Promise<ResumeExtractionDraft>`, `createAnthropicClient(env): Anthropic`, `ExtractionValidationError` — consumed by Task 6.

- [ ] **Step 1: Scaffold the package**

`packages/ai/package.json`:
```json
{
  "name": "@ai-career/ai",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ai-career/config": "workspace:*",
    "@anthropic-ai/sdk": "^0.32.1",
    "zod": "^3.24.0",
    "pdf-parse": "^1.1.1",
    "mammoth": "^1.8.0",
    "file-type": "^19.6.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "typescript": "^5.7.0",
    "@types/node": "^22.10.0",
    "@types/pdf-parse": "^1.1.4"
  }
}
```
`packages/ai/tsconfig.json`: identical to `packages/db/tsconfig.json`.

- [ ] **Step 2: Write the failing file-detection test**

`packages/ai/src/fileDetection.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("file-type", () => ({ fileTypeFromBuffer: vi.fn() }));

import { fileTypeFromBuffer } from "file-type";
import { detectResumeFileType, UnsupportedFileTypeError } from "./fileDetection";

describe("detectResumeFileType", () => {
  it("maps a detected PDF mime type to 'pdf'", async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({ mime: "application/pdf", ext: "pdf" } as any);
    expect(await detectResumeFileType(Buffer.from("x"), "resume.pdf")).toBe("pdf");
  });

  it("maps a detected DOCX mime type to 'docx'", async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue({
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ext: "docx",
    } as any);
    expect(await detectResumeFileType(Buffer.from("x"), "resume.docx")).toBe("docx");
  });

  it("accepts a .tex file with no binary signature as valid UTF-8 text", async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const buf = Buffer.from("\\documentclass{article}\\begin{document}Hi\\end{document}", "utf-8");
    expect(await detectResumeFileType(buf, "resume.tex")).toBe("tex");
  });

  it("rejects a .tex-named file containing binary data", async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    const binaryBuffer = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await expect(detectResumeFileType(binaryBuffer, "resume.tex")).rejects.toThrow(
      UnsupportedFileTypeError
    );
  });

  it("rejects an undetectable, non-.tex file", async () => {
    vi.mocked(fileTypeFromBuffer).mockResolvedValue(undefined);
    await expect(detectResumeFileType(Buffer.from("random"), "resume.exe")).rejects.toThrow(
      UnsupportedFileTypeError
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/ai && pnpm install && pnpm test`
Expected: FAIL — `Cannot find module './fileDetection'`.

- [ ] **Step 4: Implement file detection**

`packages/ai/src/fileDetection.ts`:
```typescript
import { fileTypeFromBuffer } from "file-type";

export type ResumeFileType = "pdf" | "docx" | "tex";

export class UnsupportedFileTypeError extends Error {
  constructor(detail: string) {
    super(`Unsupported resume file type: ${detail}`);
    this.name = "UnsupportedFileTypeError";
  }
}

export async function detectResumeFileType(
  buffer: Buffer,
  originalFilename: string
): Promise<ResumeFileType> {
  const detected = await fileTypeFromBuffer(buffer);
  if (detected?.mime === "application/pdf") return "pdf";
  if (
    detected?.mime ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (originalFilename.toLowerCase().endsWith(".tex") && !buffer.includes(0)) {
    return "tex";
  }
  throw new UnsupportedFileTypeError(
    `detected=${detected?.mime ?? "unknown"}, filename=${originalFilename}`
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS (fileDetection.test.ts only so far).

- [ ] **Step 6: Write the failing text-extraction test**

`packages/ai/src/textExtraction.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("pdf-parse", () => ({ default: vi.fn().mockResolvedValue({ text: "Extracted PDF text" }) }));
vi.mock("mammoth", () => ({
  default: { extractRawText: vi.fn().mockResolvedValue({ value: "Extracted DOCX text" }) },
}));

import { extractText } from "./textExtraction";

describe("extractText", () => {
  it("extracts text from a PDF buffer via pdf-parse", async () => {
    expect(await extractText(Buffer.from("pdf-bytes"), "pdf")).toBe("Extracted PDF text");
  });

  it("extracts text from a DOCX buffer via mammoth", async () => {
    expect(await extractText(Buffer.from("docx-bytes"), "docx")).toBe("Extracted DOCX text");
  });

  it("reads a .tex buffer as raw UTF-8 text", async () => {
    const text = "\\documentclass{article}";
    expect(await extractText(Buffer.from(text, "utf-8"), "tex")).toBe(text);
  });
});
```

- [ ] **Step 7: Run test to verify it fails, then implement**

Run: `pnpm test` — Expected: FAIL (`Cannot find module './textExtraction'`).

`packages/ai/src/textExtraction.ts`:
```typescript
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import type { ResumeFileType } from "./fileDetection";

export async function extractText(buffer: Buffer, fileType: ResumeFileType): Promise<string> {
  if (fileType === "pdf") {
    const result = await pdfParse(buffer);
    return result.text;
  }
  if (fileType === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  return buffer.toString("utf-8");
}
```

Run: `pnpm test` — Expected: PASS.

- [ ] **Step 8: Write the extraction schema**

`packages/ai/src/extractionSchema.ts`:
```typescript
import { z } from "zod";

export const ResumeExtractionSchema = z.object({
  contact: z.object({
    fullName: z.string(),
    email: z.string(),
    phoneNumber: z.string().nullable(),
    linkedinUrl: z.string().nullable(),
    addressLine1: z.string().nullable(),
  }),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      fieldOfStudy: z.string().nullable(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      gpa: z.string().nullable(),
    })
  ),
  workExperiences: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string().nullable(),
      employmentType: z.string().nullable(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      bullets: z.array(z.string()),
    })
  ),
  skills: z.array(z.object({ name: z.string(), category: z.string().nullable() })),
  projects: z.array(
    z.object({ name: z.string(), description: z.string(), url: z.string().nullable() })
  ),
  certifications: z.array(
    z.object({
      name: z.string(),
      issuer: z.string(),
      issueDate: z.string().nullable(),
      expiryDate: z.string().nullable(),
    })
  ),
  achievements: z.array(z.string()),
});

export type ResumeExtractionDraft = z.infer<typeof ResumeExtractionSchema>;
```

- [ ] **Step 9: Write the failing extraction-call test**

`packages/ai/src/extractProfile.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { extractProfileFromResume, ExtractionValidationError } from "./extractProfile";

const validDraftInput = {
  contact: { fullName: "Ada Lovelace", email: "ada@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  education: [],
  workExperiences: [],
  skills: [{ name: "Analytical Engines", category: null }],
  projects: [],
  certifications: [],
  achievements: [],
};

function fakeAnthropicClient(toolUseInput: unknown, hasToolUse = true) {
  return {
    messages: {
      create: async () => ({
        content: hasToolUse
          ? [{ type: "tool_use", id: "t1", name: "record_resume_extraction", input: toolUseInput }]
          : [{ type: "text", text: "no tool use" }],
      }),
    },
  } as any;
}

describe("extractProfileFromResume", () => {
  it("returns the validated draft when the model returns a well-formed tool_use block", async () => {
    const client = fakeAnthropicClient(validDraftInput);
    const draft = await extractProfileFromResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, "resume text");
    expect(draft.contact.fullName).toBe("Ada Lovelace");
  });

  it("throws ExtractionValidationError when there is no tool_use block", async () => {
    const client = fakeAnthropicClient(validDraftInput, false);
    await expect(
      extractProfileFromResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, "resume text")
    ).rejects.toThrow(ExtractionValidationError);
  });

  it("throws ExtractionValidationError when the tool_use input fails schema validation", async () => {
    const client = fakeAnthropicClient({ contact: { fullName: 123 } });
    await expect(
      extractProfileFromResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, "resume text")
    ).rejects.toThrow(ExtractionValidationError);
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `pnpm test` — Expected: FAIL (`Cannot find module './extractProfile'`).

- [ ] **Step 11: Implement the extraction call**

`packages/ai/src/extractProfile.ts`:
```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { ResumeExtractionSchema, type ResumeExtractionDraft } from "./extractionSchema";
import type { Env } from "@ai-career/config";

const EXTRACTION_TOOL_NAME = "record_resume_extraction";

const nullableString = { type: ["string", "null"] } as const;

const EXTRACTION_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    contact: {
      type: "object",
      properties: {
        fullName: { type: "string" },
        email: { type: "string" },
        phoneNumber: nullableString,
        linkedinUrl: nullableString,
        addressLine1: nullableString,
      },
      required: ["fullName", "email", "phoneNumber", "linkedinUrl", "addressLine1"],
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          institution: { type: "string" },
          degree: { type: "string" },
          fieldOfStudy: nullableString,
          startDate: nullableString,
          endDate: nullableString,
          gpa: nullableString,
        },
        required: ["institution", "degree", "fieldOfStudy", "startDate", "endDate", "gpa"],
      },
    },
    workExperiences: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          location: nullableString,
          employmentType: nullableString,
          startDate: nullableString,
          endDate: nullableString,
          bullets: { type: "array", items: { type: "string" } },
        },
        required: ["company", "title", "location", "employmentType", "startDate", "endDate", "bullets"],
      },
    },
    skills: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, category: nullableString },
        required: ["name", "category"],
      },
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, description: { type: "string" }, url: nullableString },
        required: ["name", "description", "url"],
      },
    },
    certifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          issuer: { type: "string" },
          issueDate: nullableString,
          expiryDate: nullableString,
        },
        required: ["name", "issuer", "issueDate", "expiryDate"],
      },
    },
    achievements: { type: "array", items: { type: "string" } },
  },
  required: ["contact", "education", "workExperiences", "skills", "projects", "certifications", "achievements"],
} as const;

export class ExtractionValidationError extends Error {}

export async function extractProfileFromResume(
  client: Pick<Anthropic, "messages">,
  env: Pick<Env, "ANTHROPIC_MODEL_FAST">,
  resumeText: string
): Promise<ResumeExtractionDraft> {
  const message = await client.messages.create({
    model: env.ANTHROPIC_MODEL_FAST,
    max_tokens: 4096,
    tools: [
      {
        name: EXTRACTION_TOOL_NAME,
        description: "Record the structured candidate profile extracted from a resume.",
        input_schema: EXTRACTION_TOOL_INPUT_SCHEMA as any,
      },
    ],
    tool_choice: { type: "tool", name: EXTRACTION_TOOL_NAME },
    messages: [
      {
        role: "user",
        content:
          "Extract every factual field present in this resume. Do not invent information " +
          `that is not present in the text below. Use null for any field not present.\n\n---\n${resumeText}`,
      },
    ],
  } as any);

  const toolUse = (message.content as any[]).find((block) => block.type === "tool_use");
  if (!toolUse) {
    throw new ExtractionValidationError("Anthropic response did not include the expected tool_use block");
  }

  const result = ResumeExtractionSchema.safeParse(toolUse.input);
  if (!result.success) {
    throw new ExtractionValidationError(`Extraction output failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

export function createAnthropicClient(env: Pick<Env, "ANTHROPIC_API_KEY">): Anthropic {
  const AnthropicCtor = require("@anthropic-ai/sdk").default as typeof Anthropic;
  return new AnthropicCtor({ apiKey: env.ANTHROPIC_API_KEY });
}
```

Note for the implementer: prefer a static `import Anthropic from "@anthropic-ai/sdk"` and `new Anthropic(...)` in `createAnthropicClient` instead of the `require(...)` shown above — the ESM `import Anthropic from ...` is used for the type-only import at the top of this file already; check whether importing it as both a type and a value works directly in this project's ESM/Bundler module setup, and simplify to a plain `new Anthropic(...)` if so. The `require` fallback above is only needed if a type-only import conflicts with also needing the runtime constructor.

- [ ] **Step 12: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS — all three test files green.

- [ ] **Step 13: Write the package barrel**

`packages/ai/src/index.ts`:
```typescript
export { detectResumeFileType, UnsupportedFileTypeError } from "./fileDetection";
export type { ResumeFileType } from "./fileDetection";
export { extractText } from "./textExtraction";
export { ResumeExtractionSchema } from "./extractionSchema";
export type { ResumeExtractionDraft } from "./extractionSchema";
export { extractProfileFromResume, createAnthropicClient, ExtractionValidationError } from "./extractProfile";
```

- [ ] **Step 14: Commit**

```bash
git add packages/ai
git commit -m "$(cat <<'EOF'
feat(ai): add resume text extraction and structured AI extraction

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 5: `packages/ai` — Voyage embeddings

**Files:**
- Create: `packages/ai/src/embeddings.ts`
- Modify: `packages/ai/src/index.ts`
- Test: `packages/ai/src/embeddings.test.ts`

**Interfaces:**
- Consumes: `Env` from `@ai-career/config`.
- Produces: `embedTexts(env, texts: string[]): Promise<number[][]>`, `EmbeddingProviderNotImplementedError` — consumed by Task 7.

- [ ] **Step 1: Write the failing test**

`packages/ai/src/embeddings.test.ts`:
```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { embedTexts, EmbeddingProviderNotImplementedError } from "./embeddings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("embedTexts", () => {
  it("returns an empty array without calling the API for empty input", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await embedTexts(
      { EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "key", VOYAGE_EMBEDDING_MODEL: "voyage-3.5" },
      []
    );
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls the Voyage API and returns embeddings for the given texts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) })
    );
    const result = await embedTexts(
      { EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "key", VOYAGE_EMBEDDING_MODEL: "voyage-3.5" },
      ["some fact"]
    );
    expect(result).toEqual([[0.1, 0.2]]);
  });

  it("throws for a non-voyage provider (not yet implemented)", async () => {
    await expect(
      embedTexts(
        { EMBEDDING_PROVIDER: "self-hosted", VOYAGE_API_KEY: undefined, VOYAGE_EMBEDDING_MODEL: "voyage-3.5" },
        ["text"]
      )
    ).rejects.toThrow(EmbeddingProviderNotImplementedError);
  });

  it("throws when the Voyage API responds with an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "unauthorized" })
    );
    await expect(
      embedTexts(
        { EMBEDDING_PROVIDER: "voyage", VOYAGE_API_KEY: "bad", VOYAGE_EMBEDDING_MODEL: "voyage-3.5" },
        ["text"]
      )
    ).rejects.toThrow(/Voyage embeddings request failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ai-career/ai test`
Expected: FAIL — `Cannot find module './embeddings'`.

- [ ] **Step 3: Implement**

`packages/ai/src/embeddings.ts`:
```typescript
import type { Env } from "@ai-career/config";

export class EmbeddingProviderNotImplementedError extends Error {}

export async function embedTexts(
  env: Pick<Env, "EMBEDDING_PROVIDER" | "VOYAGE_API_KEY" | "VOYAGE_EMBEDDING_MODEL">,
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (env.EMBEDDING_PROVIDER !== "voyage") {
    throw new EmbeddingProviderNotImplementedError(
      `EMBEDDING_PROVIDER=${env.EMBEDDING_PROVIDER} has no implementation yet`
    );
  }
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: texts, model: env.VOYAGE_EMBEDDING_MODEL }),
  });
  if (!response.ok) {
    throw new Error(`Voyage embeddings request failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { data: { embedding: number[] }[] };
  return body.data.map((item) => item.embedding);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 5: Add to the package barrel**

In `packages/ai/src/index.ts`, add:
```typescript
export { embedTexts, EmbeddingProviderNotImplementedError } from "./embeddings";
```

- [ ] **Step 6: Commit**

```bash
git add packages/ai
git commit -m "$(cat <<'EOF'
feat(ai): add Voyage embeddings client

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 6: `apps/web` — `POST /api/profile/resume` (upload + extract)

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/app/api/profile/resume/route.ts`
- Test: `apps/web/src/app/api/profile/resume/route.test.ts`

**Interfaces:**
- Consumes: `createStorageClient`/`uploadResume` (`@ai-career/storage`), `detectResumeFileType`/`extractText`/`extractProfileFromResume`/`createAnthropicClient` (`@ai-career/ai`), `createDbClient`/`withUserContext`/`schema` (`@ai-career/db`).
- Produces: `POST /api/profile/resume` → `{ resumeDocumentId, status: 'extracted', draft }` or `{ resumeDocumentId, status: 'failed', error }` — consumed by Task 9's UI.

- [ ] **Step 1: Add workspace dependencies**

Add to `apps/web/package.json` `dependencies`:
```json
"@ai-career/storage": "workspace:*",
"@ai-career/ai": "workspace:*"
```
Run: `pnpm install` (from repo root).

- [ ] **Step 2: Write the failing test**

`apps/web/src/app/api/profile/resume/route.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Each Drizzle-style chain link returns an object exposing only the next
// link the route actually calls, so `.update().set().where()` and
// `.insert().values().returning()` both resolve correctly through the mock.
const dbWhereMock = vi.fn().mockResolvedValue(undefined);
const dbSetMock = vi.fn(() => ({ where: dbWhereMock }));
const dbUpdateMock = vi.fn(() => ({ set: dbSetMock }));
const dbInsertReturningMock = vi.fn().mockResolvedValue([{ id: "resume-doc-1" }]);
const dbValuesMock = vi.fn(() => ({ returning: dbInsertReturningMock }));
const dbInsertMock = vi.fn(() => ({ values: dbValuesMock }));

vi.mock("@ai-career/db", () => ({
  createDbClient: () => ({}),
  withUserContext: async (_db: unknown, _userId: string, fn: (tx: unknown) => unknown) =>
    fn({ update: dbUpdateMock, insert: dbInsertMock }),
  schema: { resumeDocuments: { isActive: "isActive", id: "id" } },
}));

vi.mock("@ai-career/storage", () => ({
  createStorageClient: () => ({}),
  uploadResume: vi.fn().mockResolvedValue({ objectKey: "user-1/file.pdf" }),
}));

const extractProfileFromResumeMock = vi.fn();

vi.mock("@ai-career/ai", () => ({
  detectResumeFileType: vi.fn().mockResolvedValue("pdf"),
  extractText: vi.fn().mockResolvedValue("plain resume text"),
  extractProfileFromResume: extractProfileFromResumeMock,
  createAnthropicClient: () => ({}),
  UnsupportedFileTypeError: class UnsupportedFileTypeError extends Error {},
  ExtractionValidationError: class ExtractionValidationError extends Error {},
}));

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({ DEFAULT_USER_ID: "user-1" }),
}));

import { POST } from "./route";

function makeRequest(): Request {
  const formData = new FormData();
  formData.append("file", new File([Buffer.from("%PDF-1.4")], "resume.pdf", { type: "application/pdf" }));
  return new Request("http://localhost/api/profile/resume", { method: "POST", body: formData });
}

beforeEach(() => {
  extractProfileFromResumeMock.mockReset();
});

describe("POST /api/profile/resume", () => {
  it("returns the extracted draft on success", async () => {
    extractProfileFromResumeMock.mockResolvedValue({ contact: { fullName: "Ada" } });

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("extracted");
    expect(body.draft.contact.fullName).toBe("Ada");
  });

  it("returns a failed status without a server error when extraction fails twice", async () => {
    const { ExtractionValidationError } = await import("@ai-career/ai");
    extractProfileFromResumeMock.mockRejectedValue(new ExtractionValidationError("bad output"));

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("failed");
    expect(extractProfileFromResumeMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter web test`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 4: Implement the route**

`apps/web/src/app/api/profile/resume/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { createDbClient, withUserContext, schema } from "@ai-career/db";
import { createStorageClient, uploadResume } from "@ai-career/storage";
import {
  detectResumeFileType,
  extractText,
  extractProfileFromResume,
  createAnthropicClient,
  UnsupportedFileTypeError,
  ExtractionValidationError,
  type ResumeExtractionDraft,
} from "@ai-career/ai";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

async function extractWithRetry(
  anthropic: ReturnType<typeof createAnthropicClient>,
  env: Parameters<typeof extractProfileFromResume>[1],
  text: string
): Promise<ResumeExtractionDraft> {
  try {
    return await extractProfileFromResume(anthropic, env, text);
  } catch (error) {
    if (error instanceof ExtractionValidationError) {
      return await extractProfileFromResume(anthropic, env, text);
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const env = loadEnv();
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json({ error: "File exceeds 10MB limit" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let fileType;
  try {
    fileType = await detectResumeFileType(buffer, file.name);
  } catch (error) {
    if (error instanceof UnsupportedFileTypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const storageClient = createStorageClient(env);
  const db = createDbClient(env);

  const { objectKey } = await uploadResume(storageClient, {
    userId: env.DEFAULT_USER_ID,
    buffer,
    fileExtension: fileType,
  });

  const resumeDocumentId = await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
    await tx
      .update(schema.resumeDocuments)
      .set({ isActive: false })
      .where(eq(schema.resumeDocuments.isActive, true));

    const [row] = await tx
      .insert(schema.resumeDocuments)
      .values({
        objectKey,
        originalFilename: file.name,
        mimeType: file.type || "application/octet-stream",
        fileSizeBytes: file.size,
        extractionStatus: "pending",
        isActive: true,
      })
      .returning({ id: schema.resumeDocuments.id });
    return row.id as string;
  });

  const text = await extractText(buffer, fileType);
  const anthropic = createAnthropicClient(env);

  try {
    const draft = await extractWithRetry(anthropic, env, text);
    await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .update(schema.resumeDocuments)
        .set({ extractionStatus: "extracted" })
        .where(eq(schema.resumeDocuments.id, resumeDocumentId))
    );
    return NextResponse.json({ resumeDocumentId, status: "extracted", draft });
  } catch (error) {
    const message = error instanceof ExtractionValidationError ? error.message : "Extraction failed";
    await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .update(schema.resumeDocuments)
        .set({ extractionStatus: "failed", extractionError: message })
        .where(eq(schema.resumeDocuments.id, resumeDocumentId))
    );
    return NextResponse.json({ resumeDocumentId, status: "failed", error: message }, { status: 200 });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter web test`
Expected: PASS. If the mocked `withUserContext`/query-builder shape in the test doesn't line up with how the route chains `.update().set().where()` / `.insert().values().returning()`, adjust the test's mock shape to match — do not change the route's real query structure to fit the test.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): add POST /api/profile/resume upload + extraction route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 7: `apps/web` — shared profile-save logic + `POST /api/profile/confirm`

**Files:**
- Create: `apps/web/src/lib/profile/confirmedProfileSchema.ts`
- Create: `apps/web/src/lib/profile/deriveFacts.ts`
- Create: `apps/web/src/lib/profile/saveProfile.ts`
- Create: `apps/web/src/app/api/profile/confirm/route.ts`
- Test: `apps/web/src/lib/profile/deriveFacts.test.ts`
- Test: `apps/web/src/app/api/profile/confirm/route.test.ts`

**Interfaces:**
- Consumes: `schema`, `createDbClient`, `withUserContext` (`@ai-career/db`), `embedTexts` (`@ai-career/ai`).
- Produces: `ConfirmedProfileSchema`, `ConfirmedProfile` type, `deriveFact(sourceType, sourceId, factText): DerivedFact`, `saveConfirmedProfile(env, profile): Promise<{ factsGenerated: number }>` — `saveConfirmedProfile` is reused by Task 8's `PATCH /api/profile`.

- [ ] **Step 1: Write the confirmed-profile Zod schema**

`apps/web/src/lib/profile/confirmedProfileSchema.ts`:
```typescript
import { z } from "zod";

export const ConfirmedProfileSchema = z.object({
  contact: z.object({
    fullName: z.string().min(1),
    email: z.string().email(),
    phoneNumber: z.string().nullable(),
    linkedinUrl: z.string().nullable(),
    addressLine1: z.string().nullable(),
  }),
  yearsOfExperience: z.number().int().nonnegative().nullable(),
  workModePreference: z.enum(["remote", "hybrid", "onsite", "any"]),
  salaryExpectationMin: z.number().nonnegative().nullable(),
  salaryExpectationMax: z.number().nonnegative().nullable(),
  salaryCurrency: z.string().nullable(),
  visaSponsorshipRequired: z.boolean(),
  workAuthorizationNotes: z.string().nullable(),
  preferredRoleTitles: z.array(z.string()),
  preferredIndustries: z.array(z.string()),
  excludedIndustries: z.array(z.string()),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      fieldOfStudy: z.string().nullable(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      gpa: z.string().nullable(),
    })
  ),
  workExperiences: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string().nullable(),
      employmentType: z.string().nullable(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
      bullets: z.array(z.string().min(1)),
    })
  ),
  skills: z.array(z.object({ name: z.string(), category: z.string().nullable() })),
  projects: z.array(z.object({ name: z.string(), description: z.string(), url: z.string().nullable() })),
  certifications: z.array(
    z.object({
      name: z.string(),
      issuer: z.string(),
      issueDate: z.string().nullable(),
      expiryDate: z.string().nullable(),
    })
  ),
  achievements: z.array(z.string()),
  preferredCompanies: z.array(z.string()),
  excludedCompanies: z.array(z.string()),
});

export type ConfirmedProfile = z.infer<typeof ConfirmedProfileSchema>;
```

- [ ] **Step 2: Write the failing fact-derivation test**

`apps/web/src/lib/profile/deriveFacts.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { deriveFact } from "./deriveFacts";

describe("deriveFact", () => {
  it("produces a stable content hash for the same text", () => {
    const a = deriveFact("skill", "id-1", "SQL");
    const b = deriveFact("skill", "id-2", "SQL");
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("produces a different content hash for different text", () => {
    const a = deriveFact("skill", "id-1", "SQL");
    const b = deriveFact("skill", "id-1", "Python");
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("carries the sourceType, sourceId, and factText through unchanged", () => {
    const fact = deriveFact("achievement", "id-9", "Shipped v1");
    expect(fact).toMatchObject({ sourceType: "achievement", sourceId: "id-9", factText: "Shipped v1" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter web test`
Expected: FAIL — `Cannot find module './deriveFacts'`.

- [ ] **Step 4: Implement fact derivation**

`apps/web/src/lib/profile/deriveFacts.ts`:
```typescript
import { createHash } from "node:crypto";

export type ProfileFactSourceType =
  | "education" | "work_experience_bullet" | "skill" | "project" | "certification" | "achievement";

export interface DerivedFact {
  sourceType: ProfileFactSourceType;
  sourceId: string;
  factText: string;
  contentHash: string;
}

export function deriveFact(sourceType: ProfileFactSourceType, sourceId: string, factText: string): DerivedFact {
  return { sourceType, sourceId, factText, contentHash: createHash("sha256").update(factText).digest("hex") };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter web test`
Expected: PASS.

- [ ] **Step 6: Implement `saveConfirmedProfile`**

`apps/web/src/lib/profile/saveProfile.ts`:
```typescript
import { createDbClient, withUserContext, schema } from "@ai-career/db";
import { embedTexts } from "@ai-career/ai";
import type { Env } from "@ai-career/config";
import type { ConfirmedProfile } from "./confirmedProfileSchema";
import { deriveFact, type DerivedFact } from "./deriveFacts";

export async function saveConfirmedProfile(
  env: Env,
  profile: ConfirmedProfile
): Promise<{ factsGenerated: number }> {
  const db = createDbClient(env);

  return withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
    await tx
      .insert(schema.candidateProfiles)
      .values({
        fullName: profile.contact.fullName,
        email: profile.contact.email,
        phoneNumber: profile.contact.phoneNumber,
        linkedinUrl: profile.contact.linkedinUrl,
        addressLine1: profile.contact.addressLine1,
        yearsOfExperience: profile.yearsOfExperience,
        workModePreference: profile.workModePreference,
        salaryExpectationMin:
          profile.salaryExpectationMin === null ? null : String(profile.salaryExpectationMin),
        salaryExpectationMax:
          profile.salaryExpectationMax === null ? null : String(profile.salaryExpectationMax),
        salaryCurrency: profile.salaryCurrency,
        visaSponsorshipRequired: profile.visaSponsorshipRequired,
        workAuthorizationNotes: profile.workAuthorizationNotes,
        preferredRoleTitles: profile.preferredRoleTitles,
        preferredIndustries: profile.preferredIndustries,
        excludedIndustries: profile.excludedIndustries,
      })
      .onConflictDoUpdate({
        target: schema.candidateProfiles.userId,
        set: {
          fullName: profile.contact.fullName,
          email: profile.contact.email,
          phoneNumber: profile.contact.phoneNumber,
          linkedinUrl: profile.contact.linkedinUrl,
          addressLine1: profile.contact.addressLine1,
          yearsOfExperience: profile.yearsOfExperience,
          workModePreference: profile.workModePreference,
          salaryExpectationMin:
            profile.salaryExpectationMin === null ? null : String(profile.salaryExpectationMin),
          salaryExpectationMax:
            profile.salaryExpectationMax === null ? null : String(profile.salaryExpectationMax),
          salaryCurrency: profile.salaryCurrency,
          visaSponsorshipRequired: profile.visaSponsorshipRequired,
          workAuthorizationNotes: profile.workAuthorizationNotes,
          preferredRoleTitles: profile.preferredRoleTitles,
          preferredIndustries: profile.preferredIndustries,
          excludedIndustries: profile.excludedIndustries,
          updatedAt: new Date(),
        },
      });

    await tx.delete(schema.education);
    await tx.delete(schema.workExperienceBullets);
    await tx.delete(schema.workExperiences);
    await tx.delete(schema.skills);
    await tx.delete(schema.projects);
    await tx.delete(schema.certifications);
    await tx.delete(schema.achievements);
    await tx.delete(schema.companyPreferences);

    const facts: DerivedFact[] = [];

    for (const edu of profile.education) {
      const [row] = await tx.insert(schema.education).values(edu).returning({ id: schema.education.id });
      const factText = `${edu.degree} in ${edu.fieldOfStudy ?? "unspecified field"} from ${edu.institution}`;
      facts.push(deriveFact("education", row.id as string, factText));
    }

    for (const exp of profile.workExperiences) {
      const [row] = await tx
        .insert(schema.workExperiences)
        .values({
          company: exp.company,
          title: exp.title,
          location: exp.location,
          employmentType: exp.employmentType,
          startDate: exp.startDate,
          endDate: exp.endDate,
        })
        .returning({ id: schema.workExperiences.id });
      for (const [index, bulletText] of exp.bullets.entries()) {
        const [bulletRow] = await tx
          .insert(schema.workExperienceBullets)
          .values({ workExperienceId: row.id as string, text: bulletText, displayOrder: index })
          .returning({ id: schema.workExperienceBullets.id });
        facts.push(deriveFact("work_experience_bullet", bulletRow.id as string, bulletText));
      }
    }

    for (const skill of profile.skills) {
      const [row] = await tx.insert(schema.skills).values(skill).returning({ id: schema.skills.id });
      facts.push(deriveFact("skill", row.id as string, skill.name));
    }

    for (const project of profile.projects) {
      const [row] = await tx.insert(schema.projects).values(project).returning({ id: schema.projects.id });
      facts.push(deriveFact("project", row.id as string, `${project.name}: ${project.description}`));
    }

    for (const cert of profile.certifications) {
      const [row] = await tx
        .insert(schema.certifications)
        .values(cert)
        .returning({ id: schema.certifications.id });
      facts.push(deriveFact("certification", row.id as string, `${cert.name} (${cert.issuer})`));
    }

    for (const achievement of profile.achievements) {
      const [row] = await tx
        .insert(schema.achievements)
        .values({ description: achievement })
        .returning({ id: schema.achievements.id });
      facts.push(deriveFact("achievement", row.id as string, achievement));
    }

    for (const companyName of profile.preferredCompanies) {
      await tx.insert(schema.companyPreferences).values({ companyName, listType: "preferred" });
    }
    for (const companyName of profile.excludedCompanies) {
      await tx.insert(schema.companyPreferences).values({ companyName, listType: "excluded" });
    }

    const existingFacts = await tx.select().from(schema.profileFacts);
    const existingByHash = new Map(existingFacts.map((f) => [f.contentHash, f]));

    const factsNeedingEmbedding = facts.filter((f) => !existingByHash.has(f.contentHash));
    const newEmbeddings = await embedTexts(env, factsNeedingEmbedding.map((f) => f.factText));
    const embeddingByHash = new Map(
      factsNeedingEmbedding.map((f, i) => [f.contentHash, newEmbeddings[i]])
    );

    await tx.delete(schema.profileFacts);
    for (const fact of facts) {
      const reused = existingByHash.get(fact.contentHash);
      const embedding = reused?.embedding ?? embeddingByHash.get(fact.contentHash) ?? null;
      await tx.insert(schema.profileFacts).values({
        sourceType: fact.sourceType,
        sourceId: fact.sourceId,
        factText: fact.factText,
        embedding,
        embeddingModel: reused?.embeddingModel ?? env.VOYAGE_EMBEDDING_MODEL,
        contentHash: fact.contentHash,
      });
    }

    return { factsGenerated: facts.length };
  });
}
```

Note for the implementer: `salaryExpectationMin`/`Max` are converted to `String(...)` before insert because Drizzle's `numeric` column type expects a string in JS to avoid floating-point round-tripping — verify this against the installed `drizzle-orm@^0.36.0`'s `numeric` column type definition; if it accepts `number` directly, simplify by removing the `String(...)` wrapper.

- [ ] **Step 7: Write the failing confirm-route test**

`apps/web/src/app/api/profile/confirm/route.test.ts` (integration test against the real test database, `@ai-career/ai`'s `embedTexts` mocked — following the same real-Postgres-plus-mocked-external-API pattern as `packages/db/src/rls.test.ts`):
```typescript
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

vi.mock("@ai-career/ai", () => ({
  embedTexts: vi.fn(async (_env: unknown, texts: string[]) => texts.map(() => new Array(1024).fill(0.01))),
}));

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-00000000000c",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ??
      "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  }),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../../../../../../packages/db/migrations");
const adminSql = postgres(
  process.env.TEST_MIGRATIONS_DATABASE_URL ??
    "postgres://career_intel:career_intel@localhost:5432/career_intel_test"
);

beforeAll(async () => {
  await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
});

afterAll(async () => {
  await adminSql.end();
});

const { POST } = await import("./route");

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/profile/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const validProfile = {
  contact: { fullName: "Ada Lovelace", email: "ada@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  yearsOfExperience: 5,
  workModePreference: "remote",
  salaryExpectationMin: null,
  salaryExpectationMax: null,
  salaryCurrency: null,
  visaSponsorshipRequired: false,
  workAuthorizationNotes: null,
  preferredRoleTitles: [],
  preferredIndustries: [],
  excludedIndustries: [],
  education: [],
  workExperiences: [
    { company: "Acme", title: "Engineer", location: null, employmentType: null, startDate: null, endDate: null, bullets: ["Built the analytical engine"] },
  ],
  skills: [{ name: "SQL", category: null }],
  projects: [],
  certifications: [],
  achievements: [],
  preferredCompanies: [],
  excludedCompanies: [],
};

describe("POST /api/profile/confirm", () => {
  it("persists the profile and generates one profile_fact per atomic item", async () => {
    const res = await POST(makeRequest(validProfile));
    const body = await res.json();

    expect(res.status).toBe(200);
    // 1 work-experience bullet + 1 skill = 2 facts
    expect(body.factsGenerated).toBe(2);
  });

  it("rejects a malformed payload with 400", async () => {
    const res = await POST(makeRequest({ contact: { fullName: 123 } }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `pnpm --filter web test`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 9: Implement the route**

`apps/web/src/app/api/profile/confirm/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { ConfirmedProfileSchema } from "@/lib/profile/confirmedProfileSchema";
import { saveConfirmedProfile } from "@/lib/profile/saveProfile";

export async function POST(request: Request) {
  const env = loadEnv();
  const body = await request.json();
  const parsed = ConfirmedProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const result = await saveConfirmedProfile(env, parsed.data);
  return NextResponse.json({ status: "saved", factsGenerated: result.factsGenerated });
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm --filter web test` (with `docker compose up -d` running)
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): add POST /api/profile/confirm — persist profile + generate profile_facts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 8: `apps/web` — `GET`/`PATCH /api/profile`, `DELETE /api/profile/resume`

**Files:**
- Create: `apps/web/src/lib/profile/serializeProfile.ts`
- Create: `apps/web/src/app/api/profile/route.ts`
- Create: `apps/web/src/app/api/profile/resume/route.ts` (modify: add `DELETE` export alongside existing `POST`)
- Test: `apps/web/src/app/api/profile/route.test.ts`

**Interfaces:**
- Produces: `GET /api/profile` → `{ profile: SerializedProfile | null }`; `PATCH /api/profile` → same response shape as `POST /api/profile/confirm` (reuses `saveConfirmedProfile`); `DELETE /api/profile/resume` → `{ status: 'deleted' }` or `404` if no active resume.

- [ ] **Step 1: Write the failing test for GET/PATCH**

`apps/web/src/app/api/profile/route.test.ts` (same real-DB-plus-mocked-`embedTexts` pattern as Task 7's confirm test — reuse its `beforeAll`/`afterAll` migration setup and `validProfile` fixture by copying them into this file, since each Vitest test file runs in isolation):
```typescript
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

vi.mock("@ai-career/ai", () => ({
  embedTexts: vi.fn(async (_env: unknown, texts: string[]) => texts.map(() => new Array(1024).fill(0.01))),
}));

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-00000000000d",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ??
      "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    VOYAGE_EMBEDDING_MODEL: "voyage-3.5",
  }),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../../../../../packages/db/migrations");
const adminSql = postgres(
  process.env.TEST_MIGRATIONS_DATABASE_URL ??
    "postgres://career_intel:career_intel@localhost:5432/career_intel_test"
);

beforeAll(async () => {
  await migrate(drizzle(adminSql), { migrationsFolder: MIGRATIONS_FOLDER });
});

afterAll(async () => {
  await adminSql.end();
});

const { GET, PATCH } = await import("./route");

const baseProfile = {
  contact: { fullName: "Grace Hopper", email: "grace@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  yearsOfExperience: 10,
  workModePreference: "remote",
  salaryExpectationMin: null,
  salaryExpectationMax: null,
  salaryCurrency: null,
  visaSponsorshipRequired: false,
  workAuthorizationNotes: null,
  preferredRoleTitles: [],
  preferredIndustries: [],
  excludedIndustries: [],
  education: [],
  workExperiences: [],
  skills: [{ name: "COBOL", category: null }],
  projects: [],
  certifications: [],
  achievements: [],
  preferredCompanies: [],
  excludedCompanies: [],
};

describe("GET/PATCH /api/profile", () => {
  it("returns profile: null before any profile has been saved", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.profile).toBeNull();
  });

  it("returns the saved profile after PATCH persists it", async () => {
    const patchRes = await PATCH(
      new Request("http://localhost/api/profile", { method: "PATCH", body: JSON.stringify(baseProfile) })
    );
    expect(patchRes.status).toBe(200);

    const getRes = await GET();
    const body = await getRes.json();
    expect(body.profile.contact.fullName).toBe("Grace Hopper");
    expect(body.profile.skills).toEqual([{ name: "COBOL", category: null }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement profile serialization**

`apps/web/src/lib/profile/serializeProfile.ts`:
```typescript
import { schema, type DbClient } from "@ai-career/db";
import { eq } from "drizzle-orm";

// Every array field is mapped to a plain, ID-free shape — the same shape
// ConfirmedProfileSchema accepts — so the UI (ReviewForm/ProfileDashboard)
// and API consumers never depend on internal row identifiers, and this
// response can be fed straight back into PATCH /api/profile unchanged.
export async function serializeProfile(tx: DbClient) {
  const [profileRow] = await tx.select().from(schema.candidateProfiles);
  if (!profileRow) return null;

  const workExperiences = await tx.select().from(schema.workExperiences);
  const bullets = await tx.select().from(schema.workExperienceBullets);
  const companyPreferences = await tx.select().from(schema.companyPreferences);

  return {
    contact: {
      fullName: profileRow.fullName,
      email: profileRow.email,
      phoneNumber: profileRow.phoneNumber,
      linkedinUrl: profileRow.linkedinUrl,
      addressLine1: profileRow.addressLine1,
    },
    yearsOfExperience: profileRow.yearsOfExperience,
    workModePreference: profileRow.workModePreference,
    // Postgres `numeric` columns commonly round-trip through drizzle-orm's
    // postgres-js driver as strings (to avoid float precision loss), but
    // ConfirmedProfileSchema/EditableProfile require `number` — coerce
    // explicitly so a GET -> edit -> POST /api/profile/confirm round-trip
    // doesn't fail schema validation on the way back in.
    salaryExpectationMin:
      profileRow.salaryExpectationMin === null ? null : Number(profileRow.salaryExpectationMin),
    salaryExpectationMax:
      profileRow.salaryExpectationMax === null ? null : Number(profileRow.salaryExpectationMax),
    salaryCurrency: profileRow.salaryCurrency,
    visaSponsorshipRequired: profileRow.visaSponsorshipRequired,
    workAuthorizationNotes: profileRow.workAuthorizationNotes,
    preferredRoleTitles: profileRow.preferredRoleTitles,
    preferredIndustries: profileRow.preferredIndustries,
    excludedIndustries: profileRow.excludedIndustries,
    education: (await tx.select().from(schema.education)).map((e) => ({
      institution: e.institution,
      degree: e.degree,
      fieldOfStudy: e.fieldOfStudy,
      startDate: e.startDate,
      endDate: e.endDate,
      gpa: e.gpa,
    })),
    workExperiences: workExperiences.map((exp) => ({
      company: exp.company,
      title: exp.title,
      location: exp.location,
      employmentType: exp.employmentType,
      startDate: exp.startDate,
      endDate: exp.endDate,
      bullets: bullets
        .filter((b) => b.workExperienceId === exp.id)
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((b) => b.text),
    })),
    skills: (await tx.select().from(schema.skills)).map((s) => ({ name: s.name, category: s.category })),
    projects: (await tx.select().from(schema.projects)).map((p) => ({
      name: p.name,
      description: p.description,
      url: p.url,
    })),
    certifications: (await tx.select().from(schema.certifications)).map((c) => ({
      name: c.name,
      issuer: c.issuer,
      issueDate: c.issueDate,
      expiryDate: c.expiryDate,
    })),
    achievements: (await tx.select().from(schema.achievements)).map((a) => a.description),
    preferredCompanies: companyPreferences.filter((c) => c.listType === "preferred").map((c) => c.companyName),
    excludedCompanies: companyPreferences.filter((c) => c.listType === "excluded").map((c) => c.companyName),
  };
}
```

- [ ] **Step 4: Implement the route**

`apps/web/src/app/api/profile/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { createDbClient, withUserContext } from "@ai-career/db";
import { ConfirmedProfileSchema } from "@/lib/profile/confirmedProfileSchema";
import { saveConfirmedProfile } from "@/lib/profile/saveProfile";
import { serializeProfile } from "@/lib/profile/serializeProfile";

export async function GET() {
  const env = loadEnv();
  const db = createDbClient(env);
  const profile = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => serializeProfile(tx));
  return NextResponse.json({ profile });
}

export async function PATCH(request: Request) {
  const env = loadEnv();
  const body = await request.json();
  const parsed = ConfirmedProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const result = await saveConfirmedProfile(env, parsed.data);
  return NextResponse.json({ status: "saved", factsGenerated: result.factsGenerated });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter web test`
Expected: PASS.

- [ ] **Step 6: Add `DELETE` to the resume route**

Add to `apps/web/src/app/api/profile/resume/route.ts` (alongside the existing `POST`). Merge `deleteResume` into the file's existing `@ai-career/storage` import (`import { createStorageClient, uploadResume, deleteResume } from "@ai-career/storage";`) rather than adding a second import statement from the same module; likewise merge `schema` and `eq` into the existing `@ai-career/db`/`drizzle-orm` imports if not already present:
```typescript
export async function DELETE() {
  const env = loadEnv();
  const db = createDbClient(env);
  const storageClient = createStorageClient(env);

  const activeResume = await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
    const [row] = await tx.select().from(schema.resumeDocuments).where(eq(schema.resumeDocuments.isActive, true));
    return row ?? null;
  });

  if (!activeResume) {
    return NextResponse.json({ error: "No active resume" }, { status: 404 });
  }

  await deleteResume(storageClient, activeResume.objectKey);
  await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
    tx.delete(schema.resumeDocuments).where(eq(schema.resumeDocuments.id, activeResume.id))
  );

  return NextResponse.json({ status: "deleted" });
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): add GET/PATCH /api/profile and DELETE /api/profile/resume

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 9: `apps/web` UI — upload → review → confirm flow

**Files:**
- Modify: `apps/web/package.json` (add `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`)
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/src/test/setup.ts`
- Create: `apps/web/src/app/profile/page.tsx`
- Create: `apps/web/src/app/profile/ProfileClient.tsx`
- Create: `apps/web/src/app/profile/UploadForm.tsx`
- Create: `apps/web/src/app/profile/ReviewForm.tsx`
- Test: `apps/web/src/app/profile/UploadForm.test.tsx`
- Test: `apps/web/src/app/profile/ReviewForm.test.tsx`

**Interfaces:**
- Consumes: `POST /api/profile/resume`, `POST /api/profile/confirm` (Tasks 6–7).
- Produces: `<ProfileClient />`'s upload/review state machine, reused by Task 10 for the "no profile yet" case.

- [ ] **Step 1: Add test tooling dependencies**

Add to `apps/web/package.json` `devDependencies`:
```json
"jsdom": "^25.0.1",
"@testing-library/react": "^16.0.1",
"@testing-library/jest-dom": "^6.6.3",
"@testing-library/user-event": "^14.5.2"
```
Run: `pnpm --filter web install`.

- [ ] **Step 2: Configure Vitest for jsdom + React**

`apps/web/vitest.config.ts` — the default environment stays `node` (Tasks 6-8's API route tests need real TCP sockets for their Postgres connections and Node's built-in `File`/`FormData`, neither of which jsdom provides); only the UI component test files opt into `jsdom` individually in Step 3:
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test/setup.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
});
```
`apps/web/src/test/setup.ts`:
```typescript
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Write the failing UploadForm test**

`apps/web/src/app/profile/UploadForm.test.tsx` (the `@vitest-environment` docblock must be the first line of the file, before any import, or Vitest ignores it):
```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UploadForm } from "./UploadForm";

describe("UploadForm", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ status: "extracted", draft: { contact: { fullName: "Ada" } } }),
      })
    );
  });

  it("uploads the selected file and reports the draft on success", async () => {
    const onExtracted = vi.fn();
    render(<UploadForm onExtracted={onExtracted} />);

    const file = new File(["%PDF-1.4"], "resume.pdf", { type: "application/pdf" });
    const input = screen.getByLabelText(/resume file/i);
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /upload/i }));

    await waitFor(() => expect(onExtracted).toHaveBeenCalledWith({ contact: { fullName: "Ada" } }));
  });

  it("shows an error message when no file is selected", () => {
    render(<UploadForm onExtracted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /upload/i }));
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter web test`
Expected: FAIL — `Cannot find module './UploadForm'`.

- [ ] **Step 5: Implement UploadForm**

`apps/web/src/app/profile/UploadForm.tsx`:
```tsx
"use client";

import { useState } from "react";
import type { ResumeExtractionDraft } from "@ai-career/ai";

export function UploadForm({ onExtracted }: { onExtracted: (draft: ResumeExtractionDraft) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleUpload() {
    if (!file) {
      setError("Please select a file to upload.");
      return;
    }
    setError(null);
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/profile/resume", { method: "POST", body: formData });
      const body = await res.json();
      if (body.status === "extracted") {
        onExtracted(body.draft);
      } else {
        setError(body.error ?? "Extraction failed — please fill in your profile manually.");
      }
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="resume-file" className="text-sm font-medium">
        Resume file (PDF, DOCX, or LaTeX)
      </label>
      <input
        id="resume-file"
        type="file"
        accept=".pdf,.docx,.tex"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        onClick={handleUpload}
        disabled={isUploading}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {isUploading ? "Uploading..." : "Upload"}
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter web test`
Expected: PASS.

- [ ] **Step 7: Write the failing ReviewForm test**

`apps/web/src/app/profile/ReviewForm.test.tsx` (`@vitest-environment` docblock first, same as `UploadForm.test.tsx`). `ReviewForm` takes an already-fully-shaped `initialProfile` (an `EditableProfile`, the same shape `ConfirmedProfileSchema` accepts) rather than a bare AI-extraction draft, so it works identically whether the caller is reviewing a fresh extraction or editing an already-saved profile (Task 10 reuses it for editing without modification):
```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewForm, type EditableProfile } from "./ReviewForm";

const initialProfile: EditableProfile = {
  contact: { fullName: "Ada Lovelace", email: "ada@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  yearsOfExperience: null,
  workModePreference: "any",
  salaryExpectationMin: null,
  salaryExpectationMax: null,
  salaryCurrency: null,
  visaSponsorshipRequired: false,
  workAuthorizationNotes: null,
  preferredRoleTitles: [],
  preferredIndustries: [],
  excludedIndustries: [],
  preferredCompanies: [],
  excludedCompanies: [],
  education: [],
  workExperiences: [],
  skills: [{ name: "Analytical Engines", category: null }],
  projects: [],
  certifications: [],
  achievements: [],
};

describe("ReviewForm", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ status: "saved", factsGenerated: 1 }) }));
  });

  it("lets the user edit the full name before confirming", async () => {
    const onSaved = vi.fn();
    render(<ReviewForm initialProfile={initialProfile} onSaved={onSaved} />);

    const nameInput = screen.getByLabelText(/full name/i);
    fireEvent.change(nameInput, { target: { value: "Grace Hopper" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm.*save/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [, requestInit] = (fetch as any).mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.contact.fullName).toBe("Grace Hopper");
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `pnpm --filter web test`
Expected: FAIL — `Cannot find module './ReviewForm'`.

- [ ] **Step 9: Implement ReviewForm**

`apps/web/src/app/profile/ReviewForm.tsx`. `EditableProfile` and `toEditableProfile` are exported here (not kept as internal-only helpers) because Task 10's `ProfileClient` needs both: `toEditableProfile` to convert a fresh AI-extraction draft into the form's shape right after upload, and the `EditableProfile` type to hold an already-saved profile (from `GET /api/profile`, which already matches this shape) when the user clicks "Edit" — in both cases `ReviewForm` itself only ever deals with one shape, `EditableProfile`, so editing an existing profile reuses this exact component with no changes:
```tsx
"use client";

import { useState } from "react";
import type { ResumeExtractionDraft } from "@ai-career/ai";

export type EditableProfile = ResumeExtractionDraft & {
  yearsOfExperience: number | null;
  workModePreference: "remote" | "hybrid" | "onsite" | "any";
  salaryExpectationMin: number | null;
  salaryExpectationMax: number | null;
  salaryCurrency: string | null;
  visaSponsorshipRequired: boolean;
  workAuthorizationNotes: string | null;
  preferredRoleTitles: string[];
  preferredIndustries: string[];
  excludedIndustries: string[];
  preferredCompanies: string[];
  excludedCompanies: string[];
};

export function toEditableProfile(draft: ResumeExtractionDraft): EditableProfile {
  return {
    ...draft,
    yearsOfExperience: null,
    workModePreference: "any",
    salaryExpectationMin: null,
    salaryExpectationMax: null,
    salaryCurrency: null,
    visaSponsorshipRequired: false,
    workAuthorizationNotes: null,
    preferredRoleTitles: [],
    preferredIndustries: [],
    excludedIndustries: [],
    preferredCompanies: [],
    excludedCompanies: [],
  };
}

export function ReviewForm({
  initialProfile,
  onSaved,
}: {
  initialProfile: EditableProfile;
  onSaved: () => void;
}) {
  const [profile, setProfile] = useState<EditableProfile>(initialProfile);
  const [isSaving, setIsSaving] = useState(false);

  async function handleConfirm() {
    setIsSaving(true);
    try {
      const res = await fetch("/api/profile/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      });
      const body = await res.json();
      if (body.status === "saved") {
        onSaved();
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor="full-name" className="text-sm font-medium">Full name</label>
        <input
          id="full-name"
          value={profile.contact.fullName}
          onChange={(e) =>
            setProfile((p) => ({ ...p, contact: { ...p.contact, fullName: e.target.value } }))
          }
          className="block w-full rounded border px-2 py-1"
        />
      </div>
      <div>
        <h3 className="text-sm font-medium">Skills</h3>
        <ul className="list-disc pl-5 text-sm">
          {profile.skills.map((skill, i) => (
            <li key={i}>{skill.name}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={handleConfirm}
        disabled={isSaving}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        {isSaving ? "Saving..." : "Confirm & Save"}
      </button>
    </div>
  );
}
```

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm --filter web test`
Expected: PASS.

- [ ] **Step 11: Wire up the page and client state machine**

`apps/web/src/app/profile/ProfileClient.tsx`:
```tsx
"use client";

import { useState } from "react";
import { UploadForm } from "./UploadForm";
import { ReviewForm, toEditableProfile, type EditableProfile } from "./ReviewForm";

type Stage = "upload" | "reviewing" | "saved";

export function ProfileClient() {
  const [stage, setStage] = useState<Stage>("upload");
  const [editableProfile, setEditableProfile] = useState<EditableProfile | null>(null);

  if (stage === "reviewing" && editableProfile) {
    return <ReviewForm initialProfile={editableProfile} onSaved={() => setStage("saved")} />;
  }
  if (stage === "saved") {
    return <p>Profile saved.</p>;
  }
  return (
    <UploadForm
      onExtracted={(extracted) => {
        setEditableProfile(toEditableProfile(extracted));
        setStage("reviewing");
      }}
    />
  );
}
```

`apps/web/src/app/profile/page.tsx`:
```tsx
import { ProfileClient } from "./ProfileClient";

export default function ProfilePage() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-6 text-2xl font-semibold">Candidate Profile</h1>
      <ProfileClient />
    </main>
  );
}
```

- [ ] **Step 12: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): add upload -> review -> confirm profile UI flow

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 10: `apps/web` UI — profile dashboard (read + edit)

**Files:**
- Create: `apps/web/src/app/profile/ProfileDashboard.tsx`
- Modify: `apps/web/src/app/profile/ProfileClient.tsx`
- Test: `apps/web/src/app/profile/ProfileDashboard.test.tsx`

**Interfaces:**
- Consumes: `GET /api/profile` (Task 8) and `ReviewForm`/`toEditableProfile`/`EditableProfile` (Task 9) — editing reuses `ReviewForm` directly (which posts to `POST /api/profile/confirm`, the same full-replace upsert `PATCH /api/profile` performs — see Task 8's rationale) rather than introducing a second save path through `PATCH`.
- Produces: `<ProfileDashboard profile={...} onEdit={...} />`, wired into `ProfileClient` so a returning user with a saved profile sees the dashboard instead of the upload form.

- [ ] **Step 1: Write the failing test**

`apps/web/src/app/profile/ProfileDashboard.test.tsx` (`@vitest-environment` docblock first, same reason as Task 9's UI tests):
```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileDashboard } from "./ProfileDashboard";

const profile = {
  contact: { fullName: "Ada Lovelace", email: "ada@example.com", phoneNumber: null, linkedinUrl: null, addressLine1: null },
  skills: [{ name: "SQL", category: null }],
  workExperiences: [],
  education: [],
  projects: [],
  certifications: [],
  achievements: [],
  preferredCompanies: [],
  excludedCompanies: [],
};

describe("ProfileDashboard", () => {
  it("renders the saved profile's name and skills", () => {
    render(<ProfileDashboard profile={profile as any} onEdit={vi.fn()} />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("SQL")).toBeInTheDocument();
  });

  it("calls onEdit when the Edit button is clicked", () => {
    const onEdit = vi.fn();
    render(<ProfileDashboard profile={profile as any} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(onEdit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test`
Expected: FAIL — `Cannot find module './ProfileDashboard'`.

- [ ] **Step 3: Implement**

`apps/web/src/app/profile/ProfileDashboard.tsx`. `profile` is typed as `EditableProfile` (the same shape `GET /api/profile` returns and `ReviewForm` edits) rather than a separately-declared shape, so there is exactly one profile shape in the UI layer:
```tsx
"use client";

import type { EditableProfile } from "./ReviewForm";

export function ProfileDashboard({
  profile,
  onEdit,
}: {
  profile: EditableProfile;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{profile.contact.fullName}</h2>
        <p className="text-sm text-gray-500">{profile.contact.email}</p>
      </div>
      <div>
        <h3 className="text-sm font-medium">Skills</h3>
        <ul className="list-disc pl-5 text-sm">
          {profile.skills.map((skill, i) => (
            <li key={i}>{skill.name}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={onEdit}
        className="w-fit rounded border px-4 py-2 text-sm"
      >
        Edit Profile
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test`
Expected: PASS.

- [ ] **Step 5: Wire the dashboard into ProfileClient**

Replace `apps/web/src/app/profile/ProfileClient.tsx` with a version that fetches the saved profile on mount and, when the user clicks "Edit", goes straight to `ReviewForm` pre-filled with that saved data — not back through `UploadForm` (there is no reason to force a resume re-upload just to edit one field, and `ReviewForm` already accepts the exact shape `GET /api/profile` returns):
```tsx
"use client";

import { useEffect, useState } from "react";
import { UploadForm } from "./UploadForm";
import { ReviewForm, toEditableProfile, type EditableProfile } from "./ReviewForm";
import { ProfileDashboard } from "./ProfileDashboard";

type Stage = "loading" | "upload" | "reviewing" | "dashboard";

export function ProfileClient() {
  const [stage, setStage] = useState<Stage>("loading");
  const [editableProfile, setEditableProfile] = useState<EditableProfile | null>(null);

  function loadProfile() {
    return fetch("/api/profile")
      .then((res) => res.json())
      .then((body) => {
        setEditableProfile(body.profile);
        setStage(body.profile ? "dashboard" : "upload");
      });
  }

  useEffect(() => {
    loadProfile();
  }, []);

  if (stage === "loading") return <p>Loading...</p>;
  if (stage === "dashboard" && editableProfile) {
    return (
      <ProfileDashboard
        profile={editableProfile}
        onEdit={() => setStage("reviewing")}
      />
    );
  }
  if (stage === "reviewing" && editableProfile) {
    return (
      <ReviewForm
        initialProfile={editableProfile}
        onSaved={() => loadProfile()}
      />
    );
  }
  return (
    <UploadForm
      onExtracted={(extracted) => {
        setEditableProfile(toEditableProfile(extracted));
        setStage("reviewing");
      }}
    />
  );
}
```
Note for the implementer: `stage === "reviewing"` is now reached two ways — from `UploadForm`'s `onExtracted` (a fresh draft, defaults filled by `toEditableProfile`) and from `ProfileDashboard`'s `onEdit` (the already-saved profile, used as-is) — both set `editableProfile` before switching to `"reviewing"`, so `ReviewForm` itself needs no changes to serve both cases.

- [ ] **Step 6: Manual verification**

With `docker compose up -d` and `pnpm dev` running, visit `http://localhost:3000/profile`: upload a resume, confirm the flow shows the extraction result, click "Confirm & Save", verify it lands on the dashboard, refresh the page, and verify the dashboard loads directly from the saved data.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): add profile dashboard read/edit view

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 11: AI evaluation fixtures for resume extraction

**Files:**
- Create: `packages/ai/eval/fixtures/resume-1-standard-pdf-text.txt` (through `resume-6-...`, 5-6 fixtures)
- Create: `packages/ai/eval/expected/resume-1-standard-pdf-text.json` (through `resume-6-...`)
- Create: `packages/ai/eval/runEval.test.ts`

**Interfaces:**
- Consumes: `extractProfileFromResume` (Task 4).
- Produces: a repeatable field-level accuracy check per CLAUDE.md §10, run via `pnpm --filter @ai-career/ai test` alongside the unit suite (uses a fake, deterministic Anthropic client — no real API call — so it stays part of the always-run test suite rather than a separate opt-in eval command).

- [ ] **Step 1: Create resume fixtures**

Create 5 plain-text resume fixtures under `packages/ai/eval/fixtures/`, each representing a distinct real-world shape: (1) a standard reverse-chronological resume, (2) one with no explicit dates on education, (3) one with a projects-heavy, light-work-history shape (new grad), (4) one written as LaTeX source (`.tex` content, still saved as `.txt` here since these fixtures feed `extractProfileFromResume` directly with already-extracted text — text extraction itself is already unit-tested in Task 4), (5) one with certifications and multiple concurrent part-time roles. Each fixture is 15-40 lines of realistic resume text (write real, varied content — not lorem ipsum — so the extraction is actually exercised).

- [ ] **Step 2: Create expected extraction JSON for each fixture**

For each fixture, hand-write the expected `ResumeExtractionDraft` JSON under `packages/ai/eval/expected/`, matching the `ResumeExtractionSchema` shape from Task 4.

- [ ] **Step 3: Write the eval runner test**

`packages/ai/eval/runEval.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractProfileFromResume } from "../src/extractProfile";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const EXPECTED_DIR = path.join(__dirname, "expected");

// A fake client that "extracts" by looking up the pre-recorded expected
// output for the given resume text, simulating a perfect model response so
// this eval exercises the schema/pipeline plumbing deterministically without
// a real (paid) Anthropic call. Field-level accuracy against imperfect real
// model output is evaluated manually when ANTHROPIC_MODEL_FAST changes —
// this automated check guards the pipeline shape, not model quality.
function fakeClientReturning(input: unknown) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "tool_use", id: "t1", name: "record_resume_extraction", input }],
      }),
    },
  } as any;
}

describe("resume extraction eval fixtures", () => {
  const fixtureNames = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".txt"));

  it("has a matching expected JSON file for every fixture", () => {
    for (const fixtureName of fixtureNames) {
      const expectedPath = path.join(EXPECTED_DIR, fixtureName.replace(".txt", ".json"));
      expect(() => readFileSync(expectedPath, "utf-8")).not.toThrow();
    }
  });

  it.each(fixtureNames)("round-trips the expected extraction for %s through schema validation", async (fixtureName) => {
    const resumeText = readFileSync(path.join(FIXTURES_DIR, fixtureName), "utf-8");
    const expected = JSON.parse(
      readFileSync(path.join(EXPECTED_DIR, fixtureName.replace(".txt", ".json")), "utf-8")
    );
    const client = fakeClientReturning(expected);
    const draft = await extractProfileFromResume(client, { ANTHROPIC_MODEL_FAST: "test-model" }, resumeText);
    expect(draft).toEqual(expected);
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @ai-career/ai test`
Expected: PASS for all fixtures (this validates each hand-written expected JSON is schema-valid and that the pipeline round-trips it correctly — it does not test real model accuracy, which is noted in the code comment above).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/eval
git commit -m "$(cat <<'EOF'
test(ai): add resume-extraction eval fixtures

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Task 12: Docs, FLOW.md, and end-to-end verification

**Files:**
- Modify: `FLOW.md`
- Modify: `README.md`
- Modify: `DECISIONS.md` (only if implementation deviated from D14-D18 — e.g. the `vector()` API or `numeric` column note from Tasks 2/7 needed a fallback)

**Interfaces:**
- Consumes: every prior task.
- Produces: nothing new — human-facing verification and traceability docs.

- [ ] **Step 1: Update FLOW.md**

Add a new section tracing the Phase 2 call path: `UploadForm` → `POST /api/profile/resume` → `detectResumeFileType`/`extractText` (`@ai-career/ai`) → `uploadResume` (`@ai-career/storage`) → `extractProfileFromResume` (`@ai-career/ai`, Anthropic) → response draft → `ReviewForm` → `POST /api/profile/confirm` → `saveConfirmedProfile` (`apps/web/src/lib/profile/saveProfile.ts`) → `embedTexts` (`@ai-career/ai`, Voyage) → Postgres (`profile_facts` + normalized tables via `withUserContext`) → `ProfileDashboard` via `GET /api/profile` → `serializeProfile`.

- [ ] **Step 2: Update README status**

In `README.md`'s `## Status` section, add:
```markdown
Phase 2 (Candidate Profile) complete: resume upload (PDF/DOCX/LaTeX) to
MinIO, AI-assisted structured extraction with mandatory user review,
normalized candidate-profile schema, and profile_facts generation +
Voyage embeddings. Visit /profile after `pnpm dev` to use it.
```

- [ ] **Step 3: Full clean-environment verification**

```bash
cd infra && docker compose down -v && docker compose up -d && cd ..
pnpm install
pnpm --filter @ai-career/db db:migrate
pnpm build
pnpm --filter web dev &
sleep 3
curl -sf http://localhost:3000/api/health
kill %1
cd infra && docker compose down
```
Expected: health check still returns `status: ok`; `pnpm build` succeeds across all packages (`@ai-career/config`, `@ai-career/db`, `@ai-career/storage`, `@ai-career/ai`, `web`).

- [ ] **Step 4: Run the full test suite**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` (with `docker compose up -d` running)
Expected: all green across every package.

- [ ] **Step 5: Commit**

```bash
git add FLOW.md README.md DECISIONS.md
git commit -m "$(cat <<'EOF'
docs: update FLOW.md and README for Phase 2 (Candidate Profile)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Self-Review Notes

**Spec coverage:** Resume upload (PDF/DOCX/LaTeX) to MinIO ✓ (Task 3, 6), AI-assisted extraction with mandatory review ✓ (Task 4, 9 — draft never persisted until `/confirm`), normalized profile data model ✓ (Task 2), `profile_facts` derived from confirmed profile + content-hash embedding cache ✓ (Task 7), preferred/excluded companies as structured data ✓ (Task 2, 7), single active resume ✓ (Task 2's `is_active`, Task 6), full-stack UI ✓ (Tasks 9-10), AI evaluation ✓ (Task 11), security (content-sniffing, size cap, UUID object keys, no PII in logs) ✓ (Task 4, 6).

**Deferred, deliberately:** Career Goal Statement parsing, Job Intelligence, resume optimization/entailment (the actual *use* of `profile_facts`), multiple resume versions, account-wide data deletion — all explicitly out of scope per the design spec.

**Open implementation-time decisions carried from the spec (§9):** the exact embedding-retry mechanism on Voyage failure is not implemented in Task 7 — a `profile_facts` row with a `null` embedding on Voyage failure is accepted as the current behavior (the fact is still saved, just not yet searchable by later phases); revisit if this proves insufficient once matching (Phase 4+) actually depends on it.
