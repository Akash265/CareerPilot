# Phase 13c — Job-Specific LaTeX Resume — Design

Status: implemented on branch phase-13c-latex-resume (not yet merged).
Part of Phase 13 (user's 2026-10-19 refinement request), split by user choice into
13a one-click discovery (merged) → 13b missing-skill verification (merged) → 13c job-specific LaTeX resume
(this spec).
Related decisions: D6 (never invent), D9 (log hygiene), D20 (untrusted text), D63 (guard is the only authority on
applied bullets), D81–D88 (generated documents, export pipeline), D93 (`kind::text` CHECK pattern), D95
(boundary-aware `containsTerm`), D125 (service Dockerfile pattern), D200–D205 (verified skills). New decisions
are numbered from **D207**.

## 1. Problem

The resume export (Phase 7b, D82) renders **every** profile bullet, with the optimizer's guard-applied
rewordings first. It is reordered, not tailored: long, not one page, and typeset by pdfkit. The user wants a
job-specific, ATS-oriented resume typeset with LaTeX, available both as a PDF and as editable `.tex` source.
No TeX engine is installed locally (no pdflatex/xelatex/lualatex/tectonic); Docker is available.

## 2. Decisions taken in brainstorming

| # | Decision | Alternative rejected |
|---|---|---|
| 1 | Output both a compiled PDF and the `.tex` source | PDF only; `.tex` only |
| 2 | Deterministic tailored one-page selection; no new LLM call | + LLM-written grounded summary; full profile in LaTeX |
| 3 | Added **alongside** the existing full-profile resume export (PDF + DOCX unchanged) | Replace resume PDF; replace both |
| 4 | One bundled single-column ATS-safe template (Jake's-Resume style) | Bring-your-own template; 2–3 templates |
| 5 | Compile in a sandboxed `latex-compiler` sidecar container, synchronous HTTP from the export route | Tectonic on host; BullMQ compile worker |
| 6 | pdflatex; characters outside a Latin whitelist refuse with 422 | LuaLaTeX + Noto Sans (full Unicode, bigger/slower) |
| 7 | All roles kept (≥ 1 bullet; 2 most recent ≥ 2); a still-overflowing resume exports flagged "2 pages" | Drop old roles; fail the export |
| 8 | Browser autofill attaches the newest tailored PDF when one exists, else the full-profile PDF | Autofill unchanged |

## 3. Content selection (`packages/document-export/src/model/selectTailoredResume.ts`, pure)

`selectTailoredResume(profile: ResumeProfile, applied: AppliedBullet[], requirements: RequirementTerm[],
budget: LineBudget) → { model: DocumentModel; included: ItemRef[]; omitted: OmittedItem[] }`

- Requires an existing `resume_optimizations` row for the job (its `selectedBullets` are `applied`).
  `rejectedClaims` are never read. An applied bullet citing an unknown fact throws (as D82).
- **Rankable items:** work-experience bullets, projects, achievements.
- **Ranking:** optimizer-selected items first, in the optimizer's order, with their `optimizedText`
  (blank → original text, as D87). The rest scored by requirement terms they contain — `required` = 2,
  `preferred` = 1 — matched with the boundary-aware `containsTerm` (D95) on lower-cased text; ties by profile
  order.
- **Display order** stays the resume's natural order: roles in profile order; within a role, selected bullets
  first in optimizer order, then the rest by score; projects/achievements likewise.
- **Fitting:** remove the lowest-ranked removable item until `estimateLines(model) ≤ budget.lines`.
  Removal priority: zero-score projects/achievements first, then all rankable items by ascending rank.
  **Floors** (never removed): every role header; ≥ 1 bullet per role; ≥ 2 bullets for the two most recent
  roles (profile order) when they have them; education and certifications verbatim (never reworded, never
  dropped); the Skills section.
- **Skills line:** profile skills and 13b verified skills whose `normalizeTermKey` matches a requirement term
  first (requirement order), then the rest in profile order; verified terms that normalize to a listed skill
  are not repeated (as D204); capped to the budget's skills-line allowance (≈ 2 lines). Names never reworded.
- **Never included:** a summary or any generated text, street address (D82), `rejectedClaims`.
- **Omitted items** carry a reason: `no_requirement_match` (score 0, removed) or `page_limit` (score > 0,
  removed for space).

## 4. TeX generation (`packages/document-export/src/render/tex/`)

- Input is the existing format-neutral `DocumentModel`, so `normalizeModel`, `assertSafeModel` and the content
  hash apply unchanged. `renderTex(model, { paperSize }) → string`.
- **`escapeTex`** is the only path from model text into the template: `\` → `\textbackslash{}`, `{ } $ & # _ %`
  → backslash-escaped, `^` → `\textasciicircum{}`, `~` → `\textasciitilde{}`; newlines and control characters
  stripped; explicit mappings for en/em dash, curly quotes, `•`, `…`, `€`, `£`. URLs are rendered as escaped
  plain text (no `\url`/`\href`).
- **Character whitelist:** printable ASCII, Latin-1 Supplement, Latin Extended-A, plus the mapped
  typographic characters. Any other character → `DocumentExportError("unsupported_character")` with a field
  path such as `experience[2].bullets[3]` (no text echoed).
- **Template** (`resumeTemplate.ts`, `TEX_TEMPLATE_VERSION`): `article`, 10.5pt-ish, `geometry` margins,
  `titlesec`, `enumitem`, `inputenc utf8`, `fontenc T1`, `lmodern`, `glyphtounicode` + `\pdfgentounicode=1`,
  `hyperref` for PDF title/author metadata only. Single column; no tables, icons, graphics or multi-column
  layout. Section names: Experience, Projects, Achievements, Education, Certifications, Skills.
  Header: name + contact line (email · phone · LinkedIn).
- **Paper size:** `RESUME_PAPER_SIZE=a4|letter`, default `a4` (optional in the `@ai-career/config` schema).
- **`estimateLines(model, paperSize)`:** fixed per-block line costs and an average characters-per-line for the
  template's font and text width; calibrated against real compiles (§8).

## 5. The `latex-compiler` sidecar (`services/latex-compiler`)

- Node `node:http` server (no framework), `@ai-career/logging`; Dockerfile per D125 plus Debian packages
  `texlive-latex-base texlive-latex-recommended texlive-fonts-recommended texlive-latex-extra poppler-utils`.
- `infra/docker-compose.yml`: service `latex-compiler`, profile `latex`, published on `127.0.0.1:8090` only;
  `read_only: true`, tmpfs `/tmp`, `user` non-root, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`,
  `mem_limit: 512m`, `cpus: 1`, `pids_limit: 64`; attached to a compose network with `internal: true` (no
  egress). The plan must verify host access to the published port still works on the internal network and
  that egress from the container fails.
- **API**
  - `POST /compile` — `Authorization: Bearer $LATEX_COMPILER_TOKEN`; body = `.tex` UTF-8, ≤ 256 KB.
    `200 application/pdf` + `X-Page-Count`, `X-Tex-Version`. Errors (JSON `{code}`): `401 unauthorized`,
    `413 too_large`, `422 compile_failed` (+ `line` if parseable; **never** log text — it echoes content),
    `503 busy`, `504 timeout`.
  - `GET /health` → `{ ok: true, texVersion }`.
  - `POST /extract` (PDF → text via `pdftotext -layout`) exists only when `LATEX_COMPILER_TEST_MODE=1`; used
    by integration tests.
- **Compile:** per-request `mkdtemp` (removed in `finally`); `pdflatex -no-shell-escape -halt-on-error
  -interaction=nonstopmode` with env `openin_any=p`, `openout_any=p`, `TEXMFOUTPUT=<tmpdir>`; one pass; 20 s
  wall clock then SIGKILL of the process group; concurrency 2, wait queue 4 (else 503). Page count from the
  pdflatex output line `Output written on … (N page`. pdflatex is behind an injectable runner for unit tests.
- **Logs:** request id, byte size, duration, page count, exit status. Never `.tex` or log contents.

**Web side:** `packages/document-export/src/render/compileTex.ts` — `interface TexCompiler { compile(tex):
Promise<{ pdf: Buffer; pageCount: number; texVersion: string }> }` and `createHttpTexCompiler(url, token)`
mapping service errors to `DocumentExportError` codes. `LATEX_COMPILER_URL`, `LATEX_COMPILER_TOKEN` optional in
the env schema; unset → compiler is `null`.

## 6. Data, pipeline, API, UI

**Migration `0038`** (D93 pattern): `ALTER TYPE generated_document_kind ADD VALUE 'tailored_resume'`;
`ALTER TYPE generated_document_format ADD VALUE 'tex'`; source CHECK rewritten via `kind::text` so
`tailored_resume` uses `resume_optimization_id` like `resume`; new nullable `details jsonb` on
`generated_documents` (CHECK: object or null), set only for `tailored_resume`:

```
{ pageCount: number | null, pageVerified: boolean, includedCount: number, totalCount: number,
  omitted: [{ sourceType, sourceFactId, reason: "no_requirement_match" | "page_limit" }] }
```

Ids and reasons only — no resume text. The UI resolves text from the current profile (unchanged, by the
D84 hash check). Dedup by the existing `(user_id, job_id, kind, format, content_hash)` index.
Content hash = sha256(format, `TEX_TEMPLATE_VERSION`, paper size, normalized fitted model; for PDF also the
compiler's `texVersion`).

**Pipeline** `exportTailoredResume(db, storage, compiler | null, { userId, jobId, optimizationId, format:
"pdf" | "tex" })`:

1. `format === "pdf" && compiler === null` → `compiler_unavailable`.
2. D84 checks: job 404, `source_mismatch` 400, `profile_changed` 409, `no_profile` 409.
3. Load `job_requirements` for the job; `selectTailoredResume` with the estimate budget; `assertSafeModel`;
   character whitelist.
4. `fitToPage`: with a compiler, compile; while `pageCount > 1` and fewer than 3 trims, remove the next
   removable item and recompile. Without a compiler (`.tex` only), estimate only, `pageVerified: false`.
   Both formats use this same step, so with the compiler running `.tex` and PDF content are identical.
5. `storeDocument` (hash reuse, upload outside the transaction, `ON CONFLICT DO NOTHING`) with `details`.
   For PDF the buffer is the last compile's output.

**API:** `POST /api/documents` body: `kind` gains `tailored_resume`, `format` gains `tex`; `tex` only valid
with `tailored_resume` and `tailored_resume` only with `pdf | tex` (else 400). `exportErrors.ts` gains
`compiler_unavailable` 503 (message includes `docker compose --profile latex up -d latex-compiler`),
`compiler_busy` 503, `compiler_timeout` 504, `compile_failed` 502, `unsupported_character` 422 (+ field path).
Download route: `tex` → `application/x-tex`; filename `"<Name> - <Company> - Resume.tex"`. Document views
include `details`.

**UI** (`/matches/[jobId]`, Resume Optimization panel): new row "Tailored resume (LaTeX, 1 page)" with **PDF**
and **.tex** buttons; after export: "Included N of M items · 1 page" (or "· 2 pages — couldn't fit to one" /
"· page count not verified") and a collapsible "Left out" list (item text + reason). Existing resume buttons
unchanged.

**Autofill:** `packages/browser/src/sessions/readSessions.ts` attaches the newest `tailored_resume` PDF for the
job if one exists, else the newest `resume` PDF (current behavior).

## 7. Error handling

| Situation | Result |
|---|---|
| No profile / profile changed / wrong source | 409 / 409 / 400 (as D84) |
| Unsupported character | 422 `unsupported_character` + field path |
| Compiler unset or unreachable (PDF) | 503 `compiler_unavailable` + start command; `.tex` still works |
| Compiler busy / timeout | 503 `compiler_busy` / 504 `compiler_timeout` |
| TeX compile error (template/escaping bug) | 502 `compile_failed`; only line number logged |
| > 1 page after 3 trims | 200, `pageCount: 2`, flagged in UI |
| Storage down | `storage_unavailable` (as today) |

## 8. Testing

- **Unit (document-export):** `escapeTex` table over every special character + randomized strings asserting no
  unescaped control sequence; whitelist boundaries; `selectTailoredResume` ranking, display order, floors,
  removal priority, skills ordering/dedupe/cap, omitted reasons, unknown-fact throw; `estimateLines`;
  `renderTex` golden snapshot; `fitToPage` with a fake compiler (fits first time, 1–3 trims, gives up at 2
  pages, no compiler); `exportTailoredResume` error paths and hash reuse.
- **Unit (latex-compiler):** auth, size limit, queue/busy, timeout kill, temp-dir cleanup, page-count parsing,
  no log text in any response, `/extract` absent outside test mode — with a fake pdflatex runner.
- **Web:** body validation for the new kind/format pairs, error-code mapping, `.tex` download content type,
  panel rendering of `details`, autofill preference.
- **Real-compile integration** (opt-in locally via `LATEX_COMPILER_URL`; required in CI, which builds the image
  and runs it as a service with test mode): compile a fixture profile; `/extract` text; assert reading order,
  section names, `ü`, `–`, `C++`, `C#`, `.NET` extracted correctly, 1 page; an injection fixture (bullet
  containing `\input{/etc/passwd}`, `\write18{id}`, `\catcode`) appears **literally** in the extracted text;
  `estimateLines` calibration (estimate within tolerance of real page fill).
- **E2E:** export the tailored resume for a seeded job and download both files; skipped with a clear message
  when the compiler is not running.

## 9. Documentation

DECISIONS.md from D207; FLOW.md §22 (export → select → fit → compile → store; autofill attachment choice);
`docs/development.md` (starting the compiler, env vars), `docs/architecture.md` (sidecar), `docs/api.md`
(kind, format, errors), `.env.example` (`LATEX_COMPILER_URL`, `LATEX_COMPILER_TOKEN`, `RESUME_PAPER_SIZE`).

## 10. Out of scope

LLM-written summary; multiple or user-supplied templates; LuaLaTeX / full Unicode; DOCX for the tailored
resume; manual include/exclude of items (possible follow-up); retention changes (generated documents already
follow the existing retention sweep).
