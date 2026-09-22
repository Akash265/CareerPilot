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
`dashboard` | `error` → `reviewing`) and drives which of `UploadForm`,
`ReviewForm`, or `ProfileDashboard` is on screen. On mount it calls
`GET /api/profile` (see §4c) to decide whether to start at `upload` (no
profile yet) or `dashboard` (profile exists); a non-2xx response or a
network failure goes to `error` (a message + Retry button) rather than
being misread as "no profile yet". From `upload`, `UploadForm` offers a
"Start with a blank profile instead" button (`createBlankProfile()` in
`ReviewForm.tsx`) alongside the file upload, so a failed/skipped extraction
is never a dead end.

### 4a. Upload + AI extraction

```
UploadForm.handleUpload()                    [apps/web/src/app/profile/UploadForm.tsx]
└─ fetch POST /api/profile/resume  (multipart FormData, field "file")
   └─ route.ts: POST()                       [apps/web/src/app/api/profile/resume/route.ts]
      ├─ loadEnv()                           [@ai-career/config]
      ├─ validate: file present; declared Content-Length ≤ 10MB + 64KB slack
      │  (rejected BEFORE request.formData() buffers the body — the slack
      │  accounts for multipart envelope overhead, which is real bytes on
      │  top of the file itself, so a file at exactly the 10MB cap doesn't
      │  get incorrectly rejected); then file.size ≤ 10MB exactly (the real,
      │  authoritative limit, checked after formData() parses it)
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
      │     .returning id  (mimeType = the SNIFFED type from fileType, never
      │        the client-supplied file.type, per D15's don't-trust-the-
      │        client-header rule)
      ├─ [inside the handled try/catch below — a corrupt-but-well-sniffed
      │   file must produce the status:"failed" response, not a 500]
      ├─ extractText(buffer, fileType)       [@ai-career/ai]
      │  └─ pdf/docx → library-based text extraction; tex → read as UTF-8
      │     plain text with no stripping (D15)
      ├─ createAnthropicClient(env)          [@ai-career/ai]
      ├─ extractWithRetry(anthropic, env, text)   [route.ts local helper]
      │  └─ extractProfileFromResume(anthropic, env, text)   [@ai-career/ai]
      │     ├─ generates a per-call random delimiter tag
      │     │  (`resume_text_<16 hex chars>`) and wraps resumeText in it,
      │     │  with a system prompt framing that tag's content as untrusted
      │     │  data — a FIXED tag name would let a resume containing the
      │     │  literal closing tag escape the block early (D20)
      │     ├─ calls Anthropic (fast/cheap tier per D7) with a structured
      │     │  extraction prompt → parses/validates response against the
      │     │  ResumeExtractionDraft schema (Zod)
      │     ├─ on schema validation failure → throws ExtractionValidationError
      │     │  → extractWithRetry retries the call exactly once, then
      │     │  propagates a second failure
      │     └─ success → returns ResumeExtractionDraft (contact, education,
      │        workExperiences[+bullets], skills, projects, certifications,
      │        achievements — no yearsOfExperience or workAuthorizationNotes;
      │        those are review-only fields with no signal in resume text,
      │        defaulted to null by ReviewForm's `toEditableProfile`)
      ├─ on success: withUserContext(... set extractionStatus:"extracted")
      │  → NextResponse.json({ resumeDocumentId, status:"extracted", draft })
      │  (draft is NOT persisted to any profile table here — D15's mandatory
      │  review gate)
      └─ on extraction failure: withUserContext(... set extractionStatus:
         "failed", extractionError) → 200 response with status:"failed"
         (resume stays uploaded/active). UploadForm surfaces `body.error`
         and leaves the user on the upload stage, where they can retry with
         a different file OR click "Start with a blank profile instead"
         (`createBlankProfile()` → `ProfileClient` sets `editableProfile`
         and jumps straight to `reviewing`, same as a successful extraction
         would) — the design spec's "manual-entry fallback" (POST
         /api/profile/confirm accepting a hand-built profile) now has a real
         UI entry point, not just API support.
UploadForm receives { status:"extracted", draft } → calls onExtracted(draft)
└─ ProfileClient: toEditableProfile(draft)   [apps/web/src/app/profile/ReviewForm.tsx]
   └─ merges the draft with null defaults for the review-only fields
      (yearsOfExperience, workAuthorizationNotes) → EditableProfile
   └─ setStage("reviewing")  → renders <ReviewForm initialProfile=... />
```

