# Phase 2 Design — Candidate Profile

Status: **design approved, not yet implemented.** See `docs/superpowers/plans/` for the implementation plan once written. See `DECISIONS.md` (D14–D18) for the rationale behind each choice below.

## 1. Scope

This phase implements the second step of the spec's user journey (§5): `Upload Master Resume → Build Candidate Profile`. It covers:

- Resume upload (PDF, DOCX, LaTeX) to MinIO.
- AI-assisted structured extraction of profile data from the resume, with a mandatory human review/confirm step before anything is persisted as canonical (D15).
- The candidate profile data model (§6.1 of the spec): education, work experience, skills, projects, certifications, achievements, plus preference fields (work mode, salary expectations, visa/work-authorization, preferred/excluded companies, preferred roles/industries).
- The `profile_facts` table — one row per atomic confirmed profile item, each with a Voyage embedding — required by the D5 hallucination guardrail used in later phases.
- Full-stack: database schema, API routes, and the Next.js UI to exercise upload → review → confirm → view/edit.

**Explicitly out of scope** (later phases): Career Goal Statement parsing (§6.2), Job Intelligence/ingestion (§7), the matching engine (§8), resume optimization and the entailment check that actually *uses* `profile_facts` (§10, D5), multiple resume versions, account-wide data export/deletion.

## 2. Data model

All tables are `packages/db/src/schema/*.ts` Drizzle definitions, RLS-enabled per D2/D12 (`user_id UUID NOT NULL DEFAULT current_setting('app.current_user_id')::uuid`, `ENABLE ROW LEVEL SECURITY`, app-role grants — never the migration superuser role).

### `resume_documents`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid | RLS |
| object_key | text | MinIO key: `resumes/{user_id}/{uuid}.{ext}` |
| original_filename | text | for display only, never used as the storage key |
| mime_type | text | detected via content sniffing, not trusted from the client |
| file_size_bytes | integer | |
| extraction_status | enum: `pending`, `extracted`, `failed` | |
| extraction_error | text, nullable | set when `failed` |
| is_active | boolean | exactly one `true` row per user (D18) |
| uploaded_at | timestamptz | |

### `candidate_profiles` (1:1 per user)
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid unique | RLS |
| full_name | text | feeds D9's redaction list |
| email | text | feeds D9's redaction list |
| phone_number | text, nullable | feeds D9's redaction list |
| linkedin_url | text, nullable | feeds D9's redaction list |
| address_line1 | text, nullable | feeds D9's redaction list |
| years_of_experience | integer, nullable | |
| work_mode_preference | enum: `remote`, `hybrid`, `onsite`, `any` | |
| salary_expectation_min | numeric, nullable | |
| salary_expectation_max | numeric, nullable | |
| salary_currency | text, nullable | ISO 4217 code |
| visa_sponsorship_required | boolean | |
| work_authorization_notes | text, nullable | free text, e.g. "US citizen", "requires H-1B" |
| preferred_role_titles | text[] | D14: array, not a table — unstructured preference, not a D5 fact |
| preferred_industries | text[] | same |
| excluded_industries | text[] | same |
| created_at / updated_at | timestamptz | |

### `education`
`id, user_id, institution, degree, field_of_study, start_date, end_date (nullable), gpa (nullable)`

### `work_experiences`
`id, user_id, company, title, location, employment_type, start_date, end_date (nullable = current role)`

### `work_experience_bullets`
`id, user_id, work_experience_id (fk), text, display_order`

### `skills`
`id, user_id, name, category (nullable, e.g. "language", "tool", "framework")`

### `projects`
`id, user_id, name, description, url (nullable)`

### `certifications`
`id, user_id, name, issuer, issue_date (nullable), expiry_date (nullable)`

### `achievements`
`id, user_id, description`

### `preferred_companies` / `excluded_companies`
Single table: `id, user_id, company_name, list_type (enum: 'preferred' | 'excluded')` — kept as real rows per the spec's "first-class structured data" framing for exclusions.

### `profile_facts`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid | RLS |
| source_type | enum: `work_experience_bullet`, `education`, `skill`, `project`, `certification`, `achievement` | |
| source_id | uuid | app-enforced polymorphic reference (D14) — no DB-level FK |
| fact_text | text | the exact confirmed text this fact asserts |
| embedding | vector(n) | pgvector column; dimension matches the configured Voyage model |
| embedding_model | text | records model/version used, for future cache invalidation |
| content_hash | text | sha256 of `fact_text`; permanent embedding cache key (D8) |
| created_at | timestamptz | |

## 3. Upload → extraction → review → confirm pipeline

```
POST /api/profile/resume (multipart, one file)
  │
  ▼
Validate: content-sniffed mime type ∈ {pdf, docx, tex}, size ≤ 10MB
  │
  ▼
Deactivate current active resume_documents row (is_active=false), if any
  │
  ▼
Store original file in MinIO: resumes/{user_id}/{uuid}.{ext}
Insert new resume_documents row (is_active=true, extraction_status='pending')
  │
  ▼
Extract raw text:
  pdf  → pdf-parse
  docx → mammoth
  tex  → read as UTF-8, no stripping (Claude reads LaTeX source directly)
  │
  ▼
Anthropic call (fast/cheap tier, per D8) with Zod-validated structured
output schema → { education[], work_experiences[] (with bullets[]),
skills[], projects[], certifications[], achievements[] }
  │
  ├─ Zod validation fails → retry once → still fails →
  │     extraction_status='failed', extraction_error set,
  │     API returns 200 with a "manual entry required" signal
  │     (not a 500 — this is an expected, handled outcome)
  │
  ▼ (success)
extraction_status='extracted'
Response: { resumeDocumentId, draft: <extracted structured data> }
  (nothing written to candidate_profiles/education/etc. yet)
```

