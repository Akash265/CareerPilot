# Phase 0/1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Turborepo monorepo, local Docker Compose infrastructure (Postgres/pgvector, Redis, MinIO), a minimal Next.js app, the shared env-config and DB packages (including the single-user RLS pattern), and CI — so a fresh clone can `docker compose up` + `pnpm dev` and get a working, tested skeleton with nothing product-specific built yet.

**Architecture:** A pnpm/Turborepo monorepo (`apps/web`, `packages/config`, `packages/db`) on top of Docker Compose services (Postgres+pgvector, Redis, MinIO). All app code reads validated env config from `packages/config`; all DB access goes through `packages/db`, which enforces the RLS single-user pattern from day one. No product features (career goals, jobs, matching) are implemented in this phase — this is infrastructure only.

**Tech Stack:** pnpm workspaces + Turborepo, Next.js 15 (TypeScript, Tailwind, App Router), Drizzle ORM + drizzle-kit, Zod, Vitest, Docker Compose (`pgvector/pgvector:pg16`, `redis:7-alpine`, `minio/minio`), GitHub Actions.

**Spec:** `docs/architecture.md` and `DECISIONS.md` (this plan implements D1, D2, D7's `EMBEDDING_PROVIDER` toggle at the config level, and D9's env-based redaction inputs — no AI/embedding calls are made in this phase, just the config plumbing for them).

## Global Constraints

- Package manager: **pnpm** with workspaces (chosen for monorepo efficiency; not mandated by spec — see DECISIONS.md D10 added by this plan).
- Node.js: **22.x LTS**, pinned via `"engines"` in root `package.json` and `.nvmrc`.
- TypeScript: `strict: true` in every package's `tsconfig.json`, no exceptions.
- ORM: Drizzle (spec §26). Validation: Zod (spec §26). Testing: Vitest for unit/integration (spec §26); Playwright is deferred to when there's a UI worth E2E-testing — installing it now against a placeholder page is wasted setup (Karpathy guideline: no speculative work).
- No paid/cloud service may be required for local dev — everything must run via `docker compose up` (spec §17).
- Every user-scoped table gets `user_id UUID NOT NULL DEFAULT current_setting('app.current_user_id')::uuid` and an `ENABLE ROW LEVEL SECURITY` policy from the first migration onward (DECISIONS.md D2) — this is not deferred to a later phase.
- `.env` is gitignored; `.env.example` lists every variable with a comment and a non-secret placeholder value only (CLAUDE.md §9, §15).
- Do not implement login/signup UI. Auth is the fixed `DEFAULT_USER_ID` + RLS session-variable pattern only (DECISIONS.md D1, D2).

---

## File Structure