### 4b. Review + confirm (persist)

```
ReviewForm (user edits EditableProfile fields, then clicks confirm)
└─ handleConfirm()                           [apps/web/src/app/profile/ReviewForm.tsx]
   └─ fetch POST /api/profile/confirm  (JSON body = the full EditableProfile)
      └─ route.ts: POST()                    [.../api/profile/confirm/route.ts]
         ├─ loadEnv()
         ├─ readJsonBody(request)   [.../lib/readJsonBody.ts] — a body that
         │     is not valid JSON is a 400 (PATCH /api/profile does the same)
         ├─ ConfirmedProfileSchema.safeParse(body)   [.../lib/profile/
         │     confirmedProfileSchema.ts] — Zod validation; 400 on failure
         └─ saveConfirmedProfile(env, parsed.data)   [.../lib/profile/
               saveProfile.ts]
            ├─ createDbClient(env)   (pool closed in this function's
            │     `finally`, so no route needs to close it — see §4e)
            └─ TRANSACTION 1 — withUserContext(db, DEFAULT_USER_ID, async tx => {
               ├─ tx.insert(candidateProfiles).values({...})
               │     .onConflictDoUpdate({target: userId, set: {...}})
               │  (full upsert of the 1:1 scalar row — contact fields,
               │  yearsOfExperience, workAuthorizationNotes; D14. The
               │  preference/salary/company-list columns this table used to
               │  carry were retired in Task 4 — superseded by
               │  career_goal_constraints, see §5)
               ├─ tx.delete(...) on education, workExperienceBullets,
               │     workExperiences, skills, projects, certifications,
               │     achievements
               │  (full-replace strategy: every confirm/edit wipes and
               │  re-inserts these normalized child tables — same code path
               │  serves both first-time confirm and later edits, see §4d)
               ├─ re-insert loop per section (education, workExperiences
               │     +bullets, skills, projects, certifications, achievements)
               │     — each insert .returning({id}) so the new row id can be
               │     referenced
               ├─ deriveFact(sourceType, sourceId, factText)   [.../lib/
               │     profile/deriveFacts.ts] called once per atomic item
               │     (D16: facts derive from the CONFIRMED profile, not raw
               │     resume text) → { sourceType, sourceId, factText,
               │     contentHash } (contentHash = hash of factText, D16's
               │     reuse key)
               └─ tx.select().from(profileFacts)  → existing rows, indexed
                     by contentHash, to detect which facts are unchanged
                     AND already have a real (non-null) embedding — see the
                     next step; a hash match alone is not enough (D20)
               }) ← TRANSACTION 1 COMMITS HERE. The confirmed profile is now
                    durable regardless of what the embedding provider does
                    next (design spec §7: "Voyage embedding failure during
                    confirm → the profile data still commits").
            ├─ OUTSIDE any transaction:
            │  embedTexts(env, [facts needing embedding])   [@ai-career/ai,
            │     Voyage AI per D7] → a fact needs embedding if its hash is
            │     unmatched OR the matched existing row's embedding is null
            │     (D20 — a fact that failed to embed on a previous save is
            │     retried here, not treated as permanently "already
            │     handled"). Unchanged facts with a REAL cached embedding
            │     reuse their existing embedding + embeddingModel, never
            │     re-calling Voyage for identical text. Wrapped in try/catch:
            │     a Voyage failure degrades to an all-null embedding list
            │     instead of throwing, so the save still completes.
            │     Deliberately NOT logged — the error text can contain fact
            │     text (PII), which the spec §6 / CLAUDE.md §9 forbid logging.
            └─ TRANSACTION 2 — withUserContext(db, DEFAULT_USER_ID, async tx => {
               ├─ tx.delete(profileFacts)  (full-replace, mirrors the
               │     normalized-table strategy above)
               └─ tx.insert(profileFacts).values({sourceType, sourceId,
                     factText, embedding, embeddingModel, contentHash})
                  per fact — embedding = the reused cached vector when a
                  real one existed, else the freshly computed one, else null
                  when the Voyage call failed (the column is nullable
                  precisely so these rows can be back-filled/retried on a
                  later save — D20). embeddingModel is only ever set
                  alongside a real embedding, never stamped onto a null one.
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
         │  workExperienceBullets, education, skills, projects,
         │  certifications, achievements (all scoped to the RLS-filtered
         │  transaction)
         ├─ returns null if no candidateProfiles row exists yet (drives
         │  ProfileClient's upload-vs-dashboard branch)
         └─ reshapes every section into the same ID-free plain-object shape
            ConfirmedProfileSchema accepts, each list ordered by its own
            `displayOrder` column (D20) — education, workExperiences,
            skills, projects, certifications, and achievements all get an
            explicit `ORDER BY`; workExperienceBullets already did (pre-dates
            D20)
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
`EditableProfile` — contact (5 text inputs), preferences (a
years-of-experience number input and a work-authorization notes textarea),
plus add/remove repeating groups for
education, work experience (with a one-bullet-per-line textarea), skills,
projects, certifications and achievements. Conversion happens at the edges:
`orNull`/`orNullNumber` on each change (blank input ⇒ `null`), and a single
`toPayload()` pass immediately before `fetch` that strips the placeholder
empty entries the bullet and achievement editors keep around so a newline
the user just typed isn't swallowed by the controlled input. `ProfileDashboard`
mirrors the same field set read-only.

### 4e. Postgres connection-pool lifecycle (cross-cutting)

```
createDbClient(env)                        [packages/db/src/client.ts]
└─ postgres(env.DATABASE_URL) → a NEW connection pool on every call
closeDbClient(db)                          [packages/db/src/client.ts]
└─ db.$client?.end(), wrapped in try/catch so a failing close can never
   mask the caller's own result/error