```
User reviews `draft` in the UI, edits any field freely
  │
  ▼
POST /api/profile/confirm  { profile: <edited draft> }
  │
  ▼
Transaction (withUserContext):
  1. Upsert candidate_profiles scalar/preference fields
  2. Replace education / work_experiences+bullets / skills / projects /
     certifications / achievements rows with the confirmed set
  3. For each atomic item (education entries, work-experience bullets,
     skills, projects, certifications, achievements), compute
     content_hash(fact_text):
       - unchanged hash vs. existing profile_facts row → skip (D8 cache)
       - new/changed → upsert profile_facts row, call Voyage to embed,
         store embedding + embedding_model
  4. Delete profile_facts rows whose source item no longer exists
  │
  ▼
Response: full persisted profile
```

Manual-entry fallback (extraction failed, or user chooses to skip AI extraction): the same `POST /api/profile/confirm` endpoint accepts a profile object built entirely by hand via the UI forms — there is no separate "manual" endpoint, since confirm's contract is already "persist whatever structured profile the user has approved," regardless of how the draft was produced.

## 4. API surface

| Route | Method | Purpose |
|---|---|---|
| `/api/profile/resume` | POST | Upload resume, extract draft (D15, D17) |
| `/api/profile/resume` | DELETE | Remove the active resume file (profile data untouched) |
| `/api/profile/confirm` | POST | Persist confirmed/edited profile + derive & embed facts (D16) |
| `/api/profile` | GET | Fetch the full current profile |
| `/api/profile` | PATCH | Edit an already-confirmed profile; re-derives/re-embeds only changed facts |

All routes operate under `withUserContext(db, env.DEFAULT_USER_ID, ...)` — no auth/session logic, per D1/D2.

## 5. UI flow (`apps/web`)

- `/profile` — if no active resume and no confirmed profile: upload dropzone (drag/drop or file picker), accepts `.pdf`/`.docx`/`.tex`.
- On upload: loading state while the synchronous extraction call runs (D17 — no polling needed, but the UI must show a spinner/progress state since this can take a few seconds).
- Extraction result → review screen: editable form sections pre-filled from the draft (or blank if extraction failed, with a visible notice) — every field editable, nothing saved yet.
- "Confirm & Save" button → calls `/api/profile/confirm` → on success, navigate to a read view of the saved profile with per-section "Edit" actions that route back into the same form components (`PATCH`).

## 6. Security & privacy

- File type verified by content sniffing (magic bytes), never trusted from `Content-Type` header or extension alone.
- 10MB max upload size.
- Original filename discarded from the storage path; MinIO object key is UUID-derived.
- No resume text, extracted fields, or profile PII appear in application logs at any log level — this phase extends the D9 exact-match redaction list with `full_name`, `email`, `phone_number`, `linkedin_url`, `address_line1` as soon as they're saved to `candidate_profiles`.
- Extraction errors logged with a request id and error class only, never the extracted content or raw resume text.

## 7. Error handling

- Unsupported file type / oversized file → `400` before any storage or extraction work happens.
- Extraction (Anthropic call or Zod validation) failure → handled outcome, not a server error: `resume_documents.extraction_status='failed'`, response still `200` with a flag the UI uses to route into blank manual-entry forms instead of a pre-filled review screen.
- MinIO storage failure → `502`, no `resume_documents` row is created (fail before insert, or wrap in a transaction that rolls back the row if the upload itself throws).
- Voyage embedding failure during confirm → the profile data (step 1–2 of the confirm transaction) still commits; affected `profile_facts` rows are left without an embedding and flagged for a retry (exact retry mechanism — e.g. a manual "retry embeddings" action vs. background retry — is an implementation-time decision, not a design-blocking one, since it doesn't affect the schema or API contract above).

## 8. Testing strategy

- **Unit:** each text extractor (`pdf-parse`/`mammoth`/UTF-8 read) against fixture files; the Zod extraction-output schema (valid input, missing fields, malformed nested arrays); `content_hash` cache-skip logic; the fact-derivation function (confirmed profile → expected `profile_facts` rows).
- **Integration:** `POST /api/profile/resume` and `/api/profile/confirm` against a real test database (RLS isolation verified the same way `packages/db/src/rls.test.ts` does), with Anthropic and Voyage clients mocked (same pattern as the Task 6 `ioredis` mock in Phase 0/1).
- **AI evaluation** (CLAUDE.md §10): a small fixture set of 5–10 sample resumes (varied formats, lengths, and structure — including at least one `.tex` source) with hand-verified expected extraction output, committed under a test-eval directory, scored for field-level extraction accuracy. This is a lightweight fixture-based check, not a full eval harness — proportionate to this phase's scope.

## 9. Open items deferred to implementation time (not design-blocking)

- Exact embedding-retry mechanism on Voyage failure (§7).
- Exact Zod schema shape for the extraction draft (field-by-field) — will be nailed down during TDD in the implementation plan, following the same pattern as `packages/config/src/env.ts`'s schema-first approach.
- Whether `PATCH /api/profile` accepts partial section updates or requires the full profile object — an implementation-level API ergonomics choice, not an architectural one.
