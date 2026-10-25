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
         └─ withUserContext(db, ..., tx => ...)   — SECOND, separate call, only after
            │  the confirm transaction above has committed (Phase 5, D55)
            └─ ensureGoalEmbedding(tx, env, constraintsId)   [@ai-career/matching]
               → embedTexts() → Voyage call → stores career_goal_constraints
               .embedding/.embeddingModel on the row just inserted; ON FAILURE
               degrades to a no-op (embedding stays null) rather than throwing —
               a Voyage outage must not roll back the already-committed confirm.
               Idempotent; §7b's runMatching calls this same helper again as a
               lazy fallback for any row that still has no embedding by the
               time a matching run reads it.
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
      │     ├─ externalId longer than MAX_EXTERNAL_ID_CHARS (200) OR containing a NUL byte? → counted as
      │     │  failed and skipped BEFORE anything is stored (either would throw when bound as a text
      │     │  parameter anywhere past this point, including the last_seen_at bump just below -- D43)
      │     ├─ hashPayload + upsert raw_job_postings, inside a SAVEPOINT (tx.transaction): a NUL byte or a
      │     │  pathologically deep PAYLOAD fails just this record (counted as failed, and an already-
      │     │  tracked posting still gets last_seen_at bumped so it is not closed -- same protection as
      │     │  the normalize-failure branch below), never the whole transaction -- a plain try/catch here
      │     │  does not suffice with postgres.js (D41)
      │     ├─ normalizeRecord(ref, record)              normalize/normalizeRecord.ts (pure)
      │     │  └─ per-kind schema → escapedHtmlToText / htmlToText · companyKey/titleKey/locationKey/
      │     │     descriptionHash · extractSalary · extractMinExperience · extractSponsorship ·
      │     │     detectWorkMode   (throws NormalizeError → counted as failed; an already-tracked
      │     │     posting still gets last_seen_at bumped so it is not closed)
      │     │     assemble() ends by running hasUnsafeText (normalize/text.ts) over the FULLY ASSEMBLED
      │     │     record and throwing NormalizeError if any derived string holds a NUL byte or an
      │     │     unpaired surrogate -- the jsonb `normalized` column rejects both, and the normalizer
      │     │     itself can mint one by decoding an entity or slicing an emoji in half (D44). It reuses
      │     │     the normalize-failure branch above; no new branch was added to runIngestion.ts
      │     │     assemble() also runs the source's `url` through `safeHttpUrl` (the same
      │     │     `/^https?:\/\//i` check `createApplication.ts` and `ApplicationDetailClient.tsx`
      │     │     already used) and stores `null` for a `javascript:`/`data:`/other non-http(s) value --
      │     │     never rejects the record for this alone (D124, closes D113's known gap)
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

## 7. Hybrid matching: goal → score every open job → explain top N → ranked list (Phase 5)

Sections 7a/7b trace the pipeline this repo already had going into Task 16 (Phase 5, Tasks 1-14);
this entry documents it for the first time because Task 16's E2E smoke test is the first thing to
drive it end-to-end and needed to trace it to debug the run. 7c documents Task 16's own addition.

### 7a. Triggering and reading a run (request-driven)

```
POST /api/matches/run          app/api/matches/run/route.ts
                                → 409 if no confirmed, active career goal exists
                                → enqueueMatching(env, DEFAULT_USER_ID) → BullMQ "matching" queue
                                → 202 {status:"queued"} (409 if a run is already queued/running)
GET /api/matches/runs/latest   → most recent matching_runs row for the user
GET /api/matches?eligible=     → app/lib/matching/listMatches.ts: job_matches joined to jobs,
                                  eligible/ineligible filter, newest-scored first; the eligible view also
                                  requires jobs.status='open', so a job closed by ingestion leaves the
                                  ranked list before the next run re-scores it (D139)
PATCH /api/matches/[jobId]     → sets job_matches.userAction ("dismissed"/"saved"/etc) + userActionAt
                                  (read back on the NEXT run via evaluateEligibility's
                                  previouslyDismissed, not applied retroactively to the current row)
```

### 7b. The worker (process-driven) — `services/matching-worker/src/worker.ts` → `runMatching`

```
BullMQ "matching" job → packages/matching/src/pipeline/runMatching.ts
 ├─ guard: an active, confirmed career_goal_constraints row must exist, else MatchingError("no_active_goal")
 ├─ insert matching_runs (startedAt)
 ├─ ensureGoalEmbedding(tx, env, constraintsId) → Voyage embedding call; ON FAILURE degrades to a
 │  null embedding rather than throwing (matches CLAUDE.md §6's "handle missing information").
 │  Idempotent — a no-op if the row already has an embedding, which is the common case: the primary
 │  call site is confirmCareerGoal's own second, post-commit withUserContext call (§5b, D55); this
 │  call here is the lazy fallback for any row that reached a matching run still unembedded.
 ├─ fetchCandidateJobs(tx, goalEmbedding) → open jobs + cosine similarity to the goal embedding (if any)
 ├─ ensureJobEmbeddings(tx, env, jobIds) → Voyage in EMBEDDING_BATCH_SIZE-sized chunks (D56 -- a
 │  single unchunked call was found by the final whole-branch review to fail outright against a
 │  realistically populated jobs table); one chunk's failure only leaves ITS jobs unembedded (retried
 │  next run), never the whole batch; embedded/failed counts persisted on matching_runs, not just
 │  logged; re-fetch candidates afterward so a job embedded just now has semantic similarity in THIS run
 ├─ every EXISTING job_matches row whose job is no longer open (closed since it was matched):
 │  evaluateEligibility(..., jobOpen:false) → upsertMatchRow(eligible:false, "This {company} posting has
 │  closed." -- or the "already applied" reason, which wins) with userAction/explanation carried forward;
 │  a job closed before it was ever matched gets no row; not counted in jobsEvaluated (D139)
 ├─ per open job: evaluateEligibility (already-applied, company/industry exclusion, work mode, sponsorship,
 │  experience grace, previously-dismissed; jobOpen:true) → ineligible: upsertMatchRow(eligible:false, reason) and skip scoring;
 │  eligible: score 9 factors (skills, experience, location, sponsorship, role, salary, industry,
 │  freshness, semantic) → computeOverallScore → upsertMatchRow(eligible:true, factors, score)
 │  (scoreSkills falls back to lexical-only when semanticSimilarity is null, per the embedding degrade)
 ├─ sort scored jobs by overallScore desc; among ones whose explanation is stale/missing
 │  (isExplanationStale: no explanation, a different active goal, a changed job description hash, or
 │  past MATCHING_EXPLANATION_TTL_DAYS), explain the top MATCHING_EXPLAIN_TOP_N via
 │  generateMatchExplanation(anthropicClient, ...) → Anthropic `record_match_explanation` tool call
 │  (ANTHROPIC_BASE_URL redirects this, real or fake) → job_matches.explanation/explanationModel/
 │  explanationGeneratedAt; a schema-invalid response (MatchExplanationValidationError) OR an
 │  Anthropic.APIError (rate limit, 5xx, network, or a permanent misconfiguration -- D57) leaves the
 │  row's deterministic score intact and does not fail the run; any other (unexpected) error does
 └─ finish("completed"|"failed", errorClass) → matching_runs.finishedAt/status/counters
    (jobsEmbedded/jobsEmbeddingFailed also persisted here, per D56)
```

### 7c. Task 16's own addition: manual end-to-end smoke test (not request-driven; a standalone script)

```
services/matching-worker/e2e/fakeAnthropic.ts   plain node:http server on :4012, POST /v1/messages
                                                 only; keys its canned tool_use input off the
                                                 REQUESTED tool's name (record_match_explanation for
                                                 7b above, record_career_goal_extraction for
                                                 packages/ai/src/extractCareerGoal.ts — apps/web's
                                                 /api/career-goal/parse calls Anthropic directly, not
                                                 through the matching worker, so it needs the same
                                                 ANTHROPIC_BASE_URL redirect as the worker does)
services/matching-worker/e2e/smoke.ts           drives, over real HTTP: career-goal parse (§5a)
                                                 + confirm → job upload (§6a's /api/job-sources/upload,
                                                 multipart) → POST /api/matches/run → poll
                                                 /api/matches/runs/latest → GET /api/matches (eligible
                                                 + ineligible) → PATCH a dismissal → re-run → re-check
```

Verified for real (see task-16-report.md): all four processes (fake Anthropic, job-ingestion worker,
matching worker, web) running against a scratch database, with placeholder `VOYAGE_API_KEY` — the
Voyage calls in 7b fail and degrade to a null embedding as designed, and the run still completes with
real, schema-validated explanations from the fake Anthropic server.

---

## 8. Phase 6 — ATS Resume Optimization

User clicks "Optimize Resume" on an eligible job's match detail page
(`apps/web/src/app/matches/[jobId]/ResumeOptimizationPanel.tsx`)
  -> `POST /api/resume-optimizations/[jobId]/run`
     (`apps/web/src/app/api/resume-optimizations/[jobId]/run/route.ts`)
  -> `runResumeOptimization` (`packages/resume-optimization/src/pipeline/runResumeOptimization.ts`)
     1. Verify job_matches row exists and is eligible; verify an active confirmed career goal exists.
     2. `ensureJobRequirements` -- cache hit (job.descriptionHash unchanged) or a fresh
        `extractJobRequirements` Anthropic call, replacing `job_requirements` rows for the job.
     3. `buildResumeSnapshot` -- reads work_experience_bullets/achievements/projects/certifications/
        education/skills directly into the evidence catalog.
     4. `optimizeResume` -- Anthropic tool-use call proposing selected/reworded bullets.
     5. `applyDeterministicGuard` -- verifies every cited sourceFactId against the catalog from step 3;
        anything not found is dropped into rejectedClaims, never treated as applied.
     6. `evaluation/*` scorers (keyword coverage, semantic similarity via embedTexts + cosine,
        factual consistency from the guard's tally, action-verb/readability heuristics) ->
        `computeOverallScore`. `requiresReview` on the row this writes is
        `draft.requiresReview || unsupportedClaimsDetected.length > 0 || rejectedClaims.length > 0`
        -- the model's own self-report can only add caution here, never remove it.
     7. One transaction inserts `resume_optimizations` (versioned) and `ats_evaluations` (1:1,
        DB-enforced via `ats_evaluations_resume_optimization_id_uniq` plus a CHECK constraint per
        score column keeping every value in its documented 0-1/0-100 range).
  -> Route serializes via `lib/resumeOptimization/serializeOptimization.ts`'s `toOptimizationView`,
     returns 201.
  -> Panel re-fetches `GET /api/resume-optimizations/[jobId]`
     (`lib/resumeOptimization/listOptimizations.ts`) and renders the new version.

Modifying the optimizer's prompt/schema: `packages/resume-optimization/src/optimization/optimizeResume.ts`
+ `optimizeResumeSchema.ts` (unlike `extractJobRequirements`, there is currently no automated
test asserting `optimizeResume`'s tool JSON schema stays in lockstep with `OptimizeResumeSchema`
-- keep them manually in sync if you change one). Modifying the guard's rules:
`applyDeterministicGuard.ts` alone -- nothing upstream or downstream needs to change. Modifying the
scorecard's weights: `packages/resume-optimization/src/types.ts`'s `EVALUATION_WEIGHTS`, bump
`EVALUATOR_VERSION`.

---

## 9. Phase 7a — Company Research & Hiring Manager Pitch

User clicks "Generate Pitch" / "Regenerate" on an eligible job's match detail page
(`apps/web/src/app/matches/[jobId]/PitchPanel.tsx`)
  -> `POST /api/application-pitches/[jobId]/run` (`apps/web/src/app/api/application-pitches/[jobId]/run/route.ts`)
  -> `runPitchGeneration` (`packages/application-package/src/pipeline/runPitchGeneration.ts`)
     Since Phase 7c, steps 1-4 live in `prepareApplicationContext` (`pipeline/prepareApplicationContext.ts`,
     shared with the cover letter and interview prep, §11a); `runPitchGeneration` adds steps 5-7.
     1. job_matches row exists (else 404) and is eligible (else 400).
     2. `buildResumeSnapshot` (Phase 6) -- empty catalog -> `no_profile` -> 409, BEFORE any paid call.
     3. `ensureCompanyResearch` (`research/ensureCompanyResearch.ts`), keyed by `jobs.company_key`:
        - stored row with status ok/no_results -> reused as-is;
        - otherwise: posting URL (`job_postings.url`, http(s) only) + this company's open jobs are read, then
          `runCompanyResearch` (`research/runCompanyResearch.ts`) calls the research-tier model with the
          basic `web_search_20250305` tool (D79 -- the newer `web_search_20260209` tool's dynamic
          filtering produced uncited text and 0 facts; the basic tool gives ~15 cited facts per company
          in ~16-22s) -- inputs are company name, job title, posting URL ONLY -- following `pause_turn`
          up to 2 times; `extractCitedFacts` keeps only API-cited text blocks; `deriveInternalFacts` adds
          deterministic facts; one transaction upserts `company_research` and replaces
          `company_research_facts`. Failure is stored as status `failed`, never thrown. A response that
          stops on `stop_reason: "max_tokens"` with nothing cited is also stored as `failed`
          (`errorCode: "max_tokens"`), not `no_results`, so it gets retried on the next call instead of
          being cached forever. "A failed result
          never replaces good research" is enforced atomically at write time, not from the stale
          pre-call read: the upsert's `ON CONFLICT ... DO UPDATE` carries `setWhere: status = 'failed'`,
          so a failed write only overwrites a row whose stored status is *still* `failed` at the moment
          of the write; if that guard blocks the update, the code re-reads what is actually stored
          instead (D74, as amended).
     4. `ensureJobRequirements` (Phase 6) -> `buildEvidenceIndex` (`r:` research, `q:` requirement, `p:` profile ids).
     5. `generatePitch` -- fast-tier forced tool call `record_pitch` with `strict: true` (structure-only schema,
        API-validated before return; `stop_reason === "max_tokens"` -> `PitchGenerationValidationError` before
        any parsing; D109) -> Zod `PitchDraftSchema` (still the sole enforcer of lengths/counts).
     6. `applyPitchGuard` -- each bullet's citations go through the shared `checkCitations`
        (`guard/checkCitations.ts`): every cited id must exist, no repeats, each bullet must cite its own kind;
        failures kept with supported=false; evidence text snapshotted from the index.
     7. `hasUnsafeText` choke point, then `insertPitchVersion` under
        `pg_advisory_xact_lock(hashtext('application_pitches'), hashtext(userId || ':' || jobId))`.
  -> Route serializes via `lib/applicationPitch/serializePitch.ts` (URLs re-validated), returns 201.
  -> Panel re-fetches `GET /api/application-pitches/[jobId]` (`listPitches` + `loadResearchForJob`).

Edit: "Edit" -> "Save as new version" -> `POST …/edit` -> `EditPitchBodySchema` -> `createEditedPitch`
(`pipeline/createEditedPitch.ts`): base must belong to the job; new `user_edited` version via the same
`insertPitchVersion`, evidence copied, supported=null, requiresReview=false.

Refresh: "Refresh" -> `POST …/research/refresh` -> `ensureCompanyResearch(…, { forceRefresh: true })`;
a `failed` result over good research writes nothing and returns 502 (`CompanyResearchRefreshFailedError`).

Changing the pitch prompt/schema: `pitch/generatePitch.ts` + `pitch/pitchSchema.ts` (keep the tool JSON
schema's structure and the Zod schema's fields in lockstep by hand -- the tool schema states shape only
under `strict: true`, Zod states lengths/counts, D109; re-run `eval:pitch`). Changing grounding rules:
`pitch/applyPitchGuard.ts` (per-bullet kinds) or `guard/checkCitations.ts` (the id rules shared with §11 --
a change there affects all three documents). Changing what counts as a web fact: `research/extractCitedFacts.ts` only.

## 10. Phase 7b — Document Export & Storage

"Download PDF/DOCX" in `ResumeOptimizationPanel` / `PitchPanel` (`apps/web/src/app/matches/[jobId]/DownloadButtons.tsx`)
  -> `POST /api/documents` { kind, jobId, sourceId, format } (`apps/web/src/app/api/documents/route.ts`)
  -> `exportResume` / `exportPitch` (`packages/document-export/src/pipeline/`)
     1. job exists (404); the optimization/pitch belongs to the job (400 source_mismatch).
     2. resume: current `buildResumeSnapshot` hash must equal `resume_optimizations.source_profile_content_hash`
        (409 profile_changed); pitch: a `generated` version with any `supported === false` bullet → 409 pitch_unsupported.
     3. profile via `loadResumeProfile` (409 no_profile; street address never read).
     4. `buildResumeModel` / `buildPitchModel` → `DocumentModel` (pure; merge rules in D82). `buildResumeModel`
        treats blank/whitespace profile fields as absent (`present`/`joinPresent` in `resumeProfile.ts`), de-dups
        repeated applied-bullet entries (first occurrence wins), and keys known source ids by `sourceType:id` so
        an id from one collection can never match another.
     5. `storeDocument`: `normalizeModel` (strips/replaces XML-illegal control characters such as `\u000B`/
        `\u000C`, D86) → `assertSafeModel` → `modelContentHash` → reuse an existing row keyed by
        `(user_id, job_id, kind, format, content_hash)` (job_id is part of the key so job B never reuses job A's
        file — migration `0021`, D84 update), else `renderDocument` (pdfkit / docx) →
        `uploadGeneratedDocument` (MinIO `generated-documents`, outside any transaction) → INSERT … ON CONFLICT
        DO NOTHING (loser deletes its upload, returns the winner). If the insert throws for any other reason,
        `storeDocument` also deletes the just-uploaded object before rethrowing, so a failed insert never leaves
        an orphaned object with resume PII in MinIO.
  -> 201 `{ document }`; `DownloadButtons` dispatches `documents:changed` (DocumentsList reloads), then preflights
     with `HEAD /api/documents/[id]/download` (own try/catch around the fetch, separate from the export's own
     error handling) — the route looks the row up under RLS (404 if missing/another user's) then calls
     `statGeneratedDocument` (`packages/storage`) for a cheap existence check (502 with a fixed message if the
     object is unreachable), 200 with an empty body otherwise — and only on a 2xx preflight does it call
     `navigate` to `GET /api/documents/[id]/download`, which repeats the RLS lookup and streams the object with
     attachment headers. A failed preflight (404/502 response, or the HEAD fetch itself throwing) shows an
     inline error instead of navigating the whole app to a raw JSON response.
     `DocumentsList`'s own "Download" control is a button (not a link) that runs the same HEAD-preflight-then-
     navigate logic against a document's `downloadUrl`, showing its own inline alert on failure.

`exportResume` reads `buildResumeSnapshot` and `loadResumeProfile` inside one `withUserContext(..., { isolationLevel:
"repeatable read" })` transaction (the new optional `isolationLevel` on `withUserContext`, `packages/db/src/rls.ts`),
so a profile edit committing between the two reads cannot pair an old hash with a render of new rows.

Changing layout: `packages/document-export/src/render/*` — bump `RENDERER_VERSION`. Changing what a resume contains:
`model/buildResumeModel.ts` only. Changing fonts: `pnpm --filter @ai-career/document-export embed-fonts`.

## 11. Phase 7c — Cover Letter & Interview Preparation

Both panels sit below `PitchPanel` on an eligible job's match page (`MatchDetailClient.tsx` renders
`CoverLetterPanel` and `InterviewPrepPanel` only when `match.eligible`). Both generations share their first
half with the pitch (§9) through `prepareApplicationContext`.

### 11a. Shared context (`packages/application-package/src/pipeline/prepareApplicationContext.ts`)

`prepareApplicationContext(db, { userId, jobId, anthropicClient, env })`, used by `runPitchGeneration`,
`runCoverLetterGeneration` and `runInterviewPrepGeneration`:
  1. `job_matches` row for the job (else `ApplicationGenerationError("no_match")` → 404) and eligible
     (else `not_eligible` → 400); the `jobs` row (else `no_match`).
  2. `buildResumeSnapshot` (Phase 6) -- empty catalog → `no_profile` → 409, BEFORE any paid call.
  3. `ensureCompanyResearch` (§9 step 3; research is per company and shared by all three documents, so a
     pitch generated first means no second web search).
  4. `ensureJobRequirements` (Phase 6; `Anthropic.APIError` / `JobRequirementExtractionValidationError` →
     `unknown` → 502) → `buildEvidenceIndex` (`r:` / `q:` / `p:` ids).
  Returns `{ job, snapshot, research, requirements, evidence }`. `ApplicationGenerationError`
  (`pipeline/generationError.ts`) is the one expected-failure class; `PitchGenerationError` is an alias (D89).

The per-item citation check every guard calls is `checkCitations(lookup, evidenceIds, requirement)`
(`guard/checkCitations.ts`): unknown id → reason; repeated id → reason; each requirement group (e.g.
`[["requirement"], ["profile"]]` = a `q:` AND a `p:`; `[["research", "requirement"]]` = an `r:` OR a `q:`)
unmet → reason. Evidence snapshots are re-read from the index. `toGuarded` turns the reasons into
`supported` / `unsupportedReason`.

### 11b. Cover letter generation (request-driven)

"Generate Cover Letter" / "Regenerate" (`apps/web/src/app/matches/[jobId]/CoverLetterPanel.tsx`)
  -> `POST /api/cover-letters/[jobId]/run` (`apps/web/src/app/api/cover-letters/[jobId]/run/route.ts`;
     non-UUID jobId → 404)
  -> `runCoverLetterGeneration` (`packages/application-package/src/pipeline/runCoverLetterGeneration.ts`)
     1. `prepareApplicationContext` (11a), then `computeGapTerms(requirements, snapshot.catalog)` (every missing
        required skill/tool/certification term of at most four words, uncapped -- see 11c step 2).
     2. `generateCoverLetter` (`coverLetter/generateCoverLetter.ts`) -- `ANTHROPIC_MODEL_FAST`, forced tool
        `record_cover_letter` with `strict: true` (the tool schema states structure only -- every object node
        `additionalProperties: false` + full `required`, no length/count keywords -- and the API itself
        validates `tool_use.input` against it before returning; D109), job context and evidence in their own
        random delimiters (D20); `stop_reason === "max_tokens"` → `CoverLetterGenerationValidationError`
        before any parsing (D109) → Zod `CoverLetterDraftSchema` (4-5 paragraphs, order opening / company /
        evidence ×1-2 / closing, ≤1200 chars, the sole enforcer of lengths/counts). The gap terms are NOT sent
        to the model.
     3. `applyCoverLetterGuard` (`coverLetter/applyCoverLetterGuard.ts`) -- `COVER_LETTER_CITATION_RULES`:
        opening ≥1 `q:`, company ≥1 `r:`, evidence ≥1 `p:`, closing none; requiresReview = any unsupported OR
        the model's flag. Then `findGapTermMentions(paragraphs, gapTerms)` (`coverLetter/findGapTermMentions.ts`,
        pure) returns, per paragraph, every gap term its text `containsTerm`s (the opening always `[]`); each
        paragraph stores its list as `missingTermMentions` (D106), and any non-empty list → requiresReview = true,
        the paragraph stays supported (D101). `Anthropic.APIError` / `CoverLetterGenerationValidationError` →
        `unknown` → 502.
     4. `hasUnsafeText(paragraphs)` (text, evidence and `missingTermMentions`) → `unknown` (D44).
     5. `insertCoverLetterVersion` (`pipeline/insertCoverLetterVersion.ts`) under
        `pg_advisory_xact_lock(hashtext('cover_letters'), hashtext(userId || ':' || jobId))`, origin `generated`,
        `generationModel` = the fast-tier model.
  -> Route serializes via `apps/web/src/lib/coverLetter/serializeCoverLetter.ts` (`toEvidenceView` re-validates
     source URLs as http(s)) + `toResearchView`, returns 201 `{ coverLetter, research }`.
  -> Panel re-fetches `GET /api/cover-letters/[jobId]` (`listCoverLetters` newest first + `loadResearchForJob`,
     one `withUserContext`).

Edit: "Edit" → one textarea per paragraph → "Save" → `POST /api/cover-letters/[jobId]/edit`
  -> `EditCoverLetterBodySchema` (strict `{ baseVersionId, paragraphs: string[4..5] }`, each trimmed, 1-1200 chars,
     `hasUnsafeText`-clean; invalid → 400)
  -> `createEditedCoverLetter` (`pipeline/createEditedCoverLetter.ts`): base must belong to this job
     (`base_not_found` → 400) and have the same paragraph count (`paragraph_count_mismatch` → 400); new
     `user_edited` version via the same `insertCoverLetterVersion`, roles/evidence/research snapshot copied,
     supported=null ("your wording" in the panel), `missingTermMentions` = null, requiresReview=false. 201 `{ coverLetter }`.

Review banner (`CoverLetterPanel`, `reviewReasons`): when `requiresReview`, one line per cause, keyed by the
paragraph's index in the full list -- "<label>: <unsupportedReason>" for an unsupported paragraph, "<label>: mentions
A and B, which your profile doesn't show" for a non-empty `missingTermMentions` -- and "The model flagged this cover
letter for review." only when neither applies (including rows written before D106, whose paragraphs have no
`missingTermMentions`; `toCoverLetterView` reads it as null). Labels come from `paragraphLabel` (two evidence
paragraphs are "Evidence of fit 1" / "2", as in edit mode).