```

Every caller that creates a client owns closing it once the request's DB
work is done, via the shared `closeDbClient` (D20 — this replaced four
near-identical inline `try { await db.$client?.end() } catch {}` copies).
Callers doing this today:

- `GET /api/health`               [.../api/health/route.ts] — original site of
  the pattern, now using `closeDbClient` too
- `GET /api/profile`              [.../api/profile/route.ts]
- `POST` / `DELETE /api/profile/resume` [.../api/profile/resume/route.ts]
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
  `POST /api/profile/confirm` unchanged. (Note: `candidate_profiles` today
  only carries `contact`, `yearsOfExperience`, and `workAuthorizationNotes`
  as scalar fields — the salary/company-preference columns and the whole
  `company_preferences` table referenced in earlier revisions of this doc
  were retired in Task 4; see DECISIONS.md and §5 for their replacement,
  `career_goal_constraints`.)
- `DELETE /api/profile/resume` (same route file as §4a's `POST`) deactivates
  by deleting the active `resumeDocuments` row and its MinIO object; it does
  not touch `candidateProfiles` or any other profile table — resume-file
  deletion and confirmed-profile data are independent lifecycles.

---

## 5. Career Goal: enter → AI parse → review → confirm → dashboard (request-driven)

Entry point (browser): `apps/web/src/app/career-goal/page.tsx` renders
`CareerGoalClient` (`apps/web/src/app/career-goal/CareerGoalClient.tsx`), a
client component that owns a `Stage` state machine and drives which of
`GoalForm`, `GoalReviewForm`, or `GoalDashboard` is on screen. On mount it
calls `GET /api/career-goal` and moves `loading` → `form` (no confirmed goal
yet), `dashboard`, or `error` (whose Retry button returns to `loading`).
A successful parse moves `form` → `reviewing`; "Edit my statement" on the
review screen moves `reviewing` → `form` with the statement prefilled and
nothing saved; after a confirm the client re-fetches the goal state and lands
on `dashboard`; "Edit Goal" moves `dashboard` → `form` with the current raw
text prefilled (D23 — an edit is a new parse, never an in-place change).
The home page (`apps/web/src/app/page.tsx`) links to `/profile` and
`/career-goal`, the two steps of the user journey.

### 5a. Enter + AI parse

```
GoalForm.handleSubmit()                          [apps/web/src/app/career-goal/GoalForm.tsx]
└─ fetch POST /api/career-goal/parse  { rawText }
   └─ route.ts: POST()                            [apps/web/src/app/api/career-goal/parse/route.ts]
      ├─ loadEnv()                                [@ai-career/config]
      ├─ readJsonBody(request)                     [lib/readJsonBody.ts]
      │  └─ body not parseable as JSON → 400 (never a bare 500)
      ├─ validate: rawText a non-empty string, ≤ 4000 chars — 400 before any
      │  DB/AI work (a JSON body with no string rawText counts as empty)
      ├─ withUserContext(db, ..., tx => ...)       [@ai-career/db]
      │  ├─ lockUserCareerGoals(tx, userId)        [lib/career-goal/lockUserCareerGoals.ts]
      │  │  └─ pg_advisory_xact_lock, held to commit: simultaneous parses
      │  │     cannot read the same max(version) and share a version (D29)
      │  ├─ select max(version) for this user, compute nextVersion
      │  └─ insert career_goals {rawText, version: nextVersion,
      │        parseStatus: "pending"} .returning id, version   (D24)
      ├─ createAnthropicClient(env)                [@ai-career/ai]
      ├─ extractWithRetry(anthropic, env, rawText)  [route.ts local helper]
      │  └─ extractCareerGoal(anthropic, env, rawText)   [@ai-career/ai]
      │     ├─ per-call random delimiter tag (`career_goal_text_<16 hex>`),
      │     │  system prompt frames it as untrusted data (same D20 pattern
      │     │  extractProfile.ts uses for resume text)
      │     ├─ forced tool_choice → Zod-validated CareerGoalExtractionDraft
      │     │  (targetRoles, seniority, locations, workMode,
      │     │  minExperienceYears, employmentType, salaryFloorRaw and
      │     │  salaryTargetRaw [raw phrases, never numbers — D22; the
      │     │  minimum vs the preferred/ideal pay, D28], visaSponsorshipRequired,
      │     │  skills, preferred/excludedIndustries,
      │     │  preferred/excludedCompanies, hardConstraints)
      │     ├─ schema validation failure → CareerGoalExtractionValidationError
      │     │  → extractWithRetry retries once, then propagates
      │     └─ success → returns CareerGoalExtractionDraft
      ├─ on extraction failure (after retry): update career_goals
      │  {parseStatus: "failed", parseError} → respond 200
      │  {goalId, version, status: "failed", error}  (handled outcome, D24).
      │  parseError is the validation message for a schema failure, but only
      │  the error CLASS name (e.g. "APIConnectionError") for anything else —
      │  an SDK/network message can echo the user's goal text (D29)
      ├─ on success: update career_goals {parseStatus: "parsed"}
      ├─ parseSalaryFloor(extracted.salaryFloorRaw) and
      │  parseSalaryFloor(extracted.salaryTargetRaw)   [@ai-career/ai]
      │  └─ deterministic {amount, currency, isParsed} for each (D22, D25) —
      │     merged into the response draft as salaryFloorNormalized/
      │     salaryCurrency/salaryIsParsed and salaryTargetNormalized/
      │     salaryTargetCurrency/salaryTargetIsParsed. The draft is typed as
      │     CareerGoalConstraintsInput, so it cannot drift from what confirm
      │     accepts. isParsed is true only when exactly one currency
      │     is named, the number's grouping/decimal format is unambiguous,
      │     no scale word (million, lakh, ...) or non-annual period (hour,
      │     day, week, month) contradicts it, and the amount is ≥ 1000;
      │     anything else keeps the pieces it found but isParsed: false, so
      │     GoalReviewForm shows its "please confirm" warning
      └─ respond 200 {goalId, version, rawText, status: "parsed", draft}
         (career_goal_constraints NOT written yet)