```
ai-career-intelligence/                 # repo root (currently /Users/ak265/Desktop/project)
├── apps/
│   └── web/                            # Next.js app — UI shell + health-check route only
├── packages/
│   ├── config/                         # Zod env schema, single source of truth for env vars
│   │   ├── src/env.ts
│   │   ├── src/env.test.ts
│   │   └── package.json
│   └── db/                             # Drizzle client, schema, migrations, RLS session helper
│       ├── src/client.ts
│       ├── src/schema/users.ts
│       ├── src/rls.ts
│       ├── src/rls.test.ts
│       ├── drizzle.config.ts
│       └── package.json
├── infra/
│   └── docker-compose.yml
├── .github/workflows/ci.yml
├── docs/
│   ├── architecture.md                 # exists
│   └── superpowers/plans/              # this file
├── DECISIONS.md                        # exists — this plan appends D10
├── LEGAL.md
├── .env.example
├── .gitignore
├── .nvmrc
├── package.json                        # root workspace + turbo scripts
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

Each package has one job: `config` validates and types environment variables (nothing else lives here — no business logic), `db` owns the Postgres connection and RLS enforcement (nothing else queries Postgres directly), `apps/web` is the only thing that renders UI. This mirrors spec §20 and keeps later phases (matching, resume optimization, etc.) addable as new packages without touching these three.

---

### Task 1: Git, workspace tooling, and repo skeleton

**Files:**
- Create: `.gitignore`
- Create: `.nvmrc`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `LEGAL.md`
- Create: `README.md`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the pnpm workspace root and `turbo` task runner that every later task's `package.json` plugs into via `pnpm --filter` and `turbo run <task>`.

- [ ] **Step 1: Initialize git**

Run:
```bash
git init
git config user.email "akash265457k@gmail.com"
```

- [ ] **Step 2: Create `.gitignore`**

```gitignore
node_modules/
.env
.env.*.local
.turbo/
dist/
.next/
coverage/
*.log
.DS_Store
```

- [ ] **Step 3: Pin Node version**

```
22
```
(save as `.nvmrc`)

- [ ] **Step 4: Create root `package.json`**

```json
{
  "name": "ai-career-intelligence",
  "private": true,
  "engines": { "node": ">=22.0.0" },
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test"
  },
  "devDependencies": {
    "turbo": "^2.3.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 5: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 6: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "dev": { "cache": false, "persistent": true },
    "lint": { "dependsOn": ["^build"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

- [ ] **Step 7: Create `LEGAL.md`**

```markdown
# Legal / Data Sourcing Notice

This project ingests job data only from sources the operator has explicit
permission to use: official ATS/job-board APIs (e.g. Greenhouse, Lever,
Ashby), RSS/XML feeds, user-provided file exports, and Apify actors.

Before enabling any data source, the operator must confirm they have
reviewed that source's Terms of Service and are legally permitted to
ingest its data programmatically. This tool ships with no open-ended
HTML scraper and does not sanction using one against a source whose ToS
prohibits it.

This is a personal, single-user tool. It is not designed or licensed for
resale or multi-tenant redistribution of ingested job data.
```

- [ ] **Step 8: Create `README.md` (stub — full Quick Start added in Task 8)**

```markdown
# AI Career Intelligence & Application Platform

Personal AI career operating system: natural-language career goal → job
discovery/ranking → factual, ATS-oriented application generation →
human-approved submission → outcome tracking.

See `docs/architecture.md` for system design and `DECISIONS.md` for the
rationale behind each architectural choice.

## Status

Foundation phase (Phase 0/1) in progress. No product features yet.
```

- [ ] **Step 9: Install root tooling**

Run: `pnpm install`
Expected: lockfile `pnpm-lock.yaml` created, no errors (workspace has no packages yet besides root devDependencies).

- [ ] **Step 10: Commit**

```bash
git add .gitignore .nvmrc package.json pnpm-workspace.yaml turbo.json LEGAL.md README.md pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore: bootstrap pnpm/turborepo workspace skeleton

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

### Task 2: `packages/config` — validated environment configuration

This is the first logic-bearing package, so it gets real TDD: env validation is exactly the kind of "straightforward rule" CLAUDE.md §6 wants deterministic, tested code for, and it is depended on by every other package.

**Files:**
- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/src/env.ts`
- Test: `packages/config/src/env.test.ts`
- Create: `.env.example` (root)

**Interfaces:**
- Produces: `loadEnv(source?: Record<string, string | undefined>): Env` and the `Env` type, exported from `@ai-career/config`. `Env` fields: `NODE_ENV: 'development' | 'test' | 'production'`, `DEFAULT_USER_ID: string` (UUID), `DATABASE_URL: string`, `REDIS_URL: string`, `MINIO_ENDPOINT: string`, `MINIO_ACCESS_KEY: string`, `MINIO_SECRET_KEY: string`, `ANTHROPIC_API_KEY: string`, `EMBEDDING_PROVIDER: 'voyage' | 'self-hosted'`, `VOYAGE_API_KEY: string | undefined` (required only when `EMBEDDING_PROVIDER === 'voyage'`).
- Consumed by: Task 3 (`packages/db`) and Task 5 (`apps/web`) via `import { loadEnv } from '@ai-career/config'`.

- [ ] **Step 1: Create package scaffold**

`packages/config/package.json`:
```json
{
  "name": "@ai-career/config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/env.ts",
  "types": "src/env.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0",
    "typescript": "^5.7.0"
  }
}
```

`packages/config/tsconfig.json`:
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
  "include": ["src"]
}
```

- [ ] **Step 2: Write the failing test**

`packages/config/src/env.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { loadEnv } from "./env";

const validSource = {
  NODE_ENV: "test",
  DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000001",
  DATABASE_URL: "postgres://user:pass@localhost:5432/career_intel",
  REDIS_URL: "redis://localhost:6379",
  MINIO_ENDPOINT: "http://localhost:9000",
  MINIO_ACCESS_KEY: "minioadmin",
  MINIO_SECRET_KEY: "minioadmin",
  ANTHROPIC_API_KEY: "sk-ant-test",
  EMBEDDING_PROVIDER: "voyage",
  VOYAGE_API_KEY: "voyage-test-key",
};

describe("loadEnv", () => {
  it("parses a fully valid environment", () => {
    const env = loadEnv(validSource);
    expect(env.DEFAULT_USER_ID).toBe("00000000-0000-0000-0000-000000000001");
    expect(env.EMBEDDING_PROVIDER).toBe("voyage");
  });

  it("rejects a non-UUID DEFAULT_USER_ID", () => {
    expect(() =>
      loadEnv({ ...validSource, DEFAULT_USER_ID: "not-a-uuid" })
    ).toThrow(/DEFAULT_USER_ID/);
  });

  it("requires VOYAGE_API_KEY when EMBEDDING_PROVIDER is voyage", () => {
    const { VOYAGE_API_KEY, ...rest } = validSource;
    expect(() => loadEnv({ ...rest, EMBEDDING_PROVIDER: "voyage" })).toThrow(
      /VOYAGE_API_KEY/
    );
  });

  it("allows missing VOYAGE_API_KEY when EMBEDDING_PROVIDER is self-hosted", () => {
    const { VOYAGE_API_KEY, ...rest } = validSource;
    const env = loadEnv({ ...rest, EMBEDDING_PROVIDER: "self-hosted" });
    expect(env.EMBEDDING_PROVIDER).toBe("self-hosted");
  });

  it("rejects a missing required field with a readable message", () => {
    const { DATABASE_URL, ...rest } = validSource;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/config && pnpm install && pnpm test`
Expected: FAIL — `Cannot find module './env'` (file doesn't exist yet).

- [ ] **Step 4: Write minimal implementation**

`packages/config/src/env.ts`:
```typescript
import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DEFAULT_USER_ID: z.string().uuid(),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    MINIO_ENDPOINT: z.string().url(),
    MINIO_ACCESS_KEY: z.string().min(1),
    MINIO_SECRET_KEY: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1),
    EMBEDDING_PROVIDER: z.enum(["voyage", "self-hosted"]),
    VOYAGE_API_KEY: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.EMBEDDING_PROVIDER === "voyage" && !val.VOYAGE_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VOYAGE_API_KEY"],
        message: "VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env
): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return result.data;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS — all 5 assertions green.

- [ ] **Step 6: Generate `.env.example` from the schema (by hand, kept in sync manually — see note)**

`.env.example` (root):
```bash
NODE_ENV=development

# Fixed local single-user identity (DECISIONS.md D1/D2) — do not change unless
# you understand the RLS implications in packages/db/src/rls.ts
DEFAULT_USER_ID=00000000-0000-0000-0000-000000000001

DATABASE_URL=postgres://career_intel:career_intel@localhost:5432/career_intel
REDIS_URL=redis://localhost:6379

MINIO_ENDPOINT=http://localhost:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin

# Real key required only once Phase 2+ makes actual LLM calls; a placeholder
# is fine for Phase 0/1 since no code path calls Anthropic yet.
ANTHROPIC_API_KEY=sk-ant-replace-me

# voyage | self-hosted — see DECISIONS.md D7
EMBEDDING_PROVIDER=voyage
VOYAGE_API_KEY=replace-me
```

Note: there's no schema-to-example codegen tool here — that would be speculative tooling for a 10-field schema (Karpathy guideline: no unrequested configurability). If the schema grows past ~20 fields, revisit.

- [ ] **Step 7: Commit**

```bash
git add packages/config .env.example
git commit -m "$(cat <<'EOF'
feat(config): add validated env schema with tests

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

### Task 3: Docker Compose infrastructure — Postgres/pgvector, Redis, MinIO

**Files:**
- Create: `infra/docker-compose.yml`
- Create: `infra/postgres/init.sql`

**Interfaces:**
- Produces: three running services on `localhost:5432` (Postgres+pgvector), `localhost:6379` (Redis), `localhost:9000`/`:9001` (MinIO API/console) — the connection targets `packages/db` (Task 4) and the health-check route (Task 6) depend on.

- [ ] **Step 1: Write `infra/docker-compose.yml`**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: career_intel
      POSTGRES_PASSWORD: career_intel
      POSTGRES_DB: career_intel
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U career_intel"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres_data:
  minio_data:
```

- [ ] **Step 2: Write `infra/postgres/init.sql`**

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Also create a dedicated test database so Task 4's RLS tests never
-- run against dev data.
CREATE DATABASE career_intel_test;
\connect career_intel_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

- [ ] **Step 3: Bring services up and verify health**

Run:
```bash
cd infra && docker compose up -d
docker compose ps
```
Expected: all three services show `healthy` within ~30s.

- [ ] **Step 4: Verify Postgres extensions loaded**

Run: `docker compose exec postgres psql -U career_intel -d career_intel -c "\dx"`
Expected: output lists both `vector` and `pg_trgm`.

- [ ] **Step 5: Verify Redis**

Run: `docker compose exec redis redis-cli ping`
Expected: `PONG`

- [ ] **Step 6: Verify MinIO console reachable**

Run: `curl -sf http://localhost:9000/minio/health/live && echo OK`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add infra
git commit -m "$(cat <<'EOF'
feat(infra): add docker-compose for postgres/pgvector, redis, minio

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

### Task 4: `packages/db` — Drizzle client, `users` table, and RLS single-user enforcement

This task operationalizes DECISIONS.md D2. It is the most important task in this phase to get right — every future table depends on the pattern proven here.

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema/users.ts`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/rls.ts`
- Test: `packages/db/src/rls.test.ts`

**Interfaces:**
- Consumes: `loadEnv` from `@ai-career/config` (Task 2).
- Produces: `createDbClient(env: Env): DbClient` and `withUserContext<T>(db: DbClient, userId: string, fn: (tx: DbClient) => Promise<T>): Promise<T>` from `@ai-career/db` — every future query in later phases must go through `withUserContext`, never a raw client. Also exports the `users` Drizzle table.

- [ ] **Step 1: Create package scaffold**

`packages/db/package.json`:
```json
{
  "name": "@ai-career/db",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/client.ts",
  "types": "src/client.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "@ai-career/config": "workspace:*",
    "drizzle-orm": "^0.36.0",
    "postgres": "^3.4.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.28.0",
    "vitest": "^2.1.0",
    "typescript": "^5.7.0"
  }
}
```

`packages/db/tsconfig.json`: identical shape to `packages/config/tsconfig.json` (Task 2, Step 1) — same compiler options.

- [ ] **Step 2: Define the `users` table**

`packages/db/src/schema/users.ts`:
```typescript
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  fullName: text("full_name").notNull(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

- [ ] **Step 3: Write `drizzle.config.ts`**

```typescript
import { defineConfig } from "drizzle-kit";
import { loadEnv } from "@ai-career/config";

const env = loadEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./migrations",
  dbCredentials: { url: env.DATABASE_URL },
});
```

- [ ] **Step 4: Write the DB client**

`packages/db/src/client.ts`:
```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Env } from "@ai-career/config";
import * as schema from "./schema/users";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

export function createDbClient(env: Pick<Env, "DATABASE_URL">): DbClient {
  const sql = postgres(env.DATABASE_URL);
  return drizzle(sql, { schema });
}

export { schema };
```

- [ ] **Step 5: Write the failing RLS test**

`packages/db/src/rls.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { withUserContext } from "./rls";
import { drizzle } from "drizzle-orm/postgres-js";
import { schema } from "./client";

// Runs against the dedicated test database created by infra/postgres/init.sql.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://career_intel:career_intel@localhost:5432/career_intel_test";

const sql = postgres(TEST_DATABASE_URL);
const db = drizzle(sql, { schema });

const USER_A = "00000000-0000-0000-0000-00000000000a";
const USER_B = "00000000-0000-0000-0000-00000000000b";

beforeAll(async () => {
  await sql`DROP TABLE IF EXISTS users`;
  await sql`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL DEFAULT current_setting('app.current_user_id')::uuid,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`ALTER TABLE users ENABLE ROW LEVEL SECURITY`;
  await sql`
    CREATE POLICY user_isolation ON users
    USING (user_id = current_setting('app.current_user_id')::uuid)
  `;
  await withUserContext(db, USER_A, async (tx) => {
    await tx.execute(
      sql`INSERT INTO users (full_name, email) VALUES ('Alice', 'alice@example.com')`
    );
  });
  await withUserContext(db, USER_B, async (tx) => {
    await tx.execute(
      sql`INSERT INTO users (full_name, email) VALUES ('Bob', 'bob@example.com')`
    );
  });
});

afterAll(async () => {
  await sql.end();
});

describe("withUserContext RLS isolation", () => {
  it("only returns rows for the active user_id", async () => {
    const rowsForA = await withUserContext(db, USER_A, async (tx) =>
      tx.execute(sql`SELECT full_name FROM users`)
    );
    expect(rowsForA.map((r: any) => r.full_name)).toEqual(["Alice"]);

    const rowsForB = await withUserContext(db, USER_B, async (tx) =>
      tx.execute(sql`SELECT full_name FROM users`)
    );
    expect(rowsForB.map((r: any) => r.full_name)).toEqual(["Bob"]);
  });

  it("rejects a non-UUID user id before touching the database", async () => {
    await expect(
      withUserContext(db, "not-a-uuid", async (tx) =>
        tx.execute(sql`SELECT 1`)
      )
    ).rejects.toThrow(/user id/i);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd packages/db && pnpm install && pnpm test`
Expected: FAIL — `Cannot find module './rls'`.

- [ ] **Step 7: Implement `withUserContext`**

`packages/db/src/rls.ts`:
```typescript
import type { DbClient } from "./client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every query touching a user-scoped table must go through this helper.
 * It sets the RLS session variable inside a transaction so it can never
 * leak across concurrent requests on a pooled connection.
 */
export async function withUserContext<T>(
  db: DbClient,
  userId: string,
  fn: (tx: DbClient) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(userId)) {
    throw new Error(`withUserContext: user id must be a UUID, got "${userId}"`);
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      // set_config's third arg (true) scopes the setting to this transaction
      tx.raw
        ? tx.raw(`SELECT set_config('app.current_user_id', '${userId}', true)`)
        : (tx as any).execute(
            `SELECT set_config('app.current_user_id', '${userId}', true)`
          )
    );
    return fn(tx as unknown as DbClient);
  });
}
```

Note for the implementer: `drizzle-orm`'s postgres-js transaction API takes a raw SQL tag, not a `.raw()` helper — confirm the exact call against the installed `drizzle-orm` version's docs when implementing this step, since the tagged-template vs. string-execute API has changed across minor versions. Do not guess silently if step 8 fails on this line — check the installed package's type definitions.

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm test`
Expected: PASS — both assertions green. If it fails on the `set_config` call, fix per the note in Step 7 before proceeding — do not weaken the test to make it pass.

- [ ] **Step 9: Generate and apply the real migration for `users`**

Run:
```bash
pnpm db:generate
pnpm db:migrate
```
Then manually add the RLS policy (drizzle-kit does not generate `ENABLE ROW LEVEL SECURITY`/`CREATE POLICY` statements) as a follow-up SQL migration file in `packages/db/migrations/`:
```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON users
  USING (user_id = current_setting('app.current_user_id')::uuid);
```
Run `pnpm db:migrate` again to apply it.

- [ ] **Step 10: Commit**

```bash
git add packages/db
git commit -m "$(cat <<'EOF'
feat(db): add drizzle client, users table, and RLS user-context helper

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

### Task 5: `apps/web` — Next.js scaffold

**Files:**
- Create: `apps/web/` (via scaffolding command, then modified)
- Modify: `apps/web/package.json`
- Modify: `apps/web/src/app/page.tsx`

**Interfaces:**
- Consumes: `@ai-career/config` (Task 2).
- Produces: a running Next.js dev server at `localhost:3000`; the `/` route, which Task 6's health-check route is added alongside.

- [ ] **Step 1: Scaffold the app**

Run from repo root:
```bash
pnpm create next-app@latest apps/web --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-git --use-pnpm
```

- [ ] **Step 2: Add the workspace dependency**

Edit `apps/web/package.json`, add to `dependencies`:
```json
"@ai-career/config": "workspace:*"
```
Run: `pnpm install` (from repo root, to link the workspace package).

- [ ] **Step 3: Wire env validation into the app's startup**

Replace the content of `apps/web/src/app/page.tsx` with:
```tsx
import { loadEnv } from "@ai-career/config";

export default function Home() {
  const env = loadEnv();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2">
      <h1 className="text-2xl font-semibold">AI Career Intelligence</h1>
      <p className="text-sm text-gray-500">
        Foundation phase running in {env.NODE_ENV} mode.
      </p>
    </main>
  );
}
```

- [ ] **Step 4: Add a `typecheck` script to `apps/web/package.json`**

```json
"typecheck": "tsc --noEmit"
```

- [ ] **Step 5: Run the dev server and verify**

Run: `pnpm --filter web dev`
Then: `curl -sf http://localhost:3000 | grep -o "AI Career Intelligence"`
Expected: `AI Career Intelligence` printed. Stop the dev server after confirming (Ctrl+C).

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): scaffold Next.js app with env-config wired in

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

### Task 6: Health-check API route

**Files:**
- Create: `apps/web/src/app/api/health/route.ts`
- Test: `apps/web/src/app/api/health/route.test.ts`

**Interfaces:**
- Consumes: `createDbClient` from `@ai-career/db` (Task 4), `loadEnv` from `@ai-career/config` (Task 2).
- Produces: `GET /api/health` returning `{ status: 'ok' | 'degraded', checks: { database: boolean, redis: boolean } }` — later phases' deploy/CI smoke checks hit this route.

- [ ] **Step 1: Add test dependencies**

Add to `apps/web/package.json` `devDependencies`: `"vitest": "^2.1.0"`. Add script: `"test": "vitest run"`.
Run: `pnpm --filter web install`

- [ ] **Step 2: Write the failing test**

`apps/web/src/app/api/health/route.test.ts`:
```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@ai-career/db", () => ({
  createDbClient: () => ({
    execute: vi.fn().mockResolvedValue([{ ok: 1 }]),
  }),
}));

vi.mock("ioredis", () => ({
  default: class {
    async ping() {
      return "PONG";
    }
  },
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns ok when database and redis both respond", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      checks: { database: true, redis: true },
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter web test`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 4: Add `ioredis` dependency**

Add to `apps/web/package.json` `dependencies`: `"ioredis": "^5.4.0"`. Run: `pnpm --filter web install`.

- [ ] **Step 5: Implement the route**

`apps/web/src/app/api/health/route.ts`:
```typescript
import { NextResponse } from "next/server";
import { createDbClient } from "@ai-career/db";
import Redis from "ioredis";
import { loadEnv } from "@ai-career/config";

export async function GET() {
  const env = loadEnv();
  const checks = { database: false, redis: false };

  try {
    const db = createDbClient(env);
    await db.execute("SELECT 1");
    checks.database = true;
  } catch {
    checks.database = false;
  }

  try {
    const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await redis.connect();
    const pong = await redis.ping();
    checks.redis = pong === "PONG";
    redis.disconnect();
  } catch {
    checks.redis = false;
  }

  const status = checks.database && checks.redis ? "ok" : "degraded";
  return NextResponse.json({ status, checks }, { status: status === "ok" ? 200 : 503 });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter web test`
Expected: PASS.

- [ ] **Step 7: Manually verify against real running services**

With `docker compose up -d` (Task 3) still running:
```bash
pnpm --filter web dev &
sleep 3
curl -s http://localhost:3000/api/health | python3 -m json.tool
kill %1
```
Expected: `{"status": "ok", "checks": {"database": true, "redis": true}}`.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): add /api/health route checking db and redis connectivity

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

### Task 7: CI pipeline

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: every package's `lint`/`typecheck`/`test` scripts (Tasks 2, 4, 5, 6) and `infra/docker-compose.yml` (Task 3).
- Produces: a required GitHub Actions check on every push/PR.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: career_intel
          POSTGRES_PASSWORD: career_intel
          POSTGRES_DB: career_intel_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U career_intel"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      NODE_ENV: test
      DEFAULT_USER_ID: 00000000-0000-0000-0000-000000000001
      DATABASE_URL: postgres://career_intel:career_intel@localhost:5432/career_intel_test
      TEST_DATABASE_URL: postgres://career_intel:career_intel@localhost:5432/career_intel_test
      REDIS_URL: redis://localhost:6379
      MINIO_ENDPOINT: http://localhost:9000
      MINIO_ACCESS_KEY: minioadmin
      MINIO_SECRET_KEY: minioadmin
      ANTHROPIC_API_KEY: sk-ant-ci-placeholder
      EMBEDDING_PROVIDER: voyage
      VOYAGE_API_KEY: ci-placeholder
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "pnpm"
      - run: pnpm install --frozen-lockfile
      - name: Enable pgvector/pg_trgm on test db
        run: |
          PGPASSWORD=career_intel psql -h localhost -U career_intel -d career_intel_test \
            -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 2: Verify locally what CI will run**

Run from repo root: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all four pass with the local Docker Compose services from Task 3 still running (lint/typecheck/build don't need them; test does, for the RLS and health-check tests).

- [ ] **Step 3: Commit and push, then confirm the Actions run is green**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: add GitHub Actions pipeline with postgres/redis service containers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```
Do not push automatically — pushing to a remote is a shared-state action per this project's operating rules. Stop here and confirm with the user before running `git push`, and before creating the GitHub remote if one doesn't exist yet.

---

### Task 8: README Quick Start and end-to-end verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: every prior task's setup commands.
- Produces: nothing new — this is the human-facing verification that everything above actually composes into a working local environment.

- [ ] **Step 1: Replace the README stub with a Quick Start**

```markdown
# AI Career Intelligence & Application Platform

Personal AI career operating system: natural-language career goal → job
discovery/ranking → factual, ATS-oriented application generation →
human-approved submission → outcome tracking.

See `docs/architecture.md` for system design and `DECISIONS.md` for the
rationale behind each architectural choice.

## Quick Start (local, no paid services required)

1. Copy env template: `cp .env.example .env` and fill in real values for
   `ANTHROPIC_API_KEY` / `VOYAGE_API_KEY` only once you reach a phase that
   calls them — placeholders are fine for Phase 0/1.
2. Start infrastructure: `cd infra && docker compose up -d`
3. Install dependencies: `pnpm install` (from repo root)
4. Run database migrations: `pnpm --filter @ai-career/db db:migrate`
5. Start the web app: `pnpm dev`
6. Verify: `curl http://localhost:3000/api/health` should return
   `{"status":"ok","checks":{"database":true,"redis":true}}`

## Status

Foundation phase (Phase 0/1) complete: monorepo, Docker Compose
infrastructure, validated env config, single-user RLS pattern, Next.js
shell, health-check route, CI. No product features implemented yet.
```

- [ ] **Step 2: Full clean-environment verification**

Run the entire Quick Start sequence from a stopped state to catch anything the task-by-task execution masked:
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
Expected: health check returns `status: ok` after a from-scratch `docker compose up`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: add Quick Start to README

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019NtXjwq1h6nrg5rF3fuq2G
EOF
)"
```

---

## Self-Review Notes

**Spec coverage:** Turborepo ✓ (Task 1), Next.js ✓ (Task 5), PostgreSQL/pgvector ✓ (Task 3), Redis ✓ (Task 3), Docker Compose ✓ (Task 3), MinIO ✓ (Task 3, not yet consumed by app code — correct, nothing needs object storage until resume upload in Phase 2, so wiring a client now would be speculative), authentication ✓ (Task 4 — DEFAULT_USER_ID + RLS per D1/D2, no login UI per constraint), environment configuration ✓ (Task 2), CI/CD ✓ (Task 7). GitHub itself (Task 1, `git init`) — remote creation and first push require explicit user confirmation before Task 7's final step.

**Deferred out of Phase 0/1, deliberately:** Playwright (nothing to E2E-test yet), MinIO client wiring (nothing uploads yet), any Anthropic/Voyage API calls (config validates the keys exist; nothing calls the APIs yet — Phase 2+).

**New decision this plan introduces:** pnpm as package manager, Node 22 LTS — append to `DECISIONS.md` as D10 when this plan is executed (not done yet, since this plan hasn't been executed).

## DECISIONS.md and FLOW.md updates required during execution

Per CLAUDE.md §19/§20, whoever executes this plan must:
- Append **D10** to `DECISIONS.md` after Task 1 (package manager/Node version choice, made here for the first time).
- Create `FLOW.md` after Task 6, once there's an actual call path worth tracing (`GET /api/health` → `createDbClient`/`Redis` → services) — not before, since FLOW.md documents real execution paths and none exist until Task 6.
