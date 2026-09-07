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

---

## 4. Candidate Profile: upload → AI extraction → review → confirm → dashboard (request-driven)

Entry point (browser): `apps/web/src/app/profile/page.tsx` renders
`ProfileClient` (`apps/web/src/app/profile/ProfileClient.tsx`), a client
component that owns a `Stage` state machine (`loading` → `upload` |
`dashboard` → `reviewing`) and drives which of `UploadForm`, `ReviewForm`,
or `ProfileDashboard` is on screen. On mount it calls `GET /api/profile`
(see §4c) to decide whether to start at `upload` (no profile yet) or
`dashboard` (profile exists).

### 4a. Upload + AI extraction

```
UploadForm.handleUpload()                    [apps/web/src/app/profile/UploadForm.tsx]
└─ fetch POST /api/profile/resume  (multipart FormData, field "file")
   └─ route.ts: POST()                       [apps/web/src/app/api/profile/resume/route.ts]
      ├─ loadEnv()                           [@ai-career/config]
      ├─ validate: file present, size ≤ 10MB (else 400, before any I/O)
      ├─ detectResumeFileType(buffer, file.name)   [@ai-career/ai]
      │  └─ content-sniffs magic bytes (not just the extension/MIME header,
      │     per DECISIONS.md D15's security note) → "pdf" | "docx" | "tex"
      │  └─ throws UnsupportedFileTypeError → caught → 400
      ├─ createStorageClient(env)            [@ai-career/storage, MinIO/S3 client]
      ├─ createDbClient(env)                 [@ai-career/db]
      ├─ uploadResume(storageClient, { userId: env.DEFAULT_USER_ID, buffer,
      │                                 fileExtension: fileType })
      │  └─ [@ai-career/storage] writes object under a UUID-derived key
      │     (never the original filename — DECISIONS.md D15 security note)
      │     → returns { objectKey }
      ├─ withUserContext(db, DEFAULT_USER_ID, tx => ...)   [@ai-career/db]
      │  ├─ tx.update(resumeDocuments).set({isActive:false}).where(isActive=true)
      │  │  (deactivates any prior resume — D18: single active resume)
      │  └─ tx.insert(resumeDocuments).values({objectKey, originalFilename,
      │        mimeType, fileSizeBytes, extractionStatus:"pending", isActive:true})
      │     .returning id
      ├─ [inside the handled try/catch below — a corrupt-but-well-sniffed
      │   file must produce the status:"failed" response, not a 500]
      ├─ extractText(buffer, fileType)       [@ai-career/ai]
      │  └─ pdf/docx → library-based text extraction; tex → read as UTF-8
      │     plain text with no stripping (D15)
      ├─ createAnthropicClient(env)          [@ai-career/ai]
      ├─ extractWithRetry(anthropic, env, text)   [route.ts local helper]
      │  └─ extractProfileFromResume(anthropic, env, text)   [@ai-career/ai]
      │     ├─ calls Anthropic (fast/cheap tier per D7) with a structured
      │     │  extraction prompt → parses/validates response against the
      │     │  ResumeExtractionDraft schema (Zod)
      │     ├─ on schema validation failure → throws ExtractionValidationError
      │     │  → extractWithRetry retries the call exactly once, then
      │     │  propagates a second failure
      │     └─ success → returns ResumeExtractionDraft (contact, education,
      │        workExperiences[+bullets], skills, projects, certifications,
      │        achievements — no preferences/salary/company lists; those are
      │        review-only fields with no signal in resume text, defaulted
      │        by ReviewForm's `toEditableProfile`)
      ├─ on success: withUserContext(... set extractionStatus:"extracted")
      │  → NextResponse.json({ resumeDocumentId, status:"extracted", draft })
      │  (draft is NOT persisted to any profile table here — D15's mandatory
      │  review gate)
      └─ on extraction failure: withUserContext(... set extractionStatus:
         "failed", extractionError) → 200 response with status:"failed"
         (resume stays uploaded/active). UploadForm surfaces `body.error`
         and leaves the user on the upload stage to retry with a different
         file. There is currently NO manual-entry entry point: ProfileClient
         only advances to `reviewing` on a successful extraction or on an
         already-saved profile fetched by GET /api/profile, so a user with
         neither cannot reach ReviewForm at all. (The design spec's
         "manual-entry fallback" — POST /api/profile/confirm accepting a
         hand-built profile — is supported by the API and by ReviewForm's
         now-complete field coverage, but no UI affordance starts a blank
         profile without an upload. Not implemented in this phase.)
UploadForm receives { status:"extracted", draft } → calls onExtracted(draft)
└─ ProfileClient: toEditableProfile(draft)   [apps/web/src/app/profile/ReviewForm.tsx]
   └─ merges the draft with zero-valued defaults for review-only fields
      (preferences, salary, visa, company lists) → EditableProfile
   └─ setStage("reviewing")  → renders <ReviewForm initialProfile=... />
```