```

### 5b. Review + confirm

```
GoalReviewForm.handleConfirm()                   [apps/web/src/app/career-goal/GoalReviewForm.tsx]
└─ fetch POST /api/career-goal/confirm  { goalId, constraints }
   └─ route.ts: POST()                            [apps/web/src/app/api/career-goal/confirm/route.ts]
      ├─ readJsonBody(request) → not valid JSON → 400   [lib/readJsonBody.ts]
      ├─ ConfirmCareerGoalSchema.safeParse(body)  [lib/career-goal/careerGoalConstraintsSchema.ts]
      │  └─ fails → formatValidationError → 400   [lib/formatValidationError.ts]
      │     (includes: a preferred salary lower than the minimum salary in
      │     the same currency is rejected, D28)
      └─ confirmCareerGoal(env, goalId, constraints)  [lib/career-goal/saveCareerGoal.ts]
         └─ withUserContext(db, ..., tx => ...)
            ├─ lockUserCareerGoals(tx, userId) — simultaneous confirms of
            │  ANY of this user's goals serialize, so two goals can never
            │  both end up active (D29)
            ├─ select career_goals by id FOR UPDATE (row lock: two
            │  simultaneous confirms of one goal serialize)
            │  ├─ not found → CareerGoalNotFoundError → 404
            │  ├─ confirmationStatus already "confirmed" →
            │  │  CareerGoalStateError("already-confirmed") → 409
            │  └─ parseStatus not "parsed" (failed/pending) →
            │     CareerGoalStateError("not-parsed") → 409  (D26)
            ├─ update career_goals set is_active=false where is_active=true
            │  (deactivates whichever goal was previously active)
            ├─ insert career_goal_constraints {careerGoalId, ...all 21
            │  structured fields, incl. the preferred salary} — a brand-new row every confirm (D23);
            │  never an update to an existing career_goal_constraints row
            └─ update career_goals set confirmationStatus="confirmed",
               is_active=true, confirmedAt=now() where id=goalId
