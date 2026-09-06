# FLOW.md — Execution Traceability Map

Documents real, currently-existing call paths in this codebase. Current-state
only — no aspirational/future-phase flows. Update this file whenever an
execution path documented here changes, or once a new request-driven path
exists worth tracing.

---

## 1. `GET /api/health` (request-driven)

Entry point: `apps/web/src/app/api/health/route.ts`, exported `GET()`.

```
GET /api/health
└─ route.ts: GET()
   ├─ loadEnv()                              [@ai-career/config, packages/config/src/env.ts]
   │  └─ parses/validates process.env via envSchema (zod) → returns typed Env
   │
   ├─ DATABASE CHECK
   │  ├─ createDbClient(env)                 [@ai-career/db, packages/db/src/client.ts]
   │  │  ├─ postgres(env.DATABASE_URL)       [postgres-js — opens a fresh connection pool]
   │  │  └─ drizzle(sql, { schema })         [drizzle-orm/postgres-js — wraps pool w/ query builder]
   │  ├─ db.execute(sql`SELECT 1`)           → round-trip to live Postgres service (career_intel_app role)
   │  │  ├─ success → checks.database = true
   │  │  └─ throws  → caught by outer try/catch → checks.database stays false
   │  └─ finally: db.$client?.end()          [best-effort pool close; failures swallowed]
   │     (see route.ts comment: createDbClient opens a NEW pool every call, so this
   │      route — polled repeatedly by CI/deploy smoke checks — must close it each
   │      time or it leaks connections against Postgres's connection limit)
   │
   ├─ REDIS CHECK (independent of the database check above; not parallelized via
   │  Promise.all — runs as a second sequential try/catch block in the handler)
   │  ├─ new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })  [ioredis]
   │  ├─ redis.ping()                        → round-trip to live Redis service; connects lazily on first command
   │  │  ├─ "PONG" → checks.redis = true
   │  │  └─ throws  → caught → checks.redis stays false
   │  └─ redis.disconnect()                  [best-effort; failures swallowed]
   │
   └─ RESPONSE ASSEMBLY
      ├─ status = (checks.database && checks.redis) ? "ok" : "degraded"
      └─ NextResponse.json({ status, checks }, { status: status === "ok" ? 200 : 503 })
```

Notes:
- Both checks are independent try/catch blocks; a failure in one does not
  affect the other's result or short-circuit the handler.
- Every `createDbClient` call opens a brand-new `postgres()` pool — there is
  no shared/singleton client yet. This route relies on explicit teardown
  (`db.$client?.end()`) specifically because of that; any future code calling
  `createDbClient` needs the same discipline until a shared-client pattern
  exists.
- Cleanup (`db.$client?.end()`, `redis.disconnect()`) is best-effort: errors
  there are swallowed and never override the check result computed above them.

---

## 2. `pnpm --filter @ai-career/db db:migrate` (operator-driven, not request-driven)

```
pnpm --filter @ai-career/db db:migrate
└─ packages/db/package.json: "db:migrate" script
   └─ dotenv -e ../../.env -- drizzle-kit migrate
      └─ drizzle-kit reads packages/db/drizzle.config.ts
         ├─ loadEnv()                         [@ai-career/config]
         ├─ requires env.MIGRATIONS_DATABASE_URL
         │  └─ throws locally in drizzle.config.ts if missing
         │     (MIGRATIONS_DATABASE_URL is .optional() in the shared envSchema —
         │      see DECISIONS.md D13 — required only here, not app-/worker-wide)
         ├─ defineConfig({ dialect: "postgresql", schema: "./src/schema/*.ts",
         │                 out: "./migrations",
         │                 dbCredentials: { url: env.MIGRATIONS_DATABASE_URL } })
         └─ drizzle-kit migrate
            └─ connects as the superuser role (career_intel, via MIGRATIONS_DATABASE_URL)
            └─ applies pending SQL files from packages/db/migrations/*.sql against Postgres
```

Notes:
- Deliberately uses a different (superuser) Postgres role than app runtime
  queries (`career_intel_app`, via `DATABASE_URL`) — see DECISIONS.md D12.
  Schema DDL needs elevated privilege; ordinary CRUD does not.
- `db:generate` (also in `packages/db/package.json`) follows the same
  config/role path but calls `drizzle-kit generate` instead of `migrate`
  (diffs `src/schema/*.ts` against existing migrations to produce new SQL
  files, rather than applying existing ones).

---

## 3. `withUserContext` (library helper, not yet called from `apps/web`)

Defined in `packages/db/src/rls.ts`, re-exported from `packages/db/src/index.ts`.
Nothing in the codebase invokes it yet (no user-scoped tables/queries exist
past `users` itself), but it is the mandatory pattern every future
user-scoped query must go through — documented here per the file's own
comment: "Every query touching a user-scoped table must go through this
helper."

```
withUserContext(db, userId, fn)
├─ UUID_RE.test(userId)
│  └─ fails → throws Error("withUserContext: user id must be a UUID, got ...")
│     (rejects before opening a transaction — no wasted round-trip on bad input)
└─ db.transaction(async (tx) => {
     ├─ tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`)
     │  └─ ${userId} is bound as a SQL parameter (not string-interpolated),
     │     and set_config's third arg `true` scopes the setting to this
     │     transaction only — never leaks across other requests sharing the
     │     same pooled connection
     ├─ fn(tx)                                  ← caller's actual query, run
     │                                            inside this same transaction
     │                                            so it sees the session var
     └─ Postgres RLS policy enforcement:
        every table with a `user_isolation` policy (USING/WITH CHECK
        comparing a row's owner column against
        current_setting('app.current_user_id')::uuid) filters/rejects rows
        for this transaction based on the value just set above
   })
```

Notes:
- Enforcement only holds if the connection is NOT a Postgres superuser
  (superusers unconditionally bypass RLS regardless of policy — see
  DECISIONS.md D12, which was a real bug caught during Task 4). App runtime
  must use `createDbClient` wired to `DATABASE_URL` (`career_intel_app`
  role), never `MIGRATIONS_DATABASE_URL`.
- The cast `tx as unknown as DbClient` exists because `db.transaction`'s
  callback receives a transaction-scoped client type that isn't structurally
  identical to `DbClient`, but is used identically for query purposes.