### 4b. Review + confirm (persist)

```
ReviewForm (user edits EditableProfile fields, then clicks confirm)
└─ handleConfirm()                           [apps/web/src/app/profile/ReviewForm.tsx]
   └─ fetch POST /api/profile/confirm  (JSON body = the full EditableProfile)
      └─ route.ts: POST()                    [.../api/profile/confirm/route.ts]
         ├─ loadEnv()
         ├─ ConfirmedProfileSchema.safeParse(body)   [.../lib/profile/
         │     confirmedProfileSchema.ts] — Zod validation; 400 on failure
         └─ saveConfirmedProfile(env, parsed.data)   [.../lib/profile/
               saveProfile.ts]
            ├─ createDbClient(env)   (pool closed in this function's
            │     `finally`, so no route needs to close it — see §4e)
            └─ TRANSACTION 1 — withUserContext(db, DEFAULT_USER_ID, async tx => {
               ├─ tx.insert(candidateProfiles).values({...})
               │     .onConflictDoUpdate({target: userId, set: {...}})
               │  (full upsert of the 1:1 scalar/preference row — D14)
               ├─ tx.delete(...) on education, workExperienceBullets,
               │     workExperiences, skills, projects, certifications,
               │     achievements, companyPreferences
               │  (full-replace strategy: every confirm/edit wipes and
               │  re-inserts these normalized child tables — same code path
               │  serves both first-time confirm and later edits, see §4d)
               ├─ re-insert loop per section (education, workExperiences
               │     +bullets, skills, projects, certifications, achievements,
               │     preferred/excluded companyPreferences) — each insert
               │     .returning({id}) so the new row id can be referenced
               ├─ deriveFact(sourceType, sourceId, factText)   [.../lib/
               │     profile/deriveFacts.ts] called once per atomic item
               │     (D16: facts derive from the CONFIRMED profile, not raw
               │     resume text) → { sourceType, sourceId, factText,
               │     contentHash } (contentHash = hash of factText, D16's
               │     reuse key)
               └─ tx.select().from(profileFacts)  → existing rows, indexed
                     by contentHash, to detect which facts are unchanged
               }) ← TRANSACTION 1 COMMITS HERE. The confirmed profile is now
                    durable regardless of what the embedding provider does
                    next (design spec §7: "Voyage embedding failure during
                    confirm → the profile data still commits").
            ├─ OUTSIDE any transaction:
            │  embedTexts(env, [unmatched facts' text])   [@ai-career/ai,
            │     Voyage AI per D7] → embeddings only for NEW/changed fact
            │     text (D16's embedding-cache reuse — unchanged facts reuse
            │     their existing embedding + embeddingModel, never re-call
            │     Voyage for identical text). Wrapped in try/catch: a Voyage
            │     failure degrades to an all-null embedding list instead of
            │     throwing, so the save still completes. Deliberately NOT
            │     logged — the error text can contain fact text (PII), which
            │     the spec §6 / CLAUDE.md §9 forbid logging.
            └─ TRANSACTION 2 — withUserContext(db, DEFAULT_USER_ID, async tx => {
               ├─ tx.delete(profileFacts)  (full-replace, mirrors the
               │     normalized-table strategy above)
               └─ tx.insert(profileFacts).values({sourceType, sourceId,
                     factText, embedding, embeddingModel, contentHash})
                  per fact — embedding = the reused cached vector when the
                  content hash matched, else the freshly computed one, else
                  null when the Voyage call failed (the column is nullable
                  precisely so these rows can be back-filled later)
               })
               → returns { factsGenerated: facts.length }
         └─ NextResponse.json({ status:"saved", factsGenerated })
ReviewForm: body.status === "saved" → onSaved()
└─ ProfileClient: loadProfile() → re-fetches GET /api/profile → setStage(
      "dashboard") once a profile comes back
```

### 4c. Dashboard read