```

### 5c. Dashboard read

```
CareerGoalClient (on mount, and after onConfirmed())
└─ fetch GET /api/career-goal
   └─ route.ts: GET()                              [apps/web/src/app/api/career-goal/route.ts]
      └─ getCareerGoalState(tx)                    [lib/career-goal/serializeCareerGoal.ts]
         ├─ select career_goals where confirmationStatus="confirmed",
         │  order by version desc
         ├─ activeGoal = the row with is_active=true (its
         │  career_goal_constraints row fetched by a second select and
         │  numeric-coerced; an active goal with no constraints row throws —
         │  it cannot occur short of tampering, and "no goal" would look
         │  like data loss)
         └─ history = every confirmed goal's {id, version, rawText,
            confirmedAt}, newest first
```

---

## 6. Job ingestion: sources → queue → worker → normalized jobs → browser (Phase 4)

Three processes cooperate and share only Postgres and Redis: the Next.js web app (managing sources,
enqueueing, reading jobs), the `services/job-ingestion` worker (fetching and writing jobs), and the
databases themselves. Domain logic lives in `packages/ingestion`; the worker only maps error classes
onto BullMQ's retry model (D32). Paths below are relative to `apps/web/src` unless a package is named.

### 6a. Managing sources and queueing a run (request-driven)

```
POST /api/job-sources                     app/api/job-sources/route.ts: POST()
├─ readJsonBody → CreateJobSourceSchema.safeParse        (400 on bad JSON / kind / slug)
├─ createDbClient → withUserContext(DEFAULT_USER_ID)
│  └─ insert job_sources { enabled:false, consent_confirmed_at:null }   (unique violation 23505 → 409)
└─ serializeSource → 201

PATCH /api/job-sources/[id]               app/api/job-sources/[id]/route.ts: PATCH()   (params is a Promise)
├─ id not a UUID → 404 · readJsonBody / UpdateJobSourceSchema → 400
└─ enabling with no stored consent and consentConfirmed !== true → 400 (D3);
   else set enabled; consent_confirmed_at is stamped on the first enable and never cleared