### 11c. Interview prep generation (request-driven)

"Generate Interview Prep" / "Regenerate" (`apps/web/src/app/matches/[jobId]/InterviewPrepPanel.tsx`; the
loading text says it can take up to a minute)
  -> `POST /api/interview-preps/[jobId]/run` (`apps/web/src/app/api/interview-preps/[jobId]/run/route.ts`)
  -> `runInterviewPrepGeneration` (`packages/application-package/src/pipeline/runInterviewPrepGeneration.ts`)
     1. `prepareApplicationContext` (11a).
     2. `computeGapTerms(requirements, snapshot.catalog)` (`interviewPrep/computeGapTerms.ts`, pure): candidates
        are `isGapCandidate` requirements -- `required`, `termType` skill/tool/certification, at most four words
        (D104; "other" and phrase-shaped requirements are never gaps) -- not found by `containsTerm` (boundary-aware, D95) in the catalog text formatted as
        `"context: text"`; sorted by term then id, de-duplicated case-insensitively, NOT capped (D100) →
        `allGapTerms`; `modelGapTerms = allGapTerms.slice(0, MAX_GAP_TERMS)` (5).
     3. `generateInterviewPrep` (`interviewPrep/generateInterviewPrep.ts`) -- `ANTHROPIC_MODEL_RESEARCH`, forced
        tool `record_interview_prep` with `strict: true` (structure-only schema, same shape as the cover
        letter's; removed character/array caps that had no other statement in the prompt -- per-field char
        limits, `gapQuestions`' item cap -- are restated in each property's `description`; D109), job /
        evidence / `modelGapTerms` (`{ term, requirementId: "q:…" }`) each in their own delimiter;
        `stop_reason === "max_tokens"` → `InterviewPrepGenerationValidationError` before any parsing (D109) →
        Zod `InterviewPrepDraftSchema` (still the sole enforcer of lengths/counts): `likelyQuestions`,
        `talkingPoints` and `questionsToAsk` floor at 1 item (`gapQuestions` 0..`2 * MAX_GAP_TERMS`, unchanged
        by D110); an over-long array (likely >8, talking points >6, questions-to-ask >5, gap questions
        >`2 * MAX_GAP_TERMS` (10, not `MAX_GAP_TERMS` -- membership of at most one question per valid term
        is the guard's job in step 4, not this schema's, so the wider trim room keeps an early
        duplicate/off-list gap question from pushing a later valid one out of the array), an answer-outline
        >5 lines) is not rejected -- a `.transform` (the `capped` helper) keeps the first N items, in order,
        after the array's own `.min()` check runs (D110).
     4. `applyInterviewPrepGuard(evidence, { modelGapTerms, allGapTerms }, draft)` (`interviewPrep/applyInterviewPrepGuard.ts`):
        - gapQuestions: ≥1 `q:`; term must be one of `modelGapTerms` (canonical spelling stored); one per term,
          reserved only once a question cites that term's own `q:` id; must cite that `q:`; must not cite a
          `p:` containing the term (D92); framing must not claim the skill -- `findSkillClaim(framing, term)`
          (`interviewPrep/findSkillClaim.ts`, sentence-level first/second/third-person claim pattern, skipped
          when a negation or a conditional marker -- if/whether/unless/in case -- precedes it in its clause,
          term after the pattern) → "framing may claim the missing skill "X"" (D102, D105).
        - likelyQuestions: `LIKELY_QUESTION_CITATION_RULES` (technical/behavioral `q:` AND `p:`; role `p:` AND
          `r:`-or-`q:`, D97); flagged if it cites the `q:` of, or its text contains, ANY term in `allGapTerms`
          (D96, D100).
        - talkingPoints ≥1 `r:`; questionsToAsk ≥1 `r:` or `q:`.
        `Anthropic.APIError` / `InterviewPrepGenerationValidationError` → `unknown` → 502.
     5. `hasUnsafeText(sections)` (every string, answer-outline arrays included) and `hasUnsafeText(gap terms)` → `unknown`.
     6. `insertInterviewPrepVersion` under the advisory lock keyed on `'interview_preparations'`,
        `gapTermsSnapshot` = every term in `allGapTerms` (so the panel/export list is complete).
  -> `apps/web/src/lib/interviewPrep/serializeInterviewPrep.ts` → 201 `{ interviewPrep, research }`; panel
     re-fetches `GET /api/interview-preps/[jobId]` (`listInterviewPreps` + `loadResearchForJob`).