```
ProfileClient (on mount, and again after onSaved())
└─ fetch GET /api/profile
   └─ route.ts: GET()                        [.../api/profile/route.ts]
      ├─ loadEnv(); createDbClient(env)   (closed in a `finally` — see §4e)
      └─ withUserContext(db, DEFAULT_USER_ID, tx => serializeProfile(tx))
            [.../lib/profile/serializeProfile.ts]
         ├─ selects candidateProfiles, workExperiences,
         │  workExperienceBullets, companyPreferences, education, skills,
         │  projects, certifications, achievements (all scoped to the
         │  RLS-filtered transaction)
         ├─ returns null if no candidateProfiles row exists yet (drives
         │  ProfileClient's upload-vs-dashboard branch)
         ├─ coerces `numeric` columns (salaryExpectationMin/Max) from the
         │  string form postgres-js returns back to `number`, so the same
         │  shape can round-trip straight into ConfirmedProfileSchema on a
         │  later PATCH/confirm without a validation failure
         └─ reshapes every section into the same ID-free plain-object shape
            ConfirmedProfileSchema accepts (bullets flattened to string[]
            sorted by displayOrder, achievements flattened to string[], etc.)
      → NextResponse.json({ profile })
ProfileClient: body.profile truthy → setStage("dashboard")
└─ renders <ProfileDashboard profile={editableProfile} onEdit={...} />
      [apps/web/src/app/profile/ProfileDashboard.tsx] — read-only display of
      all sections above.
```

### 4d. Edit path (reuses the confirm endpoint, not PATCH)

```
ProfileDashboard "Edit" button → onEdit()
└─ ProfileClient: setStage("reviewing")
   → renders <ReviewForm initialProfile={editableProfile} onSaved={...} />
     (the SAME already-fetched GET /api/profile response, pre-filled — no
     re-upload, no new extraction call)
User edits fields → handleConfirm() → toPayload(profile) → POST
   /api/profile/confirm
   (identical path to §4b — the full delete-and-re-insert save + fact
   re-derivation + embedding-cache reuse runs again)
```

`ReviewForm` renders an editable control for every field of
`EditableProfile` — contact (5 text inputs), preferences (number inputs, a
work-mode `<select>`, a visa checkbox, a notes textarea, and 5
comma-separated string-list inputs), plus add/remove repeating groups for
education, work experience (with a one-bullet-per-line textarea), skills,
projects, certifications and achievements. Conversion happens at the edges:
`orNull`/`orNullNumber` on each change (blank input ⇒ `null`), and a single
`toPayload()` pass immediately before `fetch` that strips the placeholder
empty entries the comma-list and bullet editors keep around so typing a
separator isn't swallowed by the controlled input. `ProfileDashboard`
mirrors the same field set read-only.

### 4e. Postgres connection-pool lifecycle (cross-cutting)

```
createDbClient(env)                        [packages/db/src/client.ts]
└─ postgres(env.DATABASE_URL) → a NEW connection pool on every call
```

Every caller therefore owns the pool it creates and closes it once the
request's DB work is done, via `db.$client?.end()` inside a `finally`,
wrapped in its own try/catch so a failing close can never change the
response. Callers doing this today:

- `GET /api/health`               [.../api/health/route.ts] — original site of
  the pattern
- `GET /api/profile`              [.../api/profile/route.ts] (local
  `closePool` helper)
- `POST` / `DELETE /api/profile/resume` [.../api/profile/resume/route.ts]
  (local `closePool` helper)
- `saveConfirmedProfile`          [.../lib/profile/saveProfile.ts] — closes
  its own pool, which is why `POST /api/profile/confirm` and
  `PATCH /api/profile` create none of their own

Notes:
- `PATCH /api/profile` (`.../api/profile/route.ts`) calls the same
  `saveConfirmedProfile` and is covered by its own route test, but nothing
  in the UI currently calls it — `ProfileDashboard`'s Edit button routes
  through `ReviewForm` → `POST /api/profile/confirm` instead, since both
  endpoints run the identical full-replace save path today (no partial-PATCH
  semantics exist yet; see DECISIONS.md D16, which anticipates `PATCH`
  eventually re-deriving/re-embedding only *changed* facts as a future
  optimization, not yet implemented).
- The extraction draft (§4a) and the confirmed/saved profile (§4b–d) are
  deliberately different shapes: `ResumeExtractionDraft` (AI-extracted,
  no preferences) vs. `EditableProfile` (draft + zero-valued preference
  defaults, edited client-side) vs. `ConfirmedProfile` (the same shape,
  Zod-validated server-side before persistence). `serializeProfile`'s output
  is shaped to satisfy `ConfirmedProfileSchema` directly so the dashboard's
  fetched profile can be handed straight back into `ReviewForm` and then
  `POST /api/profile/confirm` unchanged (see DECISIONS.md D19's note on the
  `numeric`-to-`number` coercion needed for this round-trip).
- `DELETE /api/profile/resume` (same route file as §4a's `POST`) deactivates
  by deleting the active `resumeDocuments` row and its MinIO object; it does
  not touch `candidateProfiles` or any other profile table — resume-file
  deletion and confirmed-profile data are independent lifecycles.