POST /api/job-sources/[id]/run            app/api/job-sources/[id]/run/route.ts: POST()
├─ id not a UUID → 404 · unknown source → 404 · not enabled → 409 · no consent → 409
└─ enqueueIngestion(env, id)              lib/job-ingestion/enqueue.ts
   ├─ producer connection: maxRetriesPerRequest 1, no offline queue, no reconnect; whole call
   │  guarded by a 5 s timeout; ANY failure → Error("queue unavailable")  (no host or port in it)
   ├─ Queue.getJob(ingestJobId(id)) still waiting/active/delayed? → "already_queued"
   ├─ Queue.add("ingest-source", { sourceId }, { jobId: "ingest-<sourceId>", attempts:3,
   │            exponential backoff 30 s, removeOnComplete, removeOnFail })
   └─ result: "queue unavailable" → 503 · "already_queued" → 409 · "enqueued" → 202 {status:"queued"}

POST /api/job-sources/upload              app/api/job-sources/upload/route.ts: POST()
├─ content-length over 10 MB (+64 KB slack) → 400 before the body is buffered
├─ formData → file present and file.size ≤ 10 MB → consentConfirmed === "true" (else 400, D3)
├─ parseUploadFile(buffer, name)           packages/ingestion/src/adapters/upload.ts
│  └─ binary/JSON/CSV parse, 5,000-row cap, alias headers → UploadRowSchema, id hashing, dedupe
│     (UploadParseError → 400 with a content-free message)
├─ withUserContext → storeUpload           packages/ingestion/src/pipeline/storeUpload.ts
│  └─ insert upload job_sources (enabled, consent stamped) + raw_job_postings in chunks of 500
└─ enqueueIngestion; if it throws → the records stay stored, response is 201 with queued:false
   (the user can press "Run now" later); otherwise 201 with queued:true