### 11d. Export of the two new kinds

`DownloadButtons` (kind `cover_letter` / `interview_prep`) → `POST /api/documents` (`runExport` switch in
`apps/web/src/app/api/documents/route.ts`)
  -> `exportCoverLetter` (`packages/document-export/src/pipeline/exportCoverLetter.ts`): job (404), letter belongs
     to the job (400 source_mismatch), a `generated` letter with any `supported === false` paragraph → 409
     `cover_letter_unsupported` (user_edited always exports), contact fields (409 no_profile) →
     `buildCoverLetterModel` (name, contact line, "Dear Hiring Manager,", paragraphs, "Sincerely,", name).
  -> `exportInterviewPrep` (`pipeline/exportInterviewPrep.ts`): job, pack belongs to the job, full name for the
     filename → `buildInterviewPrepModel` (four headed sections; unsupported items suffixed " (unverified)";
     a gap question's "Missing: X" subtitle only when supported; never refused).

Panel copy/display (`InterviewPrepPanel.tsx`): `formatInterviewPrepText` (Copy) marks unsupported items
" (unverified)" the same way; each gap question shows "Missing: X" (supported) or "Term: X" (unsupported); the
gap-term chips are a list labelled "Missing required terms" (D103). `CoverLetterPanel` edit mode labels two
evidence textareas "Evidence of fit 1" / "Evidence of fit 2".
  -> `storeDocument` (§10 step 5) with `coverLetterId` / `interviewPreparationId`; the DB CHECK
     `generated_documents_source_matches_kind` (compares `kind::text`, D93) allows only the matching source column.
  -> The route's `sourceVersion` reads the version of whichever source id the returned row carries;
     `listDocuments` left-joins `cover_letters` / `interview_preparations`, and `DocumentsList` labels rows
     "Cover letter vN" / "Interview prep vN".

### Changing 7c behavior

Cover letter prompt/schema: `coverLetter/generateCoverLetter.ts` + `coverLetter/coverLetterSchema.ts` (keep the
tool JSON schema and the Zod schema in lockstep; re-run `eval:cover-letter`). Interview prep prompt/schema:
`interviewPrep/generateInterviewPrep.ts` + `interviewPrep/interviewPrepSchema.ts` (re-run `eval:interview-prep`).
Per-item grounding rules: `coverLetter/applyCoverLetterGuard.ts` / `interviewPrep/applyInterviewPrepGuard.ts`;
id rules shared with the pitch: `guard/checkCitations.ts`. Gap detection (what counts as "missing", the
matcher): `interviewPrep/computeGapTerms.ts` only -- `containsTerm` is also used by the guard,
`findSkillClaim` and `findGapTermMentions`. The model's gap-term cap (`MAX_GAP_TERMS`) is applied in
`runInterviewPrepGeneration` (and mirrored in the eval). The framing claim check: `interviewPrep/findSkillClaim.ts`
only -- the guard and `eval:interview-prep` share it. The cover letter's gap-mention review rule:
`coverLetter/findGapTermMentions.ts`, applied (and stored per paragraph) in `runCoverLetterGeneration`; its banner
text: `CoverLetterPanel.tsx` `reviewReasons`. Which requirements can be gaps at all: `isGapCandidate` in
`interviewPrep/computeGapTerms.ts`. Client view types shared by the three panels: `ResearchStatus` / `ResearchView`
in `apps/web/src/app/matches/[jobId]/viewTypes.ts`, `EvidenceView` in `EvidenceList.tsx`.

Close-out changes (D104-D108) touched: 11b steps 1 and 3, the edit path and the review banner; 11c steps 2
and 4 (gap candidates, claim heuristic); the prompt's untrusted-data sentence and the tool/Zod `minLength`
constraints in all three `generate*` calls (pitch §9 included; the tool-side `minLength` was later removed
by D109's strict tool use, which forbids it -- Zod alone enforces it now). Export layout of the two kinds: `document-export/src/model/build{CoverLetter,InterviewPrep}Model.ts`.

D110 touched only 11c step 3: `interviewPrep/interviewPrepSchema.ts` (the `capped` transform, new floors) and
`interviewPrep/generateInterviewPrep.ts` (the "return fewer rather than inventing" prompt sentence). Steps
1, 2, 4, 5 and 6, `applyInterviewPrepGuard.ts`, `buildInterviewPrepModel.ts` and `InterviewPrepPanel.tsx` are
unchanged -- they already handled a section of any length ≥0.

## 12. Phase 9 — Application Tracker

New domain package `packages/applications` (all new); new service `services/maintenance-worker` (all new);
new routes under `apps/web/src/app/api/applications` and `apps/web/src/app/api/applications/for-job/[jobId]`
(all new); new UI at `apps/web/src/app/applications` and `apps/web/src/app/applications/[id]` (all new);
`apps/web/src/app/matches/[jobId]/ApplicationPanel.tsx` (new) added to the match page alongside the existing
Phase 6/7 panels.

### 12a. Mark as applied (request-driven)

Loading any match page, eligible or not, renders `ApplicationPanel` (`apps/web/src/app/matches/[jobId]/ApplicationPanel.tsx`, new;
`MatchDetailClient.tsx` renders it unconditionally, so "Mark as applied" is on every match page)
  -> `GET /api/applications/for-job/[jobId]` (`apps/web/src/app/api/applications/for-job/[jobId]/route.ts`, new;
     non-UUID `jobId` -> 404)
  -> `getApplicationForJob` + `listDocumentOptions` (`packages/applications/src/readApplications.ts`, new) --
     one existing-application lookup by `jobId`, plus each linked-document table's versions (resume
     optimizations, pitches, cover letters) ordered by `version` descending on the server, so the panel can
     preselect the first (newest) of each.
  -> Panel shows "Applied on {date} · {status}" with a link to `/applications/[id]` if an application already
     exists, otherwise a form (resume/pitch/cover-letter version dropdowns, applied date, optional follow-up
     date). The version dropdowns' "latest" default is the first option in the server's ordering, not
     anything computed from the browser clock. The applied-date default is today's UTC day
     (`todayUtc()` = `toISOString().slice(0, 10)`), matching the server's "not after today" bound.
  -> The panel keeps the options current (D123): it re-runs the same `GET for-job` on window `focus` and on
     `DOCUMENTS_CHANGED_EVENT` (`"documents:changed"`, exported by `DownloadButtons.tsx`). That event is
     dispatched by `DownloadButtons` after an export and, since D123, by `ResumeOptimizationPanel` after a
     successful generate and by `PitchPanel`/`CoverLetterPanel` after a successful generate or edit (not a
     research refresh). `DocumentsList` also listens and re-loads `/api/documents`. A dropdown the user never
     touched always shows the newest option; an explicit pick (a version or "None") is kept while that id
     still exists in the fresh options, else it falls back to the newest.

Submitting the form -> re-fetches `GET for-job` first (D123; if an application now exists, it shows that
and stops), resolves each dropdown against the fresh options as above, then
`POST /api/applications` (`apps/web/src/app/api/applications/route.ts`, new)
  -> `CreateApplicationBodySchema` (`packages/applications/src/bodies.ts`, new) -- exactly one of `jobId` or
     `external{companyName,jobTitle,jobUrl?}`; an external application cannot carry document links;
     `appliedAt` may not be after today (UTC, with a 5-minute clock-skew allowance, D123); invalid body -> 400
  -> `createApplication` (`packages/applications/src/createApplication.ts`, new), one transaction
     (`withUserContext`):
     1. Ingested path: load the `jobs` row (missing -> `job_not_found` -> 404); `loadLinkedDocuments`
        (`packages/applications/src/documentLinks.ts`, new) re-validates every linked document actually
        belongs to this `jobId` (mismatch -> `document_mismatch` -> 422); load the job's `job_matches` row and
        its most-recently-seen `job_postings.url` (kept only if http(s) -- `safeHttpUrl`, D113; ingestion
        itself nulls a non-http(s) `url` at normalization since D124, so this is now defense in depth).
     2. `buildFeatureSnapshot` (`packages/applications/src/snapshot.ts`, new) assembles the D116 snapshot from
        whatever job/match/ATS/document state exists right now.
     3. Insert the `applications` row (status `applied`) and its initial `status_change` event
        (`from=null, to=applied`) in the same transaction. A unique-constraint hit on `(user_id, job_id)`
        (partial index, job_id not null) is caught and re-thrown as `already_applied` -> 409
        (`applicationErrorResponse`, `apps/web/src/lib/applications/errorResponse.ts`, new).
  -> Route returns 201 `{ application }` (`toApplicationView`, `apps/web/src/lib/applications/serializeApplication.ts`,
     new); panel updates its own state directly from the response (no re-fetch after the POST).
  -> On a 409 (another request -- e.g. another tab -- won the race since the panel's own pre-submit
     re-fetch), the panel re-runs `GET for-job` once more (D124's web fix, the same `fetchForJob`/`load`
     used elsewhere in this flow): if that reload finds the application, the panel switches straight to the
     "Applied on ..." view instead of just showing the error; if the reload itself fails or still finds no
     application, the server's error text is shown as before.

### 12b. Status changes, events and edits (request-driven)

`/applications/[id]` (`apps/web/src/app/applications/[id]/page.tsx`, new) renders `ApplicationDetailClient`
(`apps/web/src/app/applications/[id]/ApplicationDetailClient.tsx`, new), which loads
`GET /api/applications/[id]` (`getApplication`, `packages/applications/src/readApplications.ts`) once and then
drives three separate actions from the same page:

- Status select -> `POST /api/applications/[id]/status` (`apps/web/src/app/api/applications/[id]/status/route.ts`,
  new) -> `ChangeStatusBodySchema` (`{toStatus, occurredAt?, note?}`) -> `changeStatus`
  (`packages/applications/src/mutateApplication.ts`, new): locks the row (`FOR UPDATE`), calls `planStatusChange`
  (`packages/applications/src/status.ts`, new -- D115: terminal_at set to `now`, not `occurredAt`; kept on
  terminal→terminal; cleared on reopen; same-status -> `same_status` -> 409), updates the row, inserts the
  `status_change` event and, if a note was given, a second `note` event, all in one transaction. Choosing a
  terminal status first shows a client-side confirmation naming `RETENTION_DAYS`.
- "Log event" form (`LogEventForm.tsx`, new) -> `POST /api/applications/[id]/events`
  (`apps/web/src/app/api/applications/[id]/events/route.ts`, new) -> `UserEventBodySchema` (discriminated union
  on `type`; `status_change`/`documents_purged` are not in the union, so they cannot be posted here) ->
  `addEvent` (`mutateApplication.ts`): `follow_up_done` clears `follow_up_at`, `follow_up_snoozed` sets it to
  `detail.newFollowUpAt` (which must be strictly after today, UTC, D123), both in the same transaction as the
  event insert.
- Edit form (`EditApplicationForm.tsx`, new) -> `PATCH /api/applications/[id]`
  (`apps/web/src/app/api/applications/[id]/route.ts`, new) -> `UpdateApplicationBodySchema` -> `updateApplication`
  (`mutateApplication.ts`): edits free-text fields, `appliedAt`, `followUpAt` and document links (a changed
  link is re-validated against the current `jobId` via `loadLinkedDocuments`; an external application, `jobId`
  null, rejects any link change with `document_mismatch` -> 422). `feature_snapshot` is never touched (D116).
- `DELETE /api/applications/[id]` -> `deleteApplication` (`mutateApplication.ts`): events cascade; the job
  returns to the eligible match feed on the next matching run (12c).

### 12c. Matching: "already applied" eligibility (request-driven, inside an existing pipeline)

`runMatching` (`packages/matching/src/pipeline/runMatching.ts`) now also loads every `applications.job_id`
for the user in one query up front, and passes `alreadyApplied: appliedJobIds.has(job.id)` into
`evaluateEligibility` (`packages/matching/src/eligibility/evaluateEligibility.ts`) for each job -- checked
first, before "posting closed" (D139) and "previously dismissed" (D118). An applied job's `job_matches` row is overwritten with
`eligible=false` and the reason `"You applied to this job at {company}."` on the next run. `GET
/api/matches/[jobId]` (`apps/web/src/app/api/matches/[jobId]/route.ts`) additionally looks up the
application for that job and returns `applicationId` (or null); `MatchDetailClient.tsx` uses
`match.eligible || applicationId !== null` to decide whether to keep rendering the resume/pitch/cover-letter/
interview-prep/documents panels, so the record of what was actually sent stays visible after the job leaves
the ranked feed. Deleting the application (12b) makes the job eligible again on the next run.

### 12d. Retention sweep (scheduled, and `pnpm retention:run`)

`services/maintenance-worker/src/main.ts` (new) on boot: creates the BullMQ worker
(`createMaintenanceWorker`, `services/maintenance-worker/src/worker.ts`, new; queue name `"maintenance"`,
concurrency 1) and calls `scheduleRetention` (`worker.ts`), which upserts a repeatable job scheduler
(`retention-daily`, every 24h -- idempotent, safe to call on every boot).
  -> Each tick, the worker's processor calls `runRetentionSweep`
     (`packages/applications/src/retention/runRetentionSweep.ts`, new) with a `RetentionStorage` adapter
     (`createRetentionStorage`, `services/maintenance-worker/src/storageAdapter.ts`, new, wrapping
     `@ai-career/storage`'s `listGeneratedDocuments`/`deleteGeneratedDocument`).
  -> `runRetentionSweep`:
     1. Loads every application with a non-null `job_id` and `terminal_at`, filters with `planRetention`
        (`packages/applications/src/retention/planRetention.ts`, new -- pure; D119's due condition).
     2. For each due application, `purgeOne` (same file) runs in its own transaction: re-locks the row
        (`FOR UPDATE SKIP LOCKED`, D119), re-checks `isDueForPurge`, deletes the job's generated rows across
        five tables, sets `retention_purged_at`, inserts a `documents_purged` event with counts only.
     3. After each transaction commits, `storage.removeObject` deletes that application's collected MinIO
        keys one by one.
     4. An orphan sweep lists `generated-documents/{userId}/`, diffs against every `generated_documents`
        row's `object_key`, and deletes unreferenced keys older than 24h (`planOrphanSweep`).
     5. `failedObjectDeletes` is the size of a per-run `Set` of keys whose removal failed and did not later
        succeed, so a key failing in both steps 3 and 4 counts once (D123).
  -> Logs counts only (`main.ts`'s `log` helper), never document/note content.

`pnpm retention:run` (root `package.json` -> `services/maintenance-worker/package.json`'s own
`retention:run` script) -> `services/maintenance-worker/src/runOnce.ts` (new): calls `runRetentionSweep`
once, directly, with the same `RetentionStorage` adapter and env-derived `RETENTION_DAYS` -- the same code
path as the scheduled job, for manual/E2E use.

## 13. Phase 8 — Browser Automation (Guarded Autofill)

New pure package `packages/browser` (all new; no Playwright/BullMQ/ioredis import -- it only exports the
queue name/payload type as constants); new host-run service `services/browser-worker` (all new,
`playwright-core` + BullMQ); new routes under `apps/web/src/app/api/automation-sessions` (all new);
`packages/applications` gains `sessionLink.ts` (new) and `createApplication.ts` grows an optional
`automationSessionId` path; new UI `apps/web/src/app/matches/[jobId]/AutofillPanel.tsx`, rendered
alongside the existing Phase 6/7/9 panels on the match detail page.

### 13a. Start (request-driven)

`AutofillPanel.start` (`apps/web/src/app/matches/[jobId]/AutofillPanel.tsx`) -- the "Open & autofill
application" button, disabled while an active session exists or no resume PDF has been exported for this
job --
  -> `POST /api/automation-sessions` (`apps/web/src/app/api/automation-sessions/route.ts`, new) ->
     `CreateBodySchema` (`{jobId}`; invalid -> 400) -> `createSession` (`packages/browser/src/sessions/createSession.ts`,
     new), one transaction (`withUserContext`):
     1. Loads the `jobs` row (missing -> `job_not_found` -> 404) and confirms a `candidate_profiles` row
        exists (missing -> `profile_missing` -> 409).
     2. `getAutofillSupport` (`packages/browser/src/sessions/support.ts`) joins the job's `job_postings` +
        `job_sources` and calls `resolveAutofillTarget` (`packages/browser/src/adapters/resolveAutofillTarget.ts`,
        D128) -- picks the newest open Greenhouse/Lever posting, validates its slug/external id against
        `SAFE_IDENTIFIER`, and calls the matching adapter's (`greenhouse.ts`/`lever.ts`) `buildFormUrl`.
        Unsupported -> `unsupported` -> 422 (`reason` from `resolveAutofillTarget`).
     3. Inserts the `automation_sessions` row at `status = 'queued'` with the resolved `portal`,
        `adapterVersion`, `formUrl`. A concurrent second insert hitting
        `automation_sessions_one_active_per_user` (migration `0027`, D132) is caught and re-thrown as
        `session_active` -> 409.
  -> `enqueueAutofill` (`apps/web/src/lib/browser-automation/enqueue.ts`, new, mirrors
     `lib/matching/enqueue.ts`'s fail-fast producer settings) puts `{sessionId, userId}` on the
     `browser-automation` BullMQ queue (`packages/browser/src/queue.ts`'s `BROWSER_QUEUE_NAME`/
     `BROWSER_JOB_NAME`/`BROWSER_JOB_OPTIONS`, job id `autofill-{sessionId}`, `attempts: 1`). On failure
     (Redis down) -> `failSession(db, userId, sessionId, "enqueue_failed")` moves the row straight to
     `failed`, and the route returns 503.
  -> Route returns 201 `{session}` (`toSessionView`, `apps/web/src/lib/browser-automation/serializeSession.ts`,
     new); `AutofillPanel` re-fetches the overview (13c) rather than using the response directly.

### 13b. Worker run (queue-driven)

`services/browser-worker/src/main.ts` (new) on boot: `removeStaleSessionDirs()` (`browser.ts`) deletes any
leftover `careerpilot-autofill-*` temp directories from a previous crashed process (D132), then
`sweepInterruptedSessions` (`packages/browser/src/sessions/transitions.ts`, D133) fails every session still
in `launching`/`filling`/`awaiting_user` to `failed`/`worker_restart` (`queued` sessions are left for the
worker), then `createBrowserWorker` (`worker.ts`) starts a BullMQ `Worker` at `concurrency: 1` on
`browser-automation`.

Each job -> `runSession` (`services/browser-worker/src/runSession.ts`, design §5):
  1. `transitionSession(..., ["queued"], "launching", {startedAt})` claims the row (a no-op "skipped" if
     cancelled or already claimed) -> `getAdapter(claimed.portal)` (`packages/browser/src/adapters/index.ts`).
  2. `hostAllowed(claimed.formUrl, adapter, extra)` checks the form URL's host against `adapter.allowedHosts`
     (D128; fails -> `needs_manual`/`form_url_not_allowed`).
  3. `loadAutofillContext` (`packages/browser/src/sessions/loadAutofillContext.ts`) reads the session,
     profile, active goal's constraints and the newest resume/cover-letter PDF `generated_documents` rows
     for the job, all under `withUserContext`.
  4. `downloadAttachments` (`services/browser-worker/src/attachments.ts`) fetches each PDF from MinIO
     (`minioFetcher` -> `@ai-career/storage`'s `getGeneratedDocument`) into a fresh `mkdtemp` session
     `rootDir/files/{resume,cover_letter}.pdf`; a failed download is recorded, not thrown (`failed` list).
  5. `launchBrowser` (`services/browser-worker/src/browser.ts`, D132) launches
     `chromium.launchPersistentContext(rootDir/profile, ...)`; failure -> `failed`/`browser_launch_failed`,
     `rootDir` removed. On success `deps.released.setActive(handle)` marks the window as the one in-progress
     window shutdown must also close (D132).
  6. `isCancelRequested` -> a cancel that landed between claiming the row and getting a window open still
     wins here, before the row ever reaches `filling` -> `abandoned`/`cancelled` (window closed, not
     released: the user never saw it).
  7. `transitionSession(..., ["launching"], "filling")` -> `page.goto(formUrl)` -> `hostAllowed(page.url())`
     again (redirect check #1: the navigation itself landed off-host) -> `page.waitForSelector(adapter.snapshotConfig.formSelector)`
     -> `hostAllowed(page.url())` a third time (redirect check #2, D138: a client-side redirect that fires
     after the form has loaded but before anything is read from the page) -- either failure ->
     `needs_manual`/`off_host_redirect` through `releaseUnlessCancelled` (13b step 14), nothing filled.
  8. `takeSnapshot(page, adapter)` (`services/browser-worker/src/snapshot.ts`) evaluates
     `EXTRACT_SNAPSHOT_SOURCE` (`packages/browser/src/snapshot/extractSnapshotSource.ts`, D131) as a string
     expression in the page, then pipes the page's return value through `sanitizeSnapshot`
     (`packages/browser/src/snapshot/sanitizeSnapshot.ts`, D138) -- the page's own JS is untrusted content, so
     every field is hand-checked (string types, the worker's own `[fg]\d+` key pattern, a known control, a
     500-field/200-option cap, labels re-truncated to 200 chars) before anything downstream touches it; a
     shape that doesn't check out returns `null`, which `runSession` treats the same as a failed health
     check -- `needs_manual`/`health_check_failed`, empty audit.
  9. `buildAutofillValues` (`packages/browser/src/values/buildAutofillValues.ts`, design §4.3) turns
     profile + goal + attachment-availability into `AutofillValues`, each carrying a `source` label.
  10. `buildFillPlan(snapshot, adapter, values)` (`packages/browser/src/plan/buildFillPlan.ts`, design §4.4) ->
      `classifyField` per field (`packages/browser/src/plan/classifyField.ts`, D129, D138) -> health check
      (every `adapter.requiredCanonicals` matched by exactly one field, else
      `needs_manual`/`health_check_failed`, nothing filled) -> one `FillAction` + one `FieldAuditEntry` per
      field. `classifyField`'s shared sponsorship rule now also checks the label for a polarity marker
      (`without`/`not`/`no longer`/`unable`/`n't` or `n’t`, D138) and, if found, flags the field `ambiguous_wording`
      instead of classifying it for a plain Yes/No fill -- `buildFillPlan`'s existing always-flag rule for
      `sponsorship` (D129) then flags it regardless of `required`. The shared `linkedin` label rule also now
      excludes a "how did you hear about us" / referral-source question (D138).
  11. Per action: a fourth `hostAllowed(page.url())` check, immediately before `performAction` (D138: the
      redirect could land strictly mid-loop, between two actions) -- failure -> `needs_manual`/
      `off_host_redirect` through `releaseUnlessCancelled`, with the audit discarded (`fieldAudit: []`) since
      a page that has already navigated away is not the one any of this audit's `filled` entries describes.
      Otherwise: `performAction` then `verifyAction` (`services/browser-worker/src/actions.ts`, D130, D138) --
      `assertTarget` guards every mutation against anything but the expected control kind (now itself under
      the same 5 s `ACTION_TIMEOUT_MS` as the mutation/read-back that follows it, D138, so a target that goes
      missing mid-navigation fails this check fast instead of hanging on Playwright's 30 s default); a verify
      mismatch flips the audit entry to `flagged`/`verify_mismatch`; a thrown `GuardViolation`/other error
      flips it to `flagged`/`guard_blocked`/`fill_error` and the loop continues with the next action. Cancel
      is checked before each action, ahead of the host check.
  12. `transitionSession(..., ["filling"], "awaiting_user", {fieldAudit, resumeDocumentId, coverLetterDocumentId})`.
  13. Polling loop (1 s, `pollMs`): `handle.isClosed()` -> `abandoned`/`window_closed`; elapsed >= timeout ->
      `abandoned`/`timeout`; every other tick, `isCancelRequested` -> `abandoned`/`cancelled`; for each open
      page, `readPageText` (`snapshot.ts`) + `detectSubmission(adapter, {url, text, formUrl})`
      (`packages/browser/src/detect/detectSubmission.ts`, D134) -> `submission_detected`. (No host re-check
      here: `detectSubmission` already restricts to the form's own host, D134, and a page the user is
      actively looking at is left alone rather than second-guessed.)
  14. End: on `needs_manual`/`submission_detected` the window is released (`deps.released.release(handle, ms)`,
      D132) instead of closed, unless a cancel landed in between (`releaseUnlessCancelled` re-checks and ends
      `abandoned` instead); every other ending closes the window and its `rootDir` immediately. An uncaught
      error anywhere in the try block -> `failSession(..., "unexpected_error")` then rethrows, so BullMQ marks
      the job failed and `main.ts`'s `worker.on("failed", ...)` logs the error's class only (D136).

### 13c. Polling and cancel (request-driven)

`AutofillPanel` polls `GET /api/automation-sessions?jobId=` (`route.ts` `GET`) every 2 s while the latest
session is active -> `getJobAutofillOverview` (`packages/browser/src/sessions/readSessions.ts`): re-runs
`getAutofillSupport`, checks for a resume PDF and an existing `applications` row for the job, and returns
the 10 newest sessions for the job -> serialized with `toSessionView` per session. The panel renders the
field audit split into flagged / filled / skipped lists (`REASON_TEXT` lookup) and shows a "is the worker
running?" hint once a `queued` session has waited over 10 s.

`AutofillPanel.cancel` -> `POST /api/automation-sessions/[id]/cancel`
(`apps/web/src/app/api/automation-sessions/[id]/cancel/route.ts`, new) -> `requestCancel`
(`packages/browser/src/sessions/transitions.ts`, D133): locks the row `FOR UPDATE`; `queued` -> `abandoned`
directly in the same transaction; any other active status -> sets `cancel_requested_at` only, which
`runSession`'s poll loop (13b step 13) and its per-action check (13b step 11) pick up; terminal ->
`not_cancellable` -> 409.

`GET /api/automation-sessions/[id]` (`[id]/route.ts`) -> `getSession` -- single-session detail, used for
direct links; not polled by the panel.

### 13d. Record as applied (request-driven)

`AutofillPanel.record` (shown once the latest session is `submission_detected` or `abandoned` and the job
has no application yet) -> `POST /api/applications {jobId, automationSessionId}`
(`apps/web/src/app/api/applications/route.ts`, existing route, new optional field) -> `createApplication`
(`packages/applications/src/createApplication.ts`), inside the same transaction as the ingested-job path:
  -> `lockLinkableSession` (`packages/applications/src/sessionLink.ts`, new, D135): locks the session row
     `FOR UPDATE`; must match `jobId`, be `submission_detected`/`abandoned`, and have no `application_id` yet,
     else `session_not_linkable` -> 409.
  -> `withSessionDocuments` (same file): resolves the session's attached `resumeDocumentId`/
     `coverLetterDocumentId` back to their `generated_documents.resumeOptimizationId`/`coverLetterId`
     sources and uses those as the new application's document links unless the request body overrides them.
  -> `loadLinkedDocuments` (existing, `packages/applications/src/documentLinks.ts`) validates the resolved
     ids as usual.
  -> inserts the `applications` row + initial `status_change` event (existing path), then
     `UPDATE automation_sessions SET application_id = {row.id}` -- all in the one transaction.
  -> Route returns 201; `AutofillPanel.record` dispatches `window.dispatchEvent(new
     Event(APPLICATION_RECORDED_EVENT))` ("application:recorded") so `ApplicationPanel` (12a) reloads and
     switches to its "Applied on ..." view without a page refresh. `AutofillPanel`'s own "Did you submit
     anyway? Record as applied" prompt (the `abandoned` case) only renders when `latest.startedAt` is non-null
     (D138): a session cancelled while still `queued` is `abandoned` with no `startedAt`, since the worker
     never claimed it and no browser window was ever opened for the user to have submitted from.
  -> The same event now also flows the other way (D138): `ApplicationPanel.submit`'s own successful "Mark as
     applied" (the ordinary document-picker path, not the autofill one) dispatches
     `APPLICATION_RECORDED_EVENT` too, and `AutofillPanel` now also listens for it and reloads its overview --
     so its Record button disappears (an application now exists for the job) instead of staying up and 409ing
     if clicked. `ApplicationPanel` guards its own listener (`justRecordedRef`) against redoing the fetch its
     own dispatch would otherwise immediately retrigger, since the POST response it just got is already the
     answer.

### Changing Phase 8 behavior

- **A new ATS portal** (e.g. Ashby): add an adapter implementing `PortalAdapter`
  (`packages/browser/src/adapters/types.ts`) next to `greenhouse.ts`/`lever.ts` -- `buildFormUrl`,
  `allowedHosts`, `snapshotConfig`, `requiredCanonicals`, `standardFields`, `confirmation` -- register it in
  `adapters/index.ts`'s `getAdapter`/`ADAPTERS` map and `resolveAutofillTarget.ts`'s own `BY_KIND` map and
  source-kind filter, and
  capture a sanitized fixture HTML copy of the real form under `packages/browser/fixtures/` (and
  `services/browser-worker`'s own fixture server, `testing/fixtureServer.ts`) for both the jsdom snapshot
  tests and the worker's headless-Chrome integration tests.
- **Classification rules** (which field maps to which canonical, what gets flagged vs. filled) live entirely
  in `packages/browser/src/plan/classifyField.ts` (the shared label-regex rules) and each adapter's own
  `standardFields` (id/name/label matchers, D129) -- never in the worker. `buildFillPlan.ts`'s
  `isAlwaysFlag`/`notFilled` is the one place the required/optional flag-vs-skip rule and the
  always-flag-regardless-of-required exceptions (D129) are encoded.
- **`services/browser-worker/src/actions.ts` is the only module allowed to call a Playwright locator mutation
  method.** Any new action kind must be added to `FillAction` (`packages/browser/src/types.ts`), given a
  guarded case in `performAction`/`verifyAction` -- pass an explicit `{ timeout: ACTION_TIMEOUT_MS }` on every
  Playwright call in that case, including `assertTarget`'s own `locator.evaluate` (D138): without one,
  Playwright's 30 s default timeout applies, which would let a single stale/detached target stall the whole
  session instead of failing fast into the next loop iteration's host check -- and must keep `noClick.test.ts`
  (D130, D138) passing -- it scans every non-test file in `services/browser-worker/src`, plus
  `packages/browser/src/snapshot/extractSnapshotSource.ts` (the other code that runs inside the application
  page), for click/press/submit/keyboard/dispatchEvent calls and fails the build if any exist outside this
  invariant.
- **The page's own form snapshot is untrusted input.** Anything the in-page extractor could be made to
  return goes through `sanitizeSnapshot` (`packages/browser/src/snapshot/sanitizeSnapshot.ts`, D138) before
  `classifyField`/`buildFillPlan` ever see it; a new `SnapshotControl` or a change to the snapshot shape must
  be reflected there too, or the new shape is silently dropped (fields) or rejected outright (top-level).

In Docker (D125): `docker compose -f infra/docker-compose.yml --profile workers up -d --build` builds
`services/maintenance-worker/Dockerfile` (repo-root context) and starts the `maintenance-worker` service,
whose `CMD` is `tsx src/main.ts` -- the same entry point as above, with config from the repo's `.env`
(`env_file`) and `DATABASE_URL`/`REDIS_URL`/`MINIO_ENDPOINT` overridden to the compose service names. The
one-off sweep is `docker compose ... --profile workers run --rm maintenance-worker node_modules/.bin/tsx
src/runOnce.ts`.

---

## 14. Phase 10a — Outcome Analytics

### 14a. Reading insights (request-driven)

```
GET /api/insights            apps/web/src/app/api/insights/route.ts
 ├─ loadEnv(); createDbClient(env)                    (closed in finally)
 ├─ loadInsightInputs(db, DEFAULT_USER_ID)            packages/insights/src/load/loadInsightInputs.ts
 │    one withUserContext transaction, repeatable read:
 │    applications (id, job_id, company, title, status, applied_at, created_at, feature_snapshot -- no notes/recruiter/salary notes/url)
 │    application_events of type status_change | recruiter_contact | interview (no detail; now also reads from_status)
 │    confirmed career_goals ⋈ career_goal_constraints (target roles, salary floor)
 ├─ buildOutcomeDataset(inputs, { now, undecidedDays: OUTCOME_UNDECIDED_DAYS })   dataset/buildOutcomeDataset.ts
 │    per application, most recently applied first:
 │    parseSnapshot (tolerant v1/v2) → labelOutcome (two tiers, D141; the creation status_change --
 │      from_status null -- is skipped as activity, since createApplication always writes it at `now`
 │      even for a backdated appliedAt, but still counts as stage evidence via to_status)
 │      → pickGoal + roleFamilyKey (D142; a title with no word characters is always "Other")
 │    → salaryVsFloor → OutcomeRecord
 ├─ computeInsights(records, { minBucket: INSIGHTS_MIN_BUCKET })                   stats/computeInsights.ts
 │    headlines per tier → 13 DIMENSIONS breakdowns per tier (Wilson intervals, standsOut, Others cap)
 │    → rejection patterns (missed terms, high coverage) (D144)
 └─ 200 { settings, totals, tiers, breakdowns, patterns }
/insights  apps/web/src/app/insights/page.tsx → InsightsClient.tsx fetches GET /api/insights once; the tier toggle is client-side.
```

### 14b. Snapshot v2 write (inside the existing createApplication transaction)

`createApplication` (`packages/applications/src/createApplication.ts`), ingested branch, after `loadLinkedDocuments`:
if a resume optimization is linked → read its `selected_bullets` and the job's `required` `job_requirements`
→ `findMissedTerms(terms, joinOptimizedText(bullets))` (`missedTerms.ts`) → `buildFeatureSnapshot({ ..., missedRequiredTerms })`
writes `snapshotVersion: 2` with `ats.missedRequiredTerms` (D143). Nothing else in the Phase 9 flow (§12) changes.

### Changing Phase 10a behavior
- Labels: `packages/insights/src/dataset/labels.ts` (+ `labels.test.ts`); the cutoff is `OUTCOME_UNDECIDED_DAYS`.
- A new dimension: add a `DimensionDef` to `stats/dimensions.ts`; if it needs a new snapshot field, read it in `parseSnapshot.ts` and add it to `OutcomeRecord`.
- A new snapshot field: write it in `packages/applications/src/snapshot.ts` and bump `snapshotVersion`; `parseSnapshot` must keep reading older versions.

---

## 15. Phase 10b — Personal Response Model

### 15a. `GET /api/matches` (predictions, and optionally the personal ranking)

```
GET /api/matches                        apps/web/src/app/api/matches/route.ts
 ├─ loadEnv(); createDbClient(env)
 ├─ loadResponseModel(db, env)           apps/web/src/lib/insights/responseModel.ts
 │    ├─ loadInsightInputs(db, DEFAULT_USER_ID)        packages/insights/src/load/loadInsightInputs.ts
 │    ├─ buildOutcomeDataset(inputs, {...})            packages/insights/src/dataset/buildOutcomeDataset.ts   (10a, unchanged)
 │    └─ trainResponseModelSafely(records, env)        apps/web/src/lib/insights/responseModel.ts
 │         ├─ cacheKey: sha256(JSON.stringify({ userId, minDecided, minPerClass, rows: trainingRows(records) }))   (D153)
 │         ├─ cache hit (same key as the last successful training) → reuse cached ModelResult, skip training
 │         └─ cache miss → trainResponseModel(records, settings)    packages/insights/src/model/trainResponseModel.ts
 │              ├─ trainingRows(records)                        -- decided, non-external, has factor scores
 │              ├─ gate: rows/class counts (insufficient_data if not met)
 │              ├─ fitModel(rows)                                -- fitScaling + standardize (prepareFeatures.ts) → fitLogistic (fitLogistic.ts)
 │              │    null: no varying factor → insufficient_data; any other fit failure → no_pattern, losses null (§4.2)
 │              ├─ leave-one-out: per row, fitModel(rest) → modelProbability vs. base rate, both log-losses
 │              └─ status: insufficient_data | no_pattern | active (+ model, blendWeight when active)
 │            → stored as the cache entry { key, result } (only on success)
 │         (any thrown error here -- or while loading the dataset -- goes through failed(): logged by class name only,
 │          degraded to no_pattern, never cached)
 ├─ withUserContext(db, DEFAULT_USER_ID, tx => listMatches(tx, query, { model, weight }))   apps/web/src/lib/matching/listMatches.ts
 │    ├─ default path (rank=default, or model inactive): existing SQL order/paging (D139), each row → predictResponse(model, factorVectorOf(row)) if model active and row eligible
 │    └─ personal path (rank=personal, eligible=true, model active): load every eligible open row → predictResponse per row → blendedScore(overall, probability, weight) → sort blended desc, overall desc, job id asc → page in code (§4.6)
 └─ 200 { matches: [...{ match: { ...factors, personal: ResponsePrediction | null } }], page, pageSize, total, ranking: "default"|"personal", model: ModelSummary }
```

### 15b. `GET /api/matches/[jobId]` (one prediction)

Same `loadResponseModel` call, then a single `predictResponse(model, factorVectorOf(matchRow))` when the model is active and the match is eligible; folded into the existing `toMatchView(matchRow, personal)` (`apps/web/src/lib/matching/serializeMatch.ts`) alongside `model: ModelSummary`. `PATCH` is unchanged. `MatchDetailClient.tsx` keeps `body.model`'s `decided`/`responses` and, under the prediction, renders `formatSampleSize` ("Based on {decided} decided applications ({responses} with a response).").

### 15c. `GET /api/insights` (explaining the model)

```
GET /api/insights                        apps/web/src/app/api/insights/route.ts
 ├─ loadInsightInputs → buildOutcomeDataset              (10a, unchanged -- same records as 15a, computed again on this request)
 ├─ computeInsights(records, {...})                      (10a, unchanged)
 └─ trainResponseModelSafely(records, env)   apps/web/src/lib/insights/responseModel.ts   (same cache as 15a: a hit skips training)
      └─ toModelInsightsView({ result, summary })        apps/web/src/lib/insights/responseModel.ts
           -- adds looLogLoss, baselineLogLoss, and factors: describeFactors(model) (packages/insights/src/model/predictResponse.ts) when active, else []
 → 200 { settings, ...insights(10a), model: ModelInsightsView }
```

`InsightsClient.tsx`'s `ModelSection` renders this: progress toward the gate, the honesty check (only when both log-losses are non-null), and — only when `active` — the sample size (`formatSampleSize`), the blend-weight note, each kept factor above `WEAK_ODDS_RATIO` (1.1) with direction and odds ratio, weaker factors grouped as "Little or no link so far", and a fixed not-a-cause note.

### 15d. The client (`/matches`)

```
MatchesClient.tsx
 ├─ rankWithHistory = useSyncExternalStore(subscribeRankPreference, readRankPreference, serverRankPreference)   apps/web/src/lib/insights/rankPreference.ts
 │    (server snapshot is always false; the stored localStorage choice, or the in-memory fallback, applies after hydration)
 ├─ load(): fetch(`/api/matches?eligible=...&page=1${rankWithHistory && !showIneligible ? "&rank=personal" : ""}`)
 │    -- latestRequest ref: only the response to the most recently issued request may call setResult (older, slower
 │       responses -- e.g. a default-ranked request still in flight when the toggle flips to personal -- are dropped)
 ├─ "Rank with my history" checkbox: disabled unless result.model.status === "active" (modelUnavailableReason, formatPersonal.ts, explains why,
 │    linked via aria-describedby="rank-with-history-reason"), and disabled + shown unchecked while "Show excluded jobs" is on
 │    (reason "Excluded jobs are always listed in the default order." when the model is otherwise active; the stored preference is left as it is)
 │    onChange → writeRankPreference(checked) → localStorage write (or in-memory only on failure) → notifies subscribers → re-render → new load()
 └─ MatchRow / match detail: formatLikelyResponse + formatFactorPushes (apps/web/src/lib/insights/formatPersonal.ts) render match.personal
```

### Changing Phase 10b behavior

- **Gate thresholds:** `OUTCOME_MODEL_MIN_DECIDED` / `OUTCOME_MODEL_MIN_PER_CLASS` in `.env` / `packages/config/src/env.ts` -- no code change needed to tighten or loosen the gate.
- **Fit/threshold constants** (ridge λ, Newton iteration cap/tolerance, the leave-one-out log-loss epsilon, the raises/lowers contribution threshold and cap, the weak-factor odds-ratio cutoff): named constants in `packages/insights/src/model/*.ts` (`RIDGE_LAMBDA`, `MAX_ITERATIONS`, `STEP_TOLERANCE`, `LOG_LOSS_EPSILON`, `CONTRIBUTION_THRESHOLD`, `MAX_NAMED_FACTORS`) and `apps/web/src/app/insights/InsightsClient.tsx` (`WEAK_ODDS_RATIO`) -- never inline magic numbers.
- **Factor display names:** `FACTOR_LABELS` in `packages/insights/src/model/predictResponse.ts` (keep in sync with the factor chip labels on `/matches`).
- **The blend formula / weight cap:** `blendWeight`/`blendedScore` in `packages/insights/src/model/{trainResponseModel,predictResponse}.ts`.

## 16. Phase 11a — AI Usage Observability & Cost Control

### 16a. One tracked Anthropic call

```
caller (route / pipeline / worker)
 ├─ usageSink = createUsageSink(db, env)                 apps/web/src/lib/aiUsage/createUsageSink.ts
 │     = withLangfuseExport(new DbUsageSink(db, DEFAULT_USER_ID), env)     (matching worker: per job, for job.data.userId)
 ├─ anthropicFor = createAnthropicFor(env, usageSink)    packages/ai/src/usage/anthropicFor.ts   (one SDK client, ANTHROPIC_API_KEY)
 └─ generator(anthropicFor("<operation>"), env, input)   e.g. generatePitch -- unchanged prompt/parse code, typed MessagesClient
      └─ messages.create(body)  → trackAiCall(ctx, call)                    packages/ai/src/usage/track.ts
           1. checkBudget(sink, env, now)                                   packages/ai/src/usage/budget.ts
                ceiling 0 → skip; spend = sink.spendSinceUsd(utcMonthStart(now))  → DbUsageSink: SUM(estimated_cost_usd) under RLS
                spend >= ceiling → record { outcome: blocked, error_code: budget_exceeded, cost 0 } → throw AiBudgetExceededError
                spend query throws → record { blocked, budget_check_failed } → rethrow (fail closed)
           2. call(): SDK messages.create (SDK's own 2 retries) → usage from message.usage
                (no usage block → outputTokens = body.max_tokens, row error_code usage_estimated -- D164)
                throws → record { api_error, error_code: anthropicErrorCode(e) } → rethrow the original error
           3. estimateCostUsd("anthropic", message.model, usage)            packages/ai/src/usage/prices.ts
           4. record { ok, tokens, web searches, latency, cost, price_known }  → safeRecord: a failed insert logs
                {"event":"ai_usage_record_failed",...} and never fails the call
                └─ DbUsageSink.record → INSERT ai_calls (RLS: SELECT/INSERT policies only)
                └─ withLangfuseExport: after the insert, void POST {LANGFUSE_HOST}/api/public/otel/v1/traces (3 s timeout,
                   failures → process counter in GET /api/health)                 packages/ai/src/usage/langfuse.ts
```

Operations by caller: `resume_extraction` (`POST /api/profile/resume`), `career_goal_parse` (`POST /api/career-goal/parse`),
`job_requirements_extraction` + `resume_optimization` (`runResumeOptimization`), `company_research` + `job_requirements_extraction`
(`prepareApplicationContext`, and the research-refresh route), `pitch_generation` / `cover_letter_generation` /
`interview_prep_generation` (their `run*Generation`), `match_explanation` (`runMatching`).

### 16b. One tracked Voyage call

```
embedTexts(env, texts, { sink, operation })              packages/ai/src/embeddings.ts
 ├─ texts empty → [] (no call, no row); provider not voyage → EmbeddingProviderNotImplementedError (no row)
 └─ trackAiCall(...)  -- same gate / record / export as 16a, provider "voyage"
      └─ up to 3 attempts: network error, 429, 5xx → sleep(retry-after s ≤ 30 s, else 500ms·2^(n-1) ±20%) → retry
         other 4xx or 3rd failure → VoyageRequestError("Voyage embeddings request failed: <status>")
```

Operations by caller: `profile_fact_embedding` (`saveConfirmedProfile`), `goal_embedding` (`ensureGoalEmbedding`, from
`confirmCareerGoal` and `runMatching`), `job_embedding` (`ensureJobEmbeddings`, from `runMatching`), `resume_similarity_embedding`
(`runResumeOptimization`). All four keep D56's degrade rule: any error, including a budget block, leaves the embedding null.

### 16c. Where `AiBudgetExceededError` ends up

```
POST /api/profile/resume            → resume_documents.extraction_status=failed, extraction_error=ai_budget_exceeded → 429
POST /api/career-goal/parse         → career_goals.parse_status=failed, parse_error=ai_budget_exceeded → 429
POST /api/resume-optimizations/[jobId]/run, /api/application-pitches/[jobId]/run, .../research/refresh,
     /api/cover-letters/[jobId]/run, /api/interview-preps/[jobId]/run
                                    → passes through the pipelines' APIError→"unknown" mapping (not an APIError) → 429
                                      budgetExceededResponse(error)   apps/web/src/lib/aiUsage/budgetResponse.ts
                                      { error: "Monthly AI budget reached ($X of $Y). Raise AI_MONTHLY_BUDGET_USD or wait until <date> (UTC).",
                                        code: "ai_budget_exceeded", spentUsd, ceilingUsd, resetsAt }
runMatching explanation loop        → break; run completes with every score stored
ensureJobEmbeddings chunk loop      → break; remaining jobs counted as failed
ensureCompanyResearch               → propagates before any company_research write (nothing cached)
```

### 16d. Reading usage

```
GET /api/usage                          apps/web/src/app/api/usage/route.ts
 ├─ SELECT ai_calls WHERE created_at >= utcMonthStart(now)   (withUserContext)
 └─ summarizeUsage(rows, env, now)      apps/web/src/lib/aiUsage/summarizeUsage.ts  → spend, state, byOperation, byModel,
                                        unknownPriceModels, recentFailures (20)
/usage           → UsageClient fetches GET /api/usage            apps/web/src/app/usage/UsageClient.tsx
/ (home)         → AiUsageLink fetches GET /api/usage; badge at warn/over   apps/web/src/app/AiUsageLink.tsx
GET /api/health  → + aiUsage { langfuseEnabled, langfuseExportFailures }    apps/web/src/app/api/health/route.ts
```

## 17. Phase 11b — Structured Logging, PII Scrubbing & Monitoring

### 17a. A log line

```
createLogger({ service }).error(event, fields)        packages/logging/src/logger.ts
 ├─ below the process level (configureLogging / initProcessLogging; default info)? → nothing written
 ├─ sanitize(fields, defaultRedactor())                packages/logging/src/sanitize.ts
 │    strings → Redactor.redact (D9 values, then the email pattern) → truncate 500
 │    Error   → { name, code? (code-shaped), causeName?, frames ≤ 8 repo-relative }   -- frames read only after the exact
              "<name>: <message>" header, or Node's "<name> [<code>]: <message>" (no match → no frames); name/causeName identifier-shaped or "Error";
              frames scrubbed (D173, D175)
 │    top-level `error` that is not an Error → { name: "NonError", type }  (a rejected string/object can carry content) (D175)
 │    objects ≤ depth 3, arrays ≤ 50, cycles "[circular]", Date → ISO, bigint → string
 └─ JSON line { ts, level, service, event, ...fields } → stderr (warn/error) | stdout (debug/info); never throws
```

### 17b. Keeping the D9 values current

```
worker main.ts (all four) / runOnce.ts
 └─ initProcessLogging({ level: env.LOG_LEVEL, load: () => loadRedactionValues(db, DEFAULT_USER_ID), logger })
      packages/logging/src/processLogging.ts → createRedactionRefresher(defaultRedactor(), load)   packages/logging/src/refresher.ts
      ├─ installs uncaughtException / unhandledRejection handlers once → log message-free, exit 1 (D173)
      ├─ await refresh()                    -- before the first line; a failed load logs redaction_refresh_failed, keeps old values
      └─ startInterval(60 s) → stop()       -- called in shutdown
      loadRedactionValues                   packages/db/src/redactionValues.ts  (candidate_profiles under RLS)
web: refreshWebRedactions()                 apps/web/src/lib/webLogging.ts   (first call: configureLogging(LOG_LEVEL) + refresher;
                                            then refreshIfStale, ≤ once a minute, one short-lived DB connection per load)
     invalidateWebRedactions()              ← saveConfirmedProfile after a successful save (next error reloads)        (D174)
refresher: each load ≤ 2 s (RedactionLoadTimeout); every attempt, failed or not, starts the 60 s window     (D174)
           a timed-out load still applies when it lands, unless a newer load already succeeded (numbered loads) (D175)
```

### 17c. An error escaping a route

```
export const POST = withRouteErrors("/api/x/[id]", handlePOST)     every apps/web/src/app/api/**/route.ts
 └─ withRouteErrors                          apps/web/src/lib/http/withRouteErrors.ts
      try handlePOST(...)  → its own Response, untouched (404/409/429/502 ...)
      catch error
       ├─ requestId = 8 hex chars
       ├─ await refreshWebRedactions()       (never throws)
       ├─ log.error("request_failed", { requestId, route, method, path (no query), error })
       └─ 500 { error: "Something went wrong (request <id>). Details are in the server log.", requestId } + x-request-id
render errors: instrumentation.ts onRequestError → (Node.js runtime only) import("./lib/renderErrors") → log.error("render_failed")
guard: apps/web/src/lib/http/allRoutesWrapped.test.ts
```

### 17d. Heartbeats and /status

```
worker main.ts → (right after Redis opens) startHeartbeat(connection, "<worker>", { intervalMs: HEARTBEAT_INTERVAL_MS })
                  SET careerpilot:worker:<worker> {startedAt, beatAt, pid, stoppedAt:null}  now + every interval
shutdown = createShutdown({ logger, steps })     packages/monitoring/src/shutdown.ts   (D174)
  SIGINT/SIGTERM (any number) → steps once: worker.close → heartbeat.stop() (SET ... stoppedAt, ≤ 2 s) → connection.quit → db
  → exit 0 | step throws → shutdown_failed, exit 1 | still waiting after 8 s → shutdown_timed_out, exit 1   (D175: 8 s, ref'd)
worker.on("error", throttleErrorLog(log, "worker_error"))   packages/logging/src/throttle.ts                  (D175)
  first error logged in full; the rest counted for 60 s → one worker_error_suppressed { count, windowMs }

GET /api/status                               apps/web/src/app/api/status/route.ts → loadStatus(env, now, checks?)   apps/web/src/lib/status/loadStatus.ts
 ├─ loadEnv() throws → 200 unavailableReport() (status_config_invalid logged)          (D174)
 ├─ in parallel: database SELECT 1 (5 s) and the Redis steps below                     (D174)
 ├─ database: SELECT 1 (5 s)                  → ok | unavailable
 ├─ Redis: lazyConnect → connect() → ping (5 s each); failure → redis unavailable, workers [], queues []
 ├─ readWorkerStatus(redis, now, { staleAfterMs: STATUS_STALE_AFTER_MS })   packages/monitoring/src/status.ts → workerState()
 └─ readQueueStatus(redis, QUEUES)            getJobCounts + getFailed(0,0); failedReason only if failureCode() accepts it
/status → StatusClient fetches GET /api/status on load, every 30 s and on Refresh (newest response wins)

## 18. Phase 11c–11d — Request Gate, Rate Limits, Job Errors, E2E

### 18a. Every request (D177, D179)

```
browser / client
 └─ next start -H $APP_HOST (127.0.0.1)                 apps/web/package.json
     └─ proxy(request)                               apps/web/src/proxy.ts   (all paths but _next/static, _next/image, favicon.ico)
          config ??= gateConfig()                    lib/security/gate.ts → loadEnv(); invalid config → still requires a set token
          checkRequest({ method, pathname, search, headers }, config)
           ├─ Host not loopback / ALLOWED_HOSTS      → 421 { error: "Unknown host" }
           ├─ unsafe method + foreign Origin / null / Sec-Fetch-Site cross-site|same-site → 403
           ├─ no token configured, exempt path (/unlock, /api/unlock, /api/health) or valid cookie/Bearer → NextResponse.next()
           ├─ /api/*                                 → 401 { error: "Access token required" }
           └─ page                                   → 307 /unlock?next=<path+query>
     └─ next.config.ts headers()                     nosniff, DENY, same-origin, Permissions-Policy, CSP frame-ancestors 'none'
        experimental.proxyClientMaxBodySize = MAX_UPLOAD_BYTES + slack   lib/http/uploadLimits.ts
startup: instrumentation.register() → lib/security/startupCheck.ts → warn exposed_without_token if APP_HOST not loopback and no token
```

### 18b. Unlock

```
/unlock (page.tsx: safeNextPath(next)) → UnlockForm → POST /api/unlock { token }
 └─ withRouteErrors → withRateLimit("unlock", 5/min) → handleUnlock(request, gateConfig(), log)   lib/security/unlock.ts
      no token configured → 404 | bad body → 400 | sameSecret() false → 401 + log unlock_failed {}
      ok → 204 + Set-Cookie cp_access=HMAC(token) HttpOnly SameSite=Lax Path=/ 30 d (Secure on https)
 → window.location.assign(next)
```

### 18c. A costly route (D178)

```
export const POST = withRouteErrors("/api/x", withRateLimit("ai" | "jobs", "/api/x", handlePOST))
 └─ withRateLimit                                    apps/web/src/lib/http/rateLimit.ts
      limit = RATE_LIMIT_{AI,JOBS}_PER_MINUTE (0 → skip)
      redisStore.hit("careerpilot:rl:/api/x:<minute>")  MULTI INCR + PEXPIRE (both checked), 500 ms timeout
       ├─ store error → rate_limit_unavailable (throttled) → handler      (fail open)
       ├─ count > limit → 429 { error, retryAfterSeconds } + Retry-After
       └─ handler(...args)
guard: apps/web/src/lib/http/rateLimitedRoutes.test.ts
```

### 18d. A failing worker job (D180)

```
BullMQ Worker processor (services/*/src/worker.ts)
 └─ try { pipeline } catch (error) { throw contentFreeJobError(error) }   packages/monitoring/src/jobError.ts
      message already a code (no_active_goal, …)    → unchanged
      DrizzleQueryError / PostgresError              → Error("database_error:<sqlstate>", { cause })
      anything else                                  → Error("job_failed:<code|class>", { cause }); UnrecoverableError keeps its name
 └─ BullMQ stores message + stack in Redis (content-free) → /status shows it via failureCode()
 └─ worker.on("failed", (job, rawError)) → originalJobError(rawError) → log.error(... { error })   real frames + SQLSTATE
```

### 18e. `pnpm e2e` (D182, D183)

```
e2e/run.mjs
 ├─ e2eEnv(): .env under process.env, then overrides (test DB, REDIS db 1, user …e01, fake AI keys + bases, token, low limits)
 ├─ wipeE2eState(): refuse non-*_test DB; delete user …e01 rows (session_replication_role=replica); delete bull:* careerpilot:* in db 1
 ├─ start: fakeProviders.mjs :4012 | web :3100 | web-broken :3101 (DB port 5999) | job-ingestion | matching-worker   (process groups)
 ├─ runSmoke(ctx)                                      e2e/smoke.mjs (playwright-core, headless Chrome)
 └─ stopAll(): SIGTERM groups, SIGKILL after 10 s; exit 0 | 1
CI: .github/workflows/ci.yml test job → pnpm test → playwright-core install chromium → pnpm e2e → upload e2e/.out on failure
```

## 19. Phase 12 — Broad Job Discovery

### 19a. A search source's run (D187)

```
/sources DiscoveryPanel → PUT /api/discovery/providers/remotive {enabled}   apps/web/src/lib/discovery/discovery.ts setProvider
  (needs discovery_settings.consented_at; keyed providers need their .env keys) → job_sources row, origin 'search'
job-ingestion worker (reconcile tick schedules it like any enabled source, every INGEST_INTERVAL_MINUTES)
 └─ runIngestion                                   packages/ingestion/src/pipeline/runIngestion.ts
      origin search/discovered → discovery_settings must still hold consent (discovered: auto_discover too) (D190)
      search kind → activeGoalQuery(): active confirmed goal → { roles ≤5, locations ≤5, remoteOnly, maxDaysOld, maxPages }
      adapterFor(ref) → createSearchAdapter(kind)   adapters/search.ts (≤50 requests, each job once per run)
        no query → no_active_goal | no roles → no_search_terms | no key → missing_api_key
      normalizeRecord → fromRemotive / fromAdzuna / fromHn …           normalize/normalizeRecord.ts
      complete → closeMissingPostings(cutoff = start − DISCOVERY_STALE_DAYS)   (boards: cutoff = start)
every adapter fetches through createPoliteFetch (1 req/s per host, short Retry-After honoured)   adapters/politeFetch.ts (D188)
```

### 19b. Discovering and validating boards (D186)

```
createIngestWorker processor → runIngestion → afterRun({ sourceId, since, errorClass })   services/job-ingestion/src/worker.ts
  (afterRun errors are logged as discovery_failed and never fail the job)
main.ts afterRun:
 ├─ success → recordBoardsFromRun(db, { sourceId, since })        packages/ingestion/src/discovery/discover.ts
 │     needs consent + auto_discover; raw records of this run → stringsIn → extractBoardLinks (boardLinks.ts)
 │     minus boards already present as sources → discovered_boards (pending, found_via_source_id)
 │   → void validateBoards() (background) → validatePendingBoards(db, { adapterFor, maxSources 300, maxPerRun 25 })
 │        ≤500 oldest pending; skip ones checked < 1 h ago; every attempt counts towards maxPerRun
 │        per pending board: first record of adapterFor(board).fetch
 │          a job → (re-read settings FOR SHARE; stop if consent / auto-discover gone)
 │                  job_sources (enabled, consent = consented_at, origin discovered | manual if pasted), board 'enabled'
 │          none / not_found / invalid_slug / http_error / response_too_large → 'rejected'
 │          transient (incl. schema_mismatch) → checked_at = now; still failing 7 days after first seen → 'rejected' (D190)
 └─ not_found → retireIfGone: discovered source whose last 2 runs were not_found → disabled, board 'gone'
setInterval 60 s → reconcile schedules + validateBoards() (picks up pasted boards)
/sources paste → POST /api/discovery/boards {text} → importBoards → pending boards (found_via null)
```

## 20. Phase 13a — One-Click Discovery

### 20a. The click (request-driven)

```
/matches FindJobsPanel "Find matching jobs" → POST /api/search-runs        apps/web/src/app/api/search-runs/route.ts
  startRun (lib/searchRuns/searchRuns.ts, advisory lock per user):
    no discovery consent → 409 consent_required → inline consent → POST /api/discovery/quick-start (quickStart) → retry
    no active confirmed goal → 409 no_active_goal → link to /career-goal
    failStalled (no heartbeat 10 min → failed/stalled); a run in progress → 200 { run } (idempotent)
    insert search_runs (queued) → enqueueSearchRun (queue "search-runs", jobId = run id) → 202 { run }
    queue down → failQueued (only while still queued: a run the coordinator already claimed is left alone) → 503
FindJobsPanel polls GET /api/search-runs/latest every 3 s while queued/running/matching; on finish → MatchesClient.load()
  each loaded run → onRunLoaded → MatchesClient hides its own matching-run alert when the run failed with
  matching_failed / matching_timeout (explainsMatchingFailure, lib/searchRuns/format.ts) -- one alert, the panel's
  a run that ended with late sources → results reload every 30 s for 10 minutes after it finished (their jobs arrive via the 20c re-match)
```

### 20b. The coordinator (process-driven) — services/job-ingestion

```
search-runs Worker (searchRunWorker.ts, concurrency 1) → coordinateSearchRun   packages/ingestion/src/searchRun/coordinateSearchRun.ts
 1. claim queued → running; re-check goal + consent (else failed with the code)
    every later write is status-guarded (WHERE id AND status IN running/matching); a write that updates no row
    (the web marked the run stalled/failed) stops here: nothing more is written, matching is not requested,
    the row's current status is returned
    any unexpected error after the claim → run failed/coordinator_error (guarded too), error rethrown (no phantom run)
 2. planSourceRefresh (plan.ts): enabled, consented, non-upload sources → reused | queued → ingest queue (fixed job id)
 3. probeEmployerNames → pending name_probe boards; webSearchDue → searchWebForBoards (anthropicFor("discovery_web_search"),
    120 s request timeout WEB_SEARCH_TIMEOUT_MS)
    → pending web_search boards, stamp discovery_settings.last_web_search_*; startValidation() (background validateBoards)
 4. every 2 s: heartbeat; applyRunUpdates from the latest ingestion_runs row per queued source that started >= run start,
    or is still in flight (finished_at IS NULL), or finished >= run start; deadline → markLate
 5. status matching → requestMatching (pushMatching, promote delayed; then flagRematchIfRunning)
    → every 2 s read all matching_runs started since the request: any completed → completed;
      at the match deadline: latest failed → matching_failed (a failed attempt may still be retried, so keep waiting
      until then), else matching_timeout
validatePendingBoards (discover.ts) → checkCompany (companyCheck.ts) for name_probe/web_search boards
```

### 20c. Re-match outside a click

```
ingest worker afterRun (main.ts) → requestRematchSafely(check = afterRunRematch, rematch = requestRematch)   rematch.ts
  (a failure is logged rematch_failed and never skips board discovery)
  check afterRunRematch (rematch.ts): changed jobs and no queued/running search run
  → requestRematch (packages/matching/src/enqueue.ts): delayed MATCH_DEBOUNCE_SECONDS; then flagRematchIfRunning
flagRematchIfRunning (enqueue.ts; also the coordinator's requestMatching): result "running" → SET flag EX 3600
  (REMATCH_FLAG_TTL_SECONDS) → re-check queue.getJob(matching-<user>): gone (the run finished meanwhile) →
  takeRematchFlag → if taken, pushMatching now (never both this and the follow-up)
matching worker completed / final failure (exhausted attempts or UnrecoverableError) → createFollowUp (followUp.ts): takeRematchFlag → pushMatching
```

## 21. Phase 13b — Missing-Skill Verification

### 21a. After matching (process-driven)

```
matching worker "completed" event (services/matching-worker/src/main.ts)
  → refreshRequirements = createRequirementsRefresh (requirementsRefresh.ts; single-flight per user,
    a request during a pass schedules exactly one more; never rejects, errors → requirements_refresh_failed)
  → ensureTopMatchRequirements (packages/resume-optimization/src/gaps/topMatchRequirements.ts)
     ├─ selectTopMatchJobs: eligible matches of open jobs by overall_score DESC (ties by job id), limit SKILL_GAP_TOP_N
     └─ per job, own withUserContext transaction: ensureJobRequirements (hash cache hit = no AI call; fresh = rows match description_hash, or no rows and
        jobs.requirements_extracted_hash = description_hash, which a zero-requirement extraction sets -- D205)
        AiBudgetExceededError → stop the step (budgetStopped); any other error → skipped, requirements_failed logged by job id
  → log requirements_checked { jobs, failed, budgetStopped }
```

### 21b. Reading gaps (request-driven)

```
GET /api/skill-gaps → lib/skillGaps/loadSkillGaps.ts loadSkillGapsOverview(tx, env.SKILL_GAP_TOP_N)
  ├─ loadAnswerContext: buildResumeSnapshot (catalog incl. verified_skill) + skill_verifications + skills names
  ├─ selectTopMatchJobs + job_requirements; freshRequirements keeps a job only if every row's
  │  extraction_source_description_hash = jobs.description_hash, or the job has zero rows and
  │  jobs.requirements_extracted_hash = jobs.description_hash (D205, ready with no gaps); else counted in jobsWithoutRequirements
  └─ computeSkillGaps per job (gaps/computeSkillGaps.ts) → unanswered grouped by term_key, jobCount desc
GET /api/skill-gaps/[jobId] → loadJobSkillGaps (any job with a match row; 404 otherwise)
POST /api/skill-gaps/[jobId]/requirements (rate limit "ai")
  → ensureJobRequirements(anthropicFor("job_requirements_extraction")) → loadJobSkillGaps
  (AiBudgetExceededError → 429; Anthropic.APIError / JobRequirementExtractionValidationError → 502)
```

### 21c. Answering (request-driven)

```
SkillAnswerForm (app/skills; also SkillGapsPanel on /matches/[jobId])
  → PUT /api/skill-verifications → readJsonBody → SkillVerificationBodySchema (verificationBody.ts)
  → saveVerification (lib/skillGaps/saveVerification.ts): term_key = normalizeTermKey(termDisplay);
    alias must name a current profile skill (else 422); upsert on (user_id, term_key), last answer wins
  → SKILL_GAPS_CHANGED_EVENT → /skills and the job panel reload
Undo (SkillsClient) → DELETE /api/skill-verifications/[id] → row deleted (404 if unknown) → same event
```

### 21d. Where answers are used

```
buildResumeSnapshot (packages/resume-optimization/src/optimization/buildResumeSnapshot.ts) → verified_skill catalog entries
  ("have": "<term>: <evidence>"; alias whose profile skill still exists: "<term> (same as <skill>)")
  → runResumeOptimization / optimizeResume (prompt: verified_skill entries are the candidate's own confirmation)
  → applyDeterministicGuard (unchanged: checks catalog ids)
  → cover letter / interview prep: computeGapTerms haystack is the catalog, so a verified term is no longer a gap
document-export: loadResumeProfile.verifiedSkills (have + live alias rows)
  → buildResumeModel Skills section: profile skills, then verified terms (selected first, every one rendered)
```

## 22. Phase 13c — Tailored LaTeX Resume

Files changed in this phase are marked **(new)** or **(changed)**; unmarked files are called unchanged.

### 22a. Export (request-driven)

```
ResumeOptimizationPanel (changed) → TailoredResumeExport (new) → DownloadButtons (changed; PDF / .tex)
  → POST /api/documents   apps/web/src/app/api/documents/route.ts (changed)
     ExportBodySchema.superRefine: format "tex" only with kind "tailored_resume"; tailored_resume only pdf|tex (else 400)
  → runExport (kind "tailored_resume") → texCompilerFromEnv (new; apps/web/src/lib/documents/texCompiler.ts):
     LATEX_COMPILER_URL + LATEX_COMPILER_TOKEN both set → createHttpTexCompiler, else null
  → exportTailoredResume (new; packages/document-export/src/pipeline/exportTailoredResume.ts)
     1. format "pdf" with a null compiler → compiler_unavailable (503)
     2. loadResumeExportContext (new; the D84 checks shared with exportResume, which now uses it):
        job 404, source_mismatch 400, profile_changed 409, no_profile 409
     3. job_requirements rows for the job (termText, requirementLevel)
     4. build(extraRemovals) = selectTailoredResume (new; uses estimateLines (new), containsTerm): remove worst-first until it fits,
        one greedy refill pass over the removed items (best-ranked first), then extraRemovals; skills past the 2-line cap go to omitted → normalizeModel
        floors never removed: every role header; top 2 bullets of the two most recent roles; an older role's top bullet only
        when it is relevant (optimizer-selected or matching a requirement, D216); education, certifications, skills
     5. first model only: assertSafeModel, then findUnsupportedCharacter (new; render/tex/escapeTex.ts)
        → unsupported_character 422 with a location
     6. fitToPage (new; pipeline/fitToPage.ts), render = renderTex (new; render/tex/renderTex.ts, uses escapeTex)
        loop: build(extra) → renderTex → compiler.compile
        ├─ createHttpTexCompiler (new; render/compileTex.ts) → POST {LATEX_COMPILER_URL}/compile, Bearer token
        │   ├─ services/latex-compiler/src/server.ts (new): auth → size limit 256 KB → limiter (2 running + 4 waiting, else 503)
        │   │   → compileTex (compile.ts): mkdtemp → runPdflatex (runPdflatex.ts, no shell-escape, 20 s kill)
        │   │   → parseOutput (page count; free space from the template's line-anchored CAREERPILOT-FREE-SPACE marker, D217)
        │   │   → 200 PDF + X-Page-Count + X-Tex-Version (+ X-Free-Space-Pt, whole points) (temp dir removed in finally)
        │   └─ failures → DocumentExportError: 503 busy → compiler_busy, 504 → compiler_timeout, 422 → compile_failed,
        │      transport errors (request or PDF body read) → compiler_timeout (TimeoutError/AbortError) or compiler_unavailable
        ├─ pageCount > 1 and extra < 3 and not exhausted → extra++ and again; otherwise stop (pageCount 2 is exported, flagged)
        ├─ refill (D217): one page with a reported free space → for selection.refill (cut items, best-ranked first, each with
        │  its estimated addedLines): skip if addedLines × 13 pt > free space or its page fails the export's checks; else build(extra, include + item) → compile;
        │  keep only if still one page (free space updated); at most 4 refill compiles; compile_failed skips the candidate, compiler busy/timeout/unavailable ends the refill
        │  (selectTailoredResume puts `include` back after all removals, so every other removal stays as it was)
        └─ format "tex" and the compiler was unavailable / busy / timed out → fitToPage(build, render, null): estimate only, pageVerified false
     7. details = { pageCount, pageVerified, includedCount, totalCount, omitted } (ids and reasons)
     8. tailoredContentHash (changed; model/hash.ts) → storeDocument (changed; pipeline/storeDocument.ts, `prerendered` buffer:
        the compiled PDF or the .tex text) → MinIO (key extension .tex via storage/generatedDocumentStorage.ts, changed)
        + generated_documents row (kind tailored_resume, details jsonb; migration 0038)
     9. returns { document, omittedItems (text resolved from the profile, R3) }
  → route: serializeDocument (changed; includes details) → 201 { document, omittedItems }
  → exportErrorResponse (changed; lib/documents/exportErrors.ts): status per error class; compiler_unavailable carries the start command
```

### 22b. Download and listing

```
GET /api/documents/[id]/download (changed) → CONTENT_TYPES.tex = application/x-tex; filename "<Name> - <Company> - Resume.tex"
  (buildDownloadFilename, changed: label + extension)
GET /api/documents?jobId= → DocumentsList (changed): tailored rows show "Included N of M items · page summary" from details only
TailoredResumeExport renders the page summary and the collapsible "Left out" list from the POST response (omittedItems)
```

### 22c. Autofill

```
automation-sessions start → loadAutofillContext (changed; packages/browser/src/sessions/loadAutofillContext.ts)
  resumeDocument = newestPdf("tailored_resume") ?? newestPdf("resume")   (the file is still uploaded as resume.pdf)
getJobAutofillOverview (changed; readSessions.ts): resumeAvailable counts kind resume or tailored_resume PDFs
```

### 22d. Not changed

`exportResume` (full-profile PDF/DOCX), the pitch, cover letter and interview prep exports, and the optimizer, whose `selectedBullets` this feature reads and whose guard (D63) remains the only authority on applied bullets.