```

### 6b. The worker (process-driven)

```
pnpm --filter @ai-career/job-ingestion start          services/job-ingestion/src/main.ts: main()
├─ loadEnv → createDbClient → IORedis(maxRetriesPerRequest:null) → Queue("job-ingestion")
│  → createAdapterFor(db, userId, GREENHOUSE_API_BASE, LEVER_API_BASE) → createIngestWorker
├─ reconcileSchedules(refresh:true) at boot, then refresh:false every 60 s   reconcile.ts + schedule.ts
│  ├─ select enabled + consented + non-upload sources; planSchedules() diffs them against
│  │  Queue.getJobSchedulers()  (only schedulers with the "schedule-" prefix are ever removed)
│  ├─ upsertJobScheduler("schedule-<sourceId>", { every: INGEST_INTERVAL_MINUTES }, job template)
│  │  Creating a scheduler fires its first run at once, so enabling a source starts a fetch on the
│  │  next tick (within ~60 s). Scheduled jobs carry ids "repeat:<schedulerId>:<time>", NOT the
│  │  manual "ingest-<sourceId>" id, so a scheduled and a manual run of one source can both exist
│  └─ removeJobScheduler for a source that was disabled or deleted
└─ Worker("job-ingestion", concurrency 1)               services/job-ingestion/src/worker.ts
   └─ runIngestion(db, { userId, sourceId, adapterFor })   packages/ingestion/src/pipeline/runIngestion.ts
      ├─ sourceId not a UUID → IngestError("not_found"); source row missing → same (nothing recorded)
      ├─ insert ingestion_runs (started_at; status defaults to running)
      ├─ GUARD: !enabled → "source_disabled"; !consent → "consent_missing"
      │  → best-effort finish as failed, then throw IngestError  (D3, D37)
      ├─ try {
      │  for await record of adapterFor(ref).fetch(ref)
      │  ├─ greenhouse: fetchJson(base/v1/boards/<slug>/jobs?content=true) → envelope schema → jobs
      │  ├─ lever: fetchJson(base/v0/postings/<slug>?mode=json) → array → postings
      │  │  fetchJson: 30 s timeout, 25 MB cap, redirects refused, class-only IngestError; slug via assertValidSlug
      │  ├─ upload: the stored raw_job_postings rows of that source
      │  └─ per record, one withUserContext transaction:
      │     ├─ externalId longer than MAX_EXTERNAL_ID_CHARS (200)? → counted as failed and skipped BEFORE
      │     │  anything is stored (the raw table's unique btree would throw and brick every run)
      │     ├─ hashPayload + upsert raw_job_postings, inside a SAVEPOINT (tx.transaction): a NUL byte or a
      │     │  pathologically deep payload fails just this record (counted as failed), never the whole
      │     │  transaction -- a plain try/catch here does not suffice with postgres.js (D41)
      │     ├─ normalizeRecord(ref, record)              normalize/normalizeRecord.ts (pure)
      │     │  └─ per-kind schema → escapedHtmlToText / htmlToText · companyKey/titleKey/locationKey/
      │     │     descriptionHash · extractSalary · extractMinExperience · extractSponsorship ·
      │     │     detectWorkMode   (throws NormalizeError → counted as failed; an already-tracked
      │     │     posting still gets last_seen_at bumped so it is not closed)
      │     └─ persistPosting                            pipeline/persistPosting.ts
      │        ├─ tier 1: (source, external id) exists? unchanged content_hash → touch last_seen_at
      │        │          (and recompute the job if the posting had been closed); else update
      │        ├─ tier 2: no existing posting and the same fingerprint on any posting → link to that job;
      │        │          else insert a new jobs row
      │        ├─ upsert job_postings (normalized snapshot, fingerprint, content_hash)
      │        ├─ recomputeJob → deserializeNormalized validates each stored snapshot's shape (D42),
      │        │  excluding any posting whose snapshot fails it, before mergePostings → update jobs
      │        │  (+ field_provenance, status, closed_at); if every posting is excluded, the job is left as-is
      │        └─ tier 3 (new job only): flagFuzzyDuplicates → job_duplicate_candidates (pending)
      │           (best 20 same-location look-alikes by similarity; a bounded scan, not index-accelerated)
      │  complete = fetched > 0                            (a zero-record fetch is NOT complete)
      │  if complete and kind ≠ upload → closeMissingPostings (open postings with last_seen < run start;
      │                                  recompute each affected job)
      │  } catch (any error above, closing step included)
      │     → best-effort finish as failed/incomplete with the error class ("unknown" if it was not an
      │       IngestError), rethrow the IngestError. The recording write cannot replace the class.
      ├─ finish("succeeded", complete, complete ? null : "empty_result")
      │  ingestion_runs counters + job_sources.last_run_at/status/error class (class only, never a message)
      │  └─ if that final write itself fails → best-effort mark failed/"unknown", throw IngestError("unknown")
      └─ returns RunSummary
   worker error mapping: IngestError with retryable = false (consent_missing, source_disabled,
   invalid_slug, not_found, http_error, response_too_large, schema_mismatch) → UnrecoverableError, no retry;
   retryable (rate_limited, server_error, network, timeout, unknown) → BullMQ retries, exponential
   backoff from 30 s, 3 attempts. Every attempt has its own ingestion_runs row.
```

### 6c. Reading jobs (request-driven)

```
GET /api/jobs?q&status&sourceId&page     app/api/jobs/route.ts → ListJobsQuerySchema (400 on bad query)
                                         → listJobs(tx, query): title/company ILIKE, status (default open),
                                           postings-by-source filter, 25 per page, newest posted first
GET /api/jobs/[id]                       app/api/jobs/[id]/route.ts → non-UUID / unknown → 404
                                         → getJobDetail(tx, id): job + its postings + duplicate candidates
GET /api/job-sources                     → listJobSourceViews: latest FINISHED run per source for the counters;
                                           a `running` row younger than 30 min (and newer than that run) makes
                                           the view lastRunStatus "running" with lastRun null (older = crashed run)
/sources → SourcesClient → /api/job-sources*    /jobs → JobsClient → /api/jobs    /jobs/[id] → JobDetailClient
```

Not part of this flow: nothing reads `job_duplicate_candidates` to merge or resolve them (they are
displayed only, D36), and nothing calls an LLM or embeds a job at ingest time (D33).
