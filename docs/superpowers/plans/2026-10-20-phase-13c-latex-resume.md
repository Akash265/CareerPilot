# Phase 13c — Job-Specific LaTeX Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a deterministic, job-tailored, one-page resume typeset by pdflatex in a sandboxed sidecar, as a PDF and as `.tex` source, alongside the existing full-profile export.

**Architecture:** `packages/document-export` gains a pure selection step (`selectTailoredResume` + `estimateLines`), a TeX renderer with a single escaping function (`escapeTex`), an HTTP `TexCompiler` client, a compile-and-trim loop (`fitToPage`) and the `exportTailoredResume` pipeline that stores through the existing `storeDocument`. A new `services/latex-compiler` (plain `node:http` + pdflatex, its own Docker image, compose profile `latex`) compiles `.tex` to PDF. The web API/UI and browser autofill gain the new `tailored_resume` kind and `tex` format.

**Tech Stack:** TypeScript (ESM, tsx), Drizzle + Postgres (RLS), MinIO, Next.js App Router, vitest, Debian TeX Live (pdflatex, lmodern, titlesec, enumitem, hyperref) + poppler-utils, Docker Compose, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-20-phase-13c-latex-resume-design.md`

## Global Constraints

- No LLM call anywhere in this phase; selection is deterministic (spec §2 #2).
- Never invent text: rendered text is the optimizer's guard-applied `optimizedText` (blank → original, D87) or the profile's own text; records (education, certifications, skill names) are never reworded; `rejectedClaims` never read; no street address (D82).
- Every string from the model reaches TeX only through `escapeTex` (spec §4).
- Allowed characters: printable ASCII, Latin-1 Supplement, Latin Extended-A (minus the explicit exclusions in Task 2), plus the mapped typographic characters; anything else → 422 `unsupported_character` with a location, never the offending text.
- Never log `.tex` contents, pdflatex log text, or resume text (CLAUDE.md §9, D9). The compiler returns only `{code, line?}` on failure.
- Compiler: `pdflatex -no-shell-escape -halt-on-error -interaction=nonstopmode`, env `openin_any=p`, `openout_any=p`, `TEXMFOUTPUT=<tmpdir>`, one pass, 20 s kill, concurrency 2, queue 4, body ≤ 256 KB, bearer token ≥ 32 chars.
- Fit loop: at most 3 extra compiles (`MAX_EXTRA_TRIMS = 3`); still > 1 page → export succeeds with `pageCount: 2`.
- Floors: every role header kept; ≥ 1 bullet per role; ≥ 2 bullets for the first two roles in profile order (when they have them); education/certifications/skills always kept.
- Paper size: `RESUME_PAPER_SIZE=a4|letter`, default `a4`.
- Test users for this phase: `00000000-0000-0000-0000-000000000d20` … `…0d2f` (13b used up to `…0d18`).
- Migration tag: next drizzle number `0038`; enum values used in CHECKs are compared as `kind::text` / `format::text` (D93).
- Commits: small, one per task (or per step where shown), message trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.

## Plan refinements vs. the spec (decided while planning; recorded in DECISIONS in Task 12)

- **R1 — network.** Docker does not publish ports for containers attached only to an `internal: true` network, so the host-run web app could not reach the compiler. The compiler runs on the default compose network, published on `127.0.0.1:8090` only. Egress is not blocked; accepted because pdflatex without shell-escape has no network primitive and the Node server makes no outbound calls. All other hardening stays.
- **R2 — E2E.** The smoke suite has no profile/optimization flow to build on. Instead: web route tests run against the real DB + MinIO with a local fake HTTP compiler (Task 9), and CI runs the real-compile integration test against the built image (Task 8).
- **R3 — "Left out" text.** `exportTailoredResume` already holds the profile, so it returns the omitted items' text with the row; the POST response carries it. `DocumentsList` shows only the stored counts/page summary.
- **R4 — hash covers details.** The tailored content hash includes `details`, so a `.tex` fitted without the compiler is never reused in place of a page-verified one.
- **R5 — `.tex` fallback.** A `.tex` export whose configured compiler is unreachable/busy/timed out falls back to the estimate (`pageVerified: false`) instead of failing. `compile_failed` still fails.
- **R6 — location text.** `unsupported_character` locations are derived from the model: `"Experience, entry 2, bullet 3"`, `"Skills"`, `"Name"`, `"Contact details"`.

## Review Focus

1. **Text that looks like TeX syntax** (`\input{/etc/passwd}`, `\write18{id}`, `\catcode`, `{`, `%`, `$`, a bullet starting with `[Remote]`, `--`, `''`, `,,`, `<<`) must appear literally in the PDF text — pinned by escapeTex unit tests (Task 2) and the injection fixture in the real-compile test (Task 8).
2. **A profile with a non-Latin character** (emoji, CJK, `Ħ`) must give a 422 naming where it is, not a 502 compile failure — pinned in Task 2 (location) and Task 6 (pipeline error) and Task 9 (HTTP 422 message).
3. **Every whitelisted character must actually compile** (a whitelist entry pdflatex can't typeset turns a 422 into a 502) — pinned by the "all whitelisted characters" compile in Task 8.
4. **Compiler down while exporting `.tex`** must still produce a file; **compiler down for PDF** must be a 503 with the start command — pinned in Task 6 and Task 9.
5. **A profile with very few items** (one role, one bullet, no projects) must not be trimmed below floors or loop forever — pinned by the floor/exhausted tests in Task 4 and the fit loop test in Task 5.

---

## File Structure

**packages/document-export/src**
- `model/types.ts` (modify) — `DocumentKind` += `tailored_resume`; `StoredDocumentFormat`; `PaperSize`; `RankableSourceType`; `OmittedItem`; `TailoredResumeDetails`; `TEX_TEMPLATE_VERSION`.
- `errors.ts` (modify) — new error classes + `detail`.
- `model/filename.ts` (modify) — label + `tex` extension.
- `model/hash.ts` (modify) — `tailoredContentHash`.
- `model/resumeSections.ts` (create) — education/certification blocks + `joinPresent`, shared by both resume builders.
- `model/buildResumeModel.ts` (modify) — use `resumeSections.ts`.
- `model/estimateLines.ts` (create) — line metrics and estimate.
- `model/selectTailoredResume.ts` (create) — ranking, floors, fitting by estimate, skills line, omitted list.
- `render/tex/escapeTex.ts` (create) — escaping, whitelist, `findUnsupportedCharacter`.
- `render/tex/renderTex.ts` (create) — the template.
- `render/compileTex.ts` (create) — `TexCompiler`, `createHttpTexCompiler`.
- `pipeline/fitToPage.ts` (create) — compile-and-trim loop.
- `pipeline/loadResumeExportContext.ts` (create) — D84 checks shared by both resume exports.
- `pipeline/exportResume.ts` (modify) — use the shared context loader.
- `pipeline/storeDocument.ts` (modify) — `prerendered`, `details`, `tex` format.
- `pipeline/exportTailoredResume.ts` (create) — the pipeline.
- `latex.integration.test.ts` (create) — real-compile test, skipped unless `LATEX_COMPILER_URL` is set.
- `index.ts` (modify) — exports.

**packages/db** — `src/schema/generatedDocuments.ts` (modify), `migrations/0038_*.sql` (generated), `src/generatedDocumentsTable.rls.test.ts` (modify).
**packages/storage** — `src/generatedDocumentStorage.ts` (modify: `tex` extension).
**packages/config** — `src/env.ts`, `src/env.test.ts` (modify).
**services/latex-compiler** (create) — `package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`, `Dockerfile`, `src/{config,parseOutput,limiter,compile,runPdflatex,extract,texVersion,server,main}.ts` + tests.
**infra/docker-compose.yml**, **.github/workflows/ci.yml**, **.env.example** (modify).
**apps/web/src** — `lib/documents/{exportErrors,serializeDocument,texCompiler}.ts`, `app/api/documents/route.ts`, `app/api/documents/[id]/download/route.ts`, `app/matches/[jobId]/{DownloadButtons,TailoredResumeExport,ResumeOptimizationPanel,DocumentsList}.tsx` + tests.
**packages/browser/src/sessions** — `loadAutofillContext.ts`, `readSessions.ts`, `sessions.test.ts`; `src/testing/db.ts`.
**Docs** — `DECISIONS.md`, `FLOW.md`, `docs/{development,architecture,api}.md`, `README.md`.

---

### Task 1: Data layer — kind, format, details column, storage extension

**Files:**
- Modify: `packages/document-export/src/model/types.ts`
- Modify: `packages/document-export/src/errors.ts`
- Modify: `packages/document-export/src/model/filename.ts`, `packages/document-export/src/model/filename.test.ts`
- Modify: `packages/db/src/schema/generatedDocuments.ts`
- Create (generated): `packages/db/migrations/0038_<drizzle-name>.sql`
- Modify: `packages/db/src/generatedDocumentsTable.rls.test.ts`
- Modify: `packages/storage/src/generatedDocumentStorage.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  export type DocumentFormat = "pdf" | "docx";               // unchanged: what renderDocument renders
  export type StoredDocumentFormat = DocumentFormat | "tex";
  export type DocumentKind = "resume" | "pitch" | "cover_letter" | "interview_prep" | "tailored_resume";
  export type PaperSize = "a4" | "letter";
  export type RankableSourceType = "work_experience_bullet" | "project" | "achievement";
  export interface OmittedItem { sourceType: RankableSourceType; sourceFactId: string; reason: "no_requirement_match" | "page_limit" }
  export interface TailoredResumeDetails { pageCount: number | null; pageVerified: boolean; includedCount: number; totalCount: number; omitted: OmittedItem[] }
  export const TEX_TEMPLATE_VERSION = "1";
  ```
- Produces (errors.ts): `DocumentExportErrorClass` += `"compiler_unavailable" | "compiler_busy" | "compiler_timeout" | "compile_failed" | "unsupported_character"`; `new DocumentExportError(cls, { cause?, detail? })`, readonly `detail: string | undefined`.
- Produces (filename.ts): `buildDownloadFilename(fullName, companyName, kind: DocumentKind, format: StoredDocumentFormat)`; `sanitizeFilename(base, extension: StoredDocumentFormat)`.
- Produces (db): `generated_documents.details jsonb NULL`; enum values `tailored_resume`, `tex`.
- Produces (storage): `uploadGeneratedDocument(client, { userId, buffer, extension: "pdf" | "docx" | "tex" })`.

- [ ] **Step 1: Extend types and errors**

In `packages/document-export/src/model/types.ts` replace the two type lines and add the new types after `RENDERER_VERSION`:

```ts
export type DocumentFormat = "pdf" | "docx";
/** What a stored generated_documents row can be: the two rendered formats plus LaTeX source (Phase 13c). */
export type StoredDocumentFormat = DocumentFormat | "tex";
export type DocumentKind = "resume" | "pitch" | "cover_letter" | "interview_prep" | "tailored_resume";

/** Bump whenever either renderer's output for the same model changes (it is part of the content hash). */
export const RENDERER_VERSION = "1";

/** Phase 13c. Bump whenever renderTex's output for the same model changes (part of the tailored content hash). */
export const TEX_TEMPLATE_VERSION = "1";

export type PaperSize = "a4" | "letter";

/** The items a tailored resume may leave out; everything else is always kept. */
export type RankableSourceType = "work_experience_bullet" | "project" | "achievement";

export interface OmittedItem {
  sourceType: RankableSourceType;
  sourceFactId: string;
  reason: "no_requirement_match" | "page_limit";
}

/** Stored in generated_documents.details for kind tailored_resume (ids and reasons only, no resume text). */
export interface TailoredResumeDetails {
  pageCount: number | null;
  pageVerified: boolean;
  includedCount: number;
  totalCount: number;
  omitted: OmittedItem[];
}
```

Replace `packages/document-export/src/errors.ts` with:

```ts
export type DocumentExportErrorClass =
  | "job_not_found"
  | "source_mismatch"
  | "profile_changed"
  | "pitch_unsupported"
  | "cover_letter_unsupported"
  | "no_profile"
  | "invalid_content"
  | "storage_unavailable"
  | "compiler_unavailable"
  | "compiler_busy"
  | "compiler_timeout"
  | "compile_failed"
  | "unsupported_character";

export class DocumentExportError extends Error {
  readonly errorClass: DocumentExportErrorClass;
  /** Safe-to-show context, e.g. "Experience, entry 2, bullet 3" -- never resume text. */
  readonly detail: string | undefined;
  constructor(errorClass: DocumentExportErrorClass, options?: { cause?: unknown; detail?: string }) {
    super(errorClass, options);
    this.name = "DocumentExportError";
    this.errorClass = errorClass;
    this.detail = options?.detail;
  }
}
```

- [ ] **Step 2: Write the failing filename test**

Append to `packages/document-export/src/model/filename.test.ts` (inside the existing top-level `describe` for `buildDownloadFilename`, or a new one):

```ts
describe("buildDownloadFilename for tailored resumes", () => {
  it("labels a tailored resume as Resume and supports the tex extension", () => {
    expect(buildDownloadFilename("Jane Doe", "GitLab", "tailored_resume", "tex")).toBe("Jane Doe - GitLab - Resume.tex");
    expect(buildDownloadFilename("Jane Doe", "GitLab", "tailored_resume", "pdf")).toBe("Jane Doe - GitLab - Resume.pdf");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/model/filename.test.ts`
Expected: FAIL (typecheck in vitest passes through, but `KIND_LABELS.tailored_resume` is undefined → `"Jane Doe - GitLab - undefined.tex"`).

- [ ] **Step 4: Implement filename changes**

In `packages/document-export/src/model/filename.ts`: import `StoredDocumentFormat` instead of `DocumentFormat`; change both signatures' extension/format parameter type to `StoredDocumentFormat`; add `tailored_resume: "Resume",` to `KIND_LABELS`.

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/model/filename.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing DB constraint tests**

Append to `packages/db/src/generatedDocumentsTable.rls.test.ts` inside its top-level `describe`. Also extend `insertDoc` to accept `resumeOptimizationId` and `details`:

```ts
function insertDoc(jobId: string, overrides: Record<string, unknown> = {}) {
  const v = { kind: "resume", format: "pdf", byteSize: 10, contentHash: "h1", resumeOptimizationId: null, details: null, ...overrides };
  return adminSql`
    INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename,
                                     resume_optimization_id, details)
    VALUES (${USER_A}, ${jobId}, ${v.kind as string}, ${v.format as string}, 'k', ${v.byteSize as number}, ${v.contentHash as string}, '1', 'f.pdf',
            ${v.resumeOptimizationId as string | null}, ${v.details === null ? null : adminSql.json(v.details as object)})
    RETURNING id`;
}
```

```ts
  it("accepts a tailored_resume pdf/tex row with details; rejects tex for other kinds and details on other kinds", async () => {
    const jobId = await seedJob();
    const details = { pageCount: 1, pageVerified: true, includedCount: 3, totalCount: 4, omitted: [] };
    await expect(insertDoc(jobId, { kind: "tailored_resume", format: "tex", contentHash: "t1", details })).resolves.toHaveLength(1);
    await expect(insertDoc(jobId, { kind: "tailored_resume", format: "pdf", contentHash: "t2", details })).resolves.toHaveLength(1);
    await expect(insertDoc(jobId, { kind: "resume", format: "tex", contentHash: "t3" })).rejects.toThrow(/generated_documents_tex_only_tailored/);
    await expect(insertDoc(jobId, { kind: "resume", format: "pdf", contentHash: "t4", details })).rejects.toThrow(/generated_documents_details_tailored_object/);
    await expect(insertDoc(jobId, { kind: "tailored_resume", format: "pdf", contentHash: "t5", details: [1] })).rejects.toThrow(/generated_documents_details_tailored_object/);
  });

  it("lets a tailored_resume row point at a resume optimization but not a pitch", async () => {
    const jobId = await seedJob();
    const [goal] = await adminSql`INSERT INTO career_goals (user_id, raw_text, version, parse_status, confirmation_status, is_active)
                                  VALUES (${USER_A}, 'g', 1, 'parsed', 'confirmed', false) RETURNING id`;
    const [opt] = await adminSql`
      INSERT INTO resume_optimizations (user_id, job_id, career_goal_id, version, source_profile_content_hash, selected_bullets,
                                        added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model)
      VALUES (${USER_A}, ${jobId}, ${goal.id}, 1, 'h', '[]'::jsonb, '{}', '{}', false, '[]'::jsonb, 'm') RETURNING id`;
    await expect(insertDoc(jobId, { kind: "tailored_resume", format: "pdf", contentHash: "t6", resumeOptimizationId: opt.id })).resolves.toHaveLength(1);
    await adminSql`DELETE FROM career_goals WHERE id = ${goal.id}`.catch(() => {});
  });
```

If `career_goals` rows for `USER_A` are not removed by `wipe()`, add `await adminSql\`DELETE FROM career_goals WHERE user_id IN (${USER_A}, ${USER_B})\`` to `wipe()` after the jobs delete (resume_optimizations cascade from jobs).

- [ ] **Step 7: Run to verify they fail**

Run: `pnpm --filter @ai-career/db exec vitest run src/generatedDocumentsTable.rls.test.ts`
Expected: FAIL (`invalid input value for enum generated_document_kind: "tailored_resume"` / column `details` does not exist).

- [ ] **Step 8: Update the Drizzle schema**

In `packages/db/src/schema/generatedDocuments.ts`:
- add `jsonb` to the `drizzle-orm/pg-core` import;
- enums:
  ```ts
  export const generatedDocumentKindEnum = pgEnum("generated_document_kind", ["resume", "pitch", "cover_letter", "interview_prep", "tailored_resume"]);
  export const generatedDocumentFormatEnum = pgEnum("generated_document_format", ["pdf", "docx", "tex"]);
  ```
- column after `downloadFilename`:
  ```ts
    /** Phase 13c: tailored_resume only -- page count, counts, omitted item ids + reasons (no resume text). */
    details: jsonb("details").$type<{
      pageCount: number | null;
      pageVerified: boolean;
      includedCount: number;
      totalCount: number;
      omitted: { sourceType: "work_experience_bullet" | "project" | "achievement"; sourceFactId: string; reason: "no_requirement_match" | "page_limit" }[];
    }>(),
  ```
- replace `sourceMatchesKind` and add two checks:
  ```ts
    sourceMatchesKind: check(
      "generated_documents_source_matches_kind",
      sql`(${t.resumeOptimizationId} IS NULL OR ${t.kind}::text IN ('resume', 'tailored_resume'))
        AND (${t.applicationPitchId} IS NULL OR ${t.kind}::text = 'pitch')
        AND (${t.coverLetterId} IS NULL OR ${t.kind}::text = 'cover_letter')
        AND (${t.interviewPreparationId} IS NULL OR ${t.kind}::text = 'interview_prep')`
    ),
    // Phase 13c: LaTeX source exists only for the tailored resume; details only on tailored rows, always an object.
    texOnlyTailored: check("generated_documents_tex_only_tailored", sql`${t.format}::text <> 'tex' OR ${t.kind}::text = 'tailored_resume'`),
    detailsTailoredObject: check(
      "generated_documents_details_tailored_object",
      sql`${t.details} IS NULL OR (${t.kind}::text = 'tailored_resume' AND jsonb_typeof(${t.details}) = 'object')`
    ),
  ```
- update the doc comment: mention `tailored_resume` uses `resumeOptimizationId`, and that its content hash is `tailoredContentHash` (Phase 13c).

- [ ] **Step 9: Generate and inspect the migration**

Run: `pnpm --filter @ai-career/db db:generate`
Expected: a new `packages/db/migrations/0038_<name>.sql` containing, in this order: `ALTER TYPE "public"."generated_document_format" ADD VALUE 'tex';`, `ALTER TYPE "public"."generated_document_kind" ADD VALUE 'tailored_resume';`, `DROP CONSTRAINT "generated_documents_source_matches_kind"`, `ADD COLUMN "details" jsonb`, then the three `ADD CONSTRAINT ... CHECK` statements. Confirm every CHECK uses `::text` comparisons (no bare enum literal) — that is what lets the one-transaction migrator apply it (D93). If drizzle-kit asks interactive questions it should not (no renames here); if it does, answer "create".

- [ ] **Step 10: Migrate the dev DB and run the DB tests**

Run: `pnpm --filter @ai-career/db db:migrate && pnpm --filter @ai-career/db exec vitest run src/generatedDocumentsTable.rls.test.ts`
Expected: PASS (all old and new tests).

- [ ] **Step 11: Storage extension type**

In `packages/storage/src/generatedDocumentStorage.ts` change the parameter type to `extension: "pdf" | "docx" | "tex"`.

- [ ] **Step 12: Typecheck the touched packages**

Run: `pnpm --filter @ai-career/db --filter @ai-career/storage --filter @ai-career/document-export typecheck`
Expected: PASS. (If `renderDocument` or another exhaustive switch over `DocumentKind` now fails, add the `tailored_resume` case only where the compiler points; `renderDocument` takes `DocumentFormat`, which is unchanged.)

- [ ] **Step 13: Commit**

```bash
git add packages/document-export/src/model/types.ts packages/document-export/src/errors.ts packages/document-export/src/model/filename.ts packages/document-export/src/model/filename.test.ts packages/db/src/schema/generatedDocuments.ts packages/db/migrations packages/db/src/generatedDocumentsTable.rls.test.ts packages/storage/src/generatedDocumentStorage.ts
git commit -m "feat(db,document-export): tailored_resume kind, tex format and details column (Phase 13c)"
```

---

### Task 2: `escapeTex`, the character whitelist and `findUnsupportedCharacter`

**Files:**
- Create: `packages/document-export/src/render/tex/escapeTex.ts`
- Test: `packages/document-export/src/render/tex/escapeTex.test.ts`

**Interfaces:**
- Consumes: `DocumentModel` (types.ts).
- Produces:
  ```ts
  export function escapeTex(text: string): string;
  export function isSupportedChar(ch: string): boolean;
  export function findUnsupportedCharacter(model: DocumentModel): string | null;
  export const SUPPORTED_SAMPLE: string; // every whitelisted character once, for the compile test (Task 8)
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/document-export/src/render/tex/escapeTex.test.ts
import { describe, it, expect } from "vitest";
import { escapeTex, findUnsupportedCharacter, isSupportedChar, SUPPORTED_SAMPLE } from "./escapeTex";
import type { DocumentModel } from "../../model/types";

describe("escapeTex", () => {
  it.each([
    ["\\", "\\textbackslash{}"],
    ["{", "\\{"],
    ["}", "\\}"],
    ["$", "\\$"],
    ["&", "\\&"],
    ["#", "\\#"],
    ["_", "\\_"],
    ["%", "\\%"],
    ["^", "\\textasciicircum{}"],
    ["~", "\\textasciitilde{}"],
    ["[", "{[}"],
    ["]", "{]}"],
    ["`", "\\textasciigrave{}"],
    ["\"", "\\textquotedbl{}"],
    ["|", "\\textbar{}"],
    ["–", "\\textendash{}"],
    ["—", "\\textemdash{}"],
    ["‘", "\\textquoteleft{}"],
    ["’", "\\textquoteright{}"],
    ["“", "\\textquotedblleft{}"],
    ["”", "\\textquotedblright{}"],
    ["•", "\\textbullet{}"],
    ["…", "\\ldots{}"],
    ["€", "\\texteuro{}"],
    ["£", "\\pounds{}"],
    ["−", "-"],
    ["→", "\\textrightarrow{}"],
    ["\u00a0", "~"],
  ])("escapes %j", (input, expected) => {
    expect(escapeTex(input)).toBe(expected);
  });

  it("neutralises command-looking text", () => {
    expect(escapeTex("\\input{/etc/passwd}")).toBe("\\textbackslash{}input\\{/etc/passwd\\}");
    expect(escapeTex("\\write18{id}")).toBe("\\textbackslash{}write18\\{id\\}");
  });

  it("breaks ligatures of repeated - ' , < > so they render literally", () => {
    expect(escapeTex("a--b")).toBe("a-{}-b");
    expect(escapeTex("it''s")).toBe("it'{}'s");
    expect(escapeTex(",,x")).toBe(",{},x");
    expect(escapeTex("<<>>")).toBe("<{}<>{}>");
  });

  it("turns tabs/newlines into spaces and strips control and zero-width characters", () => {
    expect(escapeTex("a\tb\nc\r\nd")).toBe("a b c d");
    expect(escapeTex("a\u0007b\u200bc\u00add\ufeff")).toBe("abcd");
  });

  it("keeps Latin letters as UTF-8", () => {
    expect(escapeTex("Müller Łukasz Ørsted ß")).toBe("Müller Łukasz Ørsted ß");
  });

  it("never leaves a raw TeX special character in its output (randomised)", () => {
    const alphabet = "\\{}$&#_%^~[]`\"|abc -',<>\n\t";
    for (let n = 0; n < 500; n++) {
      let s = "";
      for (let i = 0; i < 20; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
      const out = escapeTex(s);
      // Every backslash in the output starts one of our own macros; every { } is either escaped or one of our groups.
      const withoutOurs = out
        .replace(/\\(textbackslash|textasciicircum|textasciitilde|textasciigrave|textquotedbl|textbar)\{\}/g, "")
        .replace(/\\[{}$&#_%]/g, "")
        .replace(/\{\[\}|\{\]\}/g, "")
        .replace(/\{\}/g, "");
      expect(withoutOurs).not.toMatch(/[\\{}$&#_%^~]/);
    }
  });
});

describe("isSupportedChar", () => {
  it("accepts ASCII, Latin-1, Latin Extended-A and mapped characters", () => {
    for (const ch of ["a", "~", "é", "ß", "ÿ", "Ł", "ő", "€", "–", "•"]) expect(isSupportedChar(ch)).toBe(true);
  });
  it("rejects characters pdflatex+T1 cannot typeset", () => {
    for (const ch of ["Ħ", "ŉ", "ſ", "Ŀ", "中", "😀", "Ω", "✓"]) expect(isSupportedChar(ch)).toBe(false);
  });
  it("SUPPORTED_SAMPLE contains only supported characters and includes the mapped ones", () => {
    expect([...SUPPORTED_SAMPLE].every(isSupportedChar)).toBe(true);
    expect(SUPPORTED_SAMPLE).toContain("€");
    expect(SUPPORTED_SAMPLE).toContain("Ł");
  });
});

describe("findUnsupportedCharacter", () => {
  const model = (blocks: DocumentModel["blocks"], title = "Jane Doe", contactLine: string | null = "jane@example.com"): DocumentModel =>
    ({ title, contactLine, blocks });

  it("returns null for a clean model", () => {
    expect(findUnsupportedCharacter(model([{ type: "heading", text: "Experience" }, { type: "bullets", items: ["Built ü"] }]))).toBeNull();
  });
  it("locates the name and contact line", () => {
    expect(findUnsupportedCharacter(model([], "Jane 😀"))).toBe("Name");
    expect(findUnsupportedCharacter(model([], "Jane", "中"))).toBe("Contact details");
  });
  it("locates entries, entry bullets and plain items without echoing text", () => {
    const blocks: DocumentModel["blocks"] = [
      { type: "heading", text: "Experience" },
      { type: "entry", title: "Engineer", subtitle: "Globex", meta: null },
      { type: "bullets", items: ["ok"] },
      { type: "entry", title: "Lead", subtitle: null, meta: null },
      { type: "bullets", items: ["ok", "ok", "bad ✓"] },
    ];
    expect(findUnsupportedCharacter(model(blocks))).toBe("Experience, entry 2, bullet 3");
    expect(findUnsupportedCharacter(model([{ type: "heading", text: "Achievements" }, { type: "bullets", items: ["Ω"] }]))).toBe("Achievements, item 1");
    expect(findUnsupportedCharacter(model([{ type: "heading", text: "Skills" }, { type: "paragraph", text: "Go, 中文" }]))).toBe("Skills");
    expect(findUnsupportedCharacter(model([{ type: "heading", text: "Projects" }, { type: "entry", title: "Ħ", subtitle: null, meta: null }]))).toBe("Projects, entry 1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/render/tex/escapeTex.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/document-export/src/render/tex/escapeTex.ts
import type { DocumentModel } from "../../model/types";

/**
 * The only path from document text into TeX (Phase 13c spec §4, D208). Characters with a TeX meaning become
 * macros or escaped forms; typographic characters map to explicit macros so the PDF text layer is exact.
 */
const REPLACEMENTS: Readonly<Record<string, string>> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "%": "\\%",
  "^": "\\textasciicircum{}",
  "~": "\\textasciitilde{}",
  // `\item [x]` would read [x] as an optional argument.
  "[": "{[}",
  "]": "{]}",
  "`": "\\textasciigrave{}",
  '"': "\\textquotedbl{}",
  "|": "\\textbar{}",
  "\u00a0": "~",
  "–": "\\textendash{}",
  "—": "\\textemdash{}",
  "‘": "\\textquoteleft{}",
  "’": "\\textquoteright{}",
  "“": "\\textquotedblleft{}",
  "”": "\\textquotedblright{}",
  "•": "\\textbullet{}",
  "…": "\\ldots{}",
  "€": "\\texteuro{}",
  "£": "\\pounds{}",
  "−": "-",
  "→": "\\textrightarrow{}",
};

/** T1 ligatures that would change the text when a character is doubled ("--" en dash, ",," low quotes, "<<" guillemets). */
const LIGATURE_CHARS = new Set(["-", "'", ",", "<", ">"]);

/** Control, zero-width and soft-hyphen characters: removed, never typeset. */
const STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/** Latin Extended-A code points pdflatex's T1/utf8 setup has no glyph or definition for. */
const UNSUPPORTED_LATIN = new Set([0x126, 0x127, 0x138, 0x13f, 0x140, 0x149, 0x166, 0x167, 0x17f]);

function clean(text: string): string {
  return text.replace(/[\t\n\r]+/g, " ").replace(STRIP, "");
}

export function escapeTex(text: string): string {
  const chars = [...clean(text)];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    out += REPLACEMENTS[ch] ?? ch;
    if (LIGATURE_CHARS.has(ch) && chars[i + 1] === ch) out += "{}";
  }
  return out;
}

export function isSupportedChar(ch: string): boolean {
  if (ch in REPLACEMENTS) return true;
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0x17f) return !UNSUPPORTED_LATIN.has(cp);
  return false;
}

const hasUnsupported = (text: string): boolean => [...clean(text)].some((ch) => !isSupportedChar(ch));

/** Every supported character once (the compile test typesets it to prove the whitelist is honest). */
export const SUPPORTED_SAMPLE: string = (() => {
  let s = "";
  for (let cp = 0x20; cp <= 0x17f; cp++) {
    if (cp > 0x7e && cp < 0xa0) continue;
    const ch = String.fromCodePoint(cp);
    if (isSupportedChar(ch) && !STRIP.test(ch)) s += ch;
    STRIP.lastIndex = 0;
  }
  for (const ch of Object.keys(REPLACEMENTS)) if (!s.includes(ch)) s += ch;
  return s;
})();

/**
 * Where in the document the first character pdflatex cannot typeset is, as "Section, entry N, bullet M" -- a
 * location only, never the text (the message goes to the UI; the text stays in the profile).
 */
export function findUnsupportedCharacter(model: DocumentModel): string | null {
  if (hasUnsupported(model.title)) return "Name";
  if (model.contactLine !== null && hasUnsupported(model.contactLine)) return "Contact details";
  let section = "Document";
  let entry = 0;
  for (const block of model.blocks) {
    switch (block.type) {
      case "heading":
        section = block.text;
        entry = 0;
        if (hasUnsupported(block.text)) return section;
        break;
      case "entry":
        entry += 1;
        if ([block.title, block.subtitle, block.meta].some((t) => t !== null && hasUnsupported(t))) return `${section}, entry ${entry}`;
        break;
      case "paragraph":
        if (hasUnsupported(block.text)) return entry > 0 ? `${section}, entry ${entry}` : section;
        break;
      case "bullets": {
        const i = block.items.findIndex(hasUnsupported);
        if (i >= 0) return entry > 0 ? `${section}, entry ${entry}, bullet ${i + 1}` : `${section}, item ${i + 1}`;
        break;
      }
    }
  }
  return null;
}
```

Note on `SUPPORTED_SAMPLE`: `STRIP` is a global regex, so `.test` advances `lastIndex`; resetting it each iteration (as above) keeps the check correct. The soft hyphen U+00AD is in `STRIP`, so it is excluded.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/render/tex/escapeTex.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/document-export/src/render/tex/escapeTex.ts packages/document-export/src/render/tex/escapeTex.test.ts
git commit -m "feat(document-export): escapeTex, character whitelist and unsupported-character locations (Phase 13c)"
```

---

### Task 3: TeX template (`renderTex`) and line estimate (`estimateLines`)

**Files:**
- Create: `packages/document-export/src/render/tex/renderTex.ts`, `renderTex.test.ts`
- Create: `packages/document-export/src/model/estimateLines.ts`, `estimateLines.test.ts`

**Interfaces:**
- Consumes: `escapeTex` (Task 2); `DocumentModel`, `PaperSize` (Task 1).
- Produces:
  ```ts
  export function renderTex(model: DocumentModel, opts: { paperSize: PaperSize }): string;
  export interface LineMetrics { linesPerPage: number; charsPerLine: number; charsPerBulletLine: number }
  export const LINE_METRICS: Record<PaperSize, LineMetrics>;
  export const PAGE_SAFETY_LINES: number;
  export function estimateLines(model: DocumentModel, paperSize: PaperSize): number;
  export function lineBudget(paperSize: PaperSize): number;
  ```

- [ ] **Step 1: Write the failing renderTex test**

```ts
// packages/document-export/src/render/tex/renderTex.test.ts
import { describe, it, expect } from "vitest";
import { renderTex } from "./renderTex";
import type { DocumentModel } from "../../model/types";

const model: DocumentModel = {
  title: "Jane Doe",
  contactLine: "jane@example.com · +49 1",
  blocks: [
    { type: "heading", text: "Experience" },
    { type: "entry", title: "Engineer", subtitle: "Globex · Berlin", meta: "2021 – present" },
    { type: "bullets", items: ["Built A & B", "[Remote] 50% faster"] },
    { type: "heading", text: "Projects" },
    { type: "entry", title: "Tool", subtitle: null, meta: null },
    { type: "paragraph", text: "A CLI" },
    { type: "heading", text: "Skills" },
    { type: "paragraph", text: "C++, C#, .NET" },
  ],
};

describe("renderTex", () => {
  it("renders the template (golden)", () => {
    expect(renderTex(model, { paperSize: "a4" })).toMatchSnapshot();
  });
  it("switches paper size", () => {
    expect(renderTex(model, { paperSize: "letter" })).toContain("\\usepackage[letterpaper,margin=0.6in]{geometry}");
    expect(renderTex(model, { paperSize: "a4" })).toContain("\\usepackage[a4paper,margin=0.6in]{geometry}");
  });
  it("escapes every model string and keeps ATS-safe settings", () => {
    const tex = renderTex(model, { paperSize: "a4" });
    expect(tex).toContain("\\item Built A \\& B");
    expect(tex).toContain("\\item {[}Remote{]} 50\\% faster");
    expect(tex).toContain("C++, C\\#, .NET");
    expect(tex).toContain("\\pdfgentounicode=1");
    expect(tex).not.toMatch(/tabular|multicol|includegraphics|fontawesome/);
  });
  it("omits an empty contact line, empty bullet lists and a missing subtitle/meta", () => {
    const tex = renderTex({ title: "A", contactLine: null, blocks: [{ type: "entry", title: "T", subtitle: null, meta: null }, { type: "bullets", items: [] }] }, { paperSize: "a4" });
    expect(tex).not.toContain("\\small");
    expect(tex).not.toContain("\\begin{itemize}");
    expect(tex).not.toContain("\\hfill");
    expect(tex).not.toContain("\\textit");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/render/tex/renderTex.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement renderTex**

```ts
// packages/document-export/src/render/tex/renderTex.ts
import type { DocumentBlock, DocumentModel, PaperSize } from "../../model/types";
import { escapeTex } from "./escapeTex";

const PAPER: Record<PaperSize, string> = { a4: "a4paper", letter: "letterpaper" };

/**
 * One single-column, ATS-safe template (Phase 13c spec §4): standard section names, no tables/columns/icons/
 * graphics, glyphtounicode so the PDF text layer is real characters. Change => bump TEX_TEMPLATE_VERSION.
 */
function preamble(model: DocumentModel, paperSize: PaperSize): string[] {
  const name = escapeTex(model.title);
  return [
    "\\documentclass[10pt]{article}",
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage{lmodern}",
    `\\usepackage[${PAPER[paperSize]},margin=0.6in]{geometry}`,
    "\\usepackage{titlesec}",
    "\\usepackage{enumitem}",
    "\\usepackage[hidelinks]{hyperref}",
    "\\input{glyphtounicode}",
    "\\pdfgentounicode=1",
    "\\pagestyle{empty}",
    "\\setlength{\\parindent}{0pt}",
    "\\titleformat{\\section}{\\large\\bfseries}{}{0pt}{}[\\titlerule]",
    "\\titlespacing*{\\section}{0pt}{8pt}{4pt}",
    "\\setlist[itemize]{leftmargin=1.2em,itemsep=1pt,topsep=2pt,parsep=0pt}",
    `\\hypersetup{pdftitle={${name} - Resume},pdfauthor={${name}}}`,
  ];
}

function blockTex(block: DocumentBlock): string {
  switch (block.type) {
    case "heading":
      return `\\section*{${escapeTex(block.text)}}`;
    case "entry": {
      const title = `\\textbf{${escapeTex(block.title)}}`;
      const first = block.meta !== null ? `${title}\\hfill{}${escapeTex(block.meta)}\\par` : `${title}\\par`;
      const lines = ["\\vspace{2pt}", first];
      if (block.subtitle !== null) lines.push(`\\textit{${escapeTex(block.subtitle)}}\\par`);
      return lines.join("\n");
    }
    case "paragraph":
      return `${escapeTex(block.text)}\\par`;
    case "bullets":
      if (block.items.length === 0) return "";
      return ["\\begin{itemize}", ...block.items.map((item) => `\\item ${escapeTex(item)}`), "\\end{itemize}"].join("\n");
  }
}

export function renderTex(model: DocumentModel, opts: { paperSize: PaperSize }): string {
  const header = [
    "\\begin{center}",
    `{\\LARGE\\bfseries ${escapeTex(model.title)}}\\par`,
    ...(model.contactLine !== null ? ["\\vspace{2pt}", `{\\small ${escapeTex(model.contactLine)}}\\par`] : []),
    "\\end{center}",
  ];
  const body = model.blocks.map(blockTex).filter((s) => s.length > 0);
  return [...preamble(model, opts.paperSize), "\\begin{document}", ...header, ...body, "\\end{document}", ""].join("\n");
}
```

- [ ] **Step 4: Run, review the snapshot, verify pass**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/render/tex/renderTex.test.ts`
Expected: PASS; a new `__snapshots__/renderTex.test.ts.snap` is written. Read it once and confirm it is the template above with escaped text (`Globex · Berlin` stays as UTF-8, `–` became `\textendash{}`).

- [ ] **Step 5: Write the failing estimateLines test**

```ts
// packages/document-export/src/model/estimateLines.test.ts
import { describe, it, expect } from "vitest";
import { estimateLines, lineBudget, LINE_METRICS, PAGE_SAFETY_LINES } from "./estimateLines";
import type { DocumentModel } from "./types";

const base: DocumentModel = { title: "Jane", contactLine: "x", blocks: [] };

describe("estimateLines", () => {
  it("counts the header alone", () => {
    expect(estimateLines(base, "a4")).toBe(3);
  });
  it("adds headings, entries (subtitle adds a line), wrapped paragraphs and bullets", () => {
    const cpl = LINE_METRICS.a4.charsPerLine;
    const bcpl = LINE_METRICS.a4.charsPerBulletLine;
    const model: DocumentModel = {
      ...base,
      blocks: [
        { type: "heading", text: "Experience" },                                   // 2
        { type: "entry", title: "E", subtitle: "S", meta: "2021" },                 // 2.3
        { type: "bullets", items: ["a".repeat(bcpl), "a".repeat(bcpl + 1)] },       // 0.4 + 1 + 2
        { type: "paragraph", text: "a".repeat(cpl * 2 + 1) },                       // 3
        { type: "bullets", items: [] },                                             // 0
      ],
    };
    expect(estimateLines(model, "a4")).toBeCloseTo(3 + 2 + 2.3 + 3.4 + 3, 5);
  });
  it("wraps an entry whose title and meta do not fit on one line", () => {
    const long = "a".repeat(LINE_METRICS.letter.charsPerLine);
    expect(estimateLines({ ...base, blocks: [{ type: "entry", title: long, subtitle: null, meta: "2021" }] }, "letter")).toBeCloseTo(3 + 2 + 0.3, 5);
  });
  it("budget is the page minus the safety margin", () => {
    expect(lineBudget("a4")).toBe(LINE_METRICS.a4.linesPerPage - PAGE_SAFETY_LINES);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/model/estimateLines.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 7: Implement estimateLines**

```ts
// packages/document-export/src/model/estimateLines.ts
import type { DocumentModel, PaperSize } from "./types";

/**
 * Line metrics for renderTex's template (10pt Latin Modern, 0.6in margins). Starting values come from the page
 * geometry (A4: 756pt text height / 12pt baselineskip ≈ 63 lines; ~4.5pt average glyph width); the real-compile
 * test (latex.integration.test.ts) calibrates them. Changing them changes selection, not the template.
 */
export interface LineMetrics { linesPerPage: number; charsPerLine: number; charsPerBulletLine: number }
export const LINE_METRICS: Record<PaperSize, LineMetrics> = {
  a4: { linesPerPage: 63, charsPerLine: 110, charsPerBulletLine: 104 },
  letter: { linesPerPage: 58, charsPerLine: 114, charsPerBulletLine: 108 },
};
export const PAGE_SAFETY_LINES = 3;

const HEADER_LINES = 3;
const HEADING_LINES = 2;
const ENTRY_GAP = 0.3;
const LIST_GAP = 0.4;

const wrap = (length: number, perLine: number): number => Math.max(1, Math.ceil(length / perLine));

export function estimateLines(model: DocumentModel, paperSize: PaperSize): number {
  const m = LINE_METRICS[paperSize];
  let lines = HEADER_LINES;
  for (const block of model.blocks) {
    switch (block.type) {
      case "heading":
        lines += HEADING_LINES;
        break;
      case "entry":
        // title and meta share one line (\hfill); +1 separates them visually.
        lines += wrap(block.title.length + (block.meta?.length ?? 0) + 1, m.charsPerLine) + (block.subtitle !== null ? 1 : 0) + ENTRY_GAP;
        break;
      case "paragraph":
        lines += wrap(block.text.length, m.charsPerLine);
        break;
      case "bullets":
        if (block.items.length > 0) lines += LIST_GAP + block.items.reduce((sum, item) => sum + wrap(item.length, m.charsPerBulletLine), 0);
        break;
    }
  }
  return lines;
}

export function lineBudget(paperSize: PaperSize): number {
  return LINE_METRICS[paperSize].linesPerPage - PAGE_SAFETY_LINES;
}
```

Check the second test's arithmetic against this code: entry `"E"+"2021"+1 = 6` chars → 1 line + subtitle 1 + 0.3 = 2.3 ✓.; the "long title" test: `charsPerLine + 4 + 1` chars → 2 lines + 0.3 ✓.

- [ ] **Step 8: Run to verify pass**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/model/estimateLines.test.ts src/render/tex/renderTex.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/document-export/src/render/tex/renderTex.ts packages/document-export/src/render/tex/renderTex.test.ts packages/document-export/src/render/tex/__snapshots__ packages/document-export/src/model/estimateLines.ts packages/document-export/src/model/estimateLines.test.ts
git commit -m "feat(document-export): ATS-safe LaTeX resume template and line estimate (Phase 13c)"
```

---

### Task 4: `selectTailoredResume` (ranking, floors, fitting, skills line)

**Files:**
- Create: `packages/document-export/src/model/resumeSections.ts`
- Modify: `packages/document-export/src/model/buildResumeModel.ts`
- Create: `packages/document-export/src/model/selectTailoredResume.ts`, `selectTailoredResume.test.ts`

**Interfaces:**
- Consumes: `ResumeProfile`, `contactLine`, `dateRange`, `certDates`, `present` (resumeProfile.ts); `AppliedBullet`, `RequirementTerm`, `containsTerm`, `normalizeTermKey` (`@ai-career/resume-optimization`); `estimateLines`, `lineBudget`, `LINE_METRICS` (Task 3); `OmittedItem`, `PaperSize`, `RankableSourceType` (Task 1).
- Produces:
  ```ts
  export interface TailoredSelection { model: DocumentModel; includedCount: number; totalCount: number; omitted: OmittedItem[]; exhausted: boolean }
  export interface SelectTailoredOptions { paperSize: PaperSize; extraRemovals?: number }
  export function selectTailoredResume(profile: ResumeProfile, applied: AppliedBullet[], requirements: RequirementTerm[], opts: SelectTailoredOptions): TailoredSelection;
  // resumeSections.ts
  export function joinPresent(parts: (string | null)[]): string | null;
  export function educationBlocks(profile: ResumeProfile): DocumentBlock[];
  export function certificationBlocks(profile: ResumeProfile): DocumentBlock[];
  ```

- [ ] **Step 1: Extract shared section builders (refactor, existing tests guard it)**

Create `packages/document-export/src/model/resumeSections.ts`:

```ts
import type { DocumentBlock } from "./types";
import { certDates, dateRange, present, type ResumeProfile } from "./resumeProfile";

/** Joins the non-blank parts with " · ", or null if none are present. */
export function joinPresent(parts: (string | null)[]): string | null {
  const kept = parts.filter(present);
  return kept.length > 0 ? kept.join(" · ") : null;
}

/** Education, verbatim (records are never reworded, D82). Shared by the full and the tailored resume. */
export function educationBlocks(profile: ResumeProfile): DocumentBlock[] {
  if (profile.education.length === 0) return [];
  return [
    { type: "heading", text: "Education" },
    ...profile.education.map((e): DocumentBlock => ({
      type: "entry",
      title: present(e.fieldOfStudy) ? `${e.degree} in ${e.fieldOfStudy}` : e.degree,
      subtitle: present(e.gpa) ? `${e.institution} · GPA ${e.gpa}` : e.institution,
      meta: dateRange(e.startDate, e.endDate),
    })),
  ];
}

export function certificationBlocks(profile: ResumeProfile): DocumentBlock[] {
  if (profile.certifications.length === 0) return [];
  return [
    { type: "heading", text: "Certifications" },
    ...profile.certifications.map((c): DocumentBlock => ({ type: "entry", title: c.name, subtitle: c.issuer, meta: certDates(c.issueDate, c.expiryDate) })),
  ];
}
```

In `buildResumeModel.ts`: delete the local `joinPresent`; import `{ certificationBlocks, educationBlocks, joinPresent } from "./resumeSections"`; replace the Education and Certifications `if` blocks with `blocks.push(...educationBlocks(profile));` and `blocks.push(...certificationBlocks(profile));`; drop now-unused imports (`certDates`, possibly `dateRange` — keep `dateRange` since Experience still uses it).

Run: `pnpm --filter @ai-career/document-export exec vitest run src/model/buildResumeModel.test.ts`
Expected: PASS (unchanged behavior).

- [ ] **Step 2: Write the failing selection tests**

```ts
// packages/document-export/src/model/selectTailoredResume.test.ts
import { describe, it, expect } from "vitest";
import type { AppliedBullet, RequirementTerm } from "@ai-career/resume-optimization";
import { selectTailoredResume } from "./selectTailoredResume";
import type { ResumeProfile } from "./resumeProfile";
import type { DocumentModel } from "./types";

const contact = { fullName: "Jane Doe", email: "jane@example.com", phoneNumber: null, linkedinUrl: null };

function profileWith(over: Partial<ResumeProfile> = {}): ResumeProfile {
  return {
    contact,
    experiences: [
      { id: "e1", company: "Globex", title: "Engineer", location: null, startDate: "2021", endDate: null,
        bullets: [{ id: "b1", text: "Built Kafka pipelines" }, { id: "b2", text: "Ran standups" }, { id: "b3", text: "Wrote Python ETL" }] },
      { id: "e2", company: "Initech", title: "Analyst", location: null, startDate: "2018", endDate: "2021",
        bullets: [{ id: "b4", text: "Made reports" }, { id: "b5", text: "Used SQL daily" }] },
      { id: "e3", company: "Umbrella", title: "Intern", location: null, startDate: "2017", endDate: "2018",
        bullets: [{ id: "b6", text: "Filed tickets" }, { id: "b7", text: "Learned Python" }] },
    ],
    achievements: [{ id: "a1", description: "Won a hackathon" }],
    projects: [{ id: "p1", name: "Tool", description: "A Kafka CLI", url: null }, { id: "p2", name: "Blog", description: "Cooking blog", url: null }],
    certifications: [{ id: "c1", name: "AWS SA", issuer: "AWS", issueDate: null, expiryDate: null }],
    education: [{ id: "ed1", institution: "TU", degree: "BSc", fieldOfStudy: null, startDate: null, endDate: null, gpa: null }],
    skills: [{ id: "s1", name: "Excel" }, { id: "s2", name: "Python" }, { id: "s3", name: "kafka" }],
    verifiedSkills: [{ id: "v1", term: "SQL" }, { id: "v2", term: "Python" }],
    ...over,
  };
}

const reqs: RequirementTerm[] = [
  { termText: "Kafka", requirementLevel: "required" },
  { termText: "Python", requirementLevel: "preferred" },
  { termText: "SQL", requirementLevel: "required" },
  { termText: "  ", requirementLevel: "required" },
];

const applied = (id: string, text: string, sourceType: AppliedBullet["sourceType"] = "work_experience_bullet"): AppliedBullet =>
  ({ sourceFactId: id, sourceType, originalText: "x", optimizedText: text, changeType: "reworded", justification: "j" });

const bulletsOf = (model: DocumentModel, entryTitle: string): string[] => {
  const i = model.blocks.findIndex((b) => b.type === "entry" && b.title === entryTitle);
  const next = model.blocks[i + 1];
  return next?.type === "bullets" ? next.items : [];
};
const paragraphAfter = (model: DocumentModel, heading: string): string | undefined => {
  const i = model.blocks.findIndex((b) => b.type === "heading" && b.text === heading);
  const next = model.blocks[i + 1];
  return next?.type === "paragraph" ? next.text : undefined;
};
const headings = (model: DocumentModel) => model.blocks.filter((b) => b.type === "heading").map((b) => (b as { text: string }).text);

describe("selectTailoredResume", () => {
  it("keeps everything that fits, orders selected first (optimizer text), then by requirement score", () => {
    const sel = selectTailoredResume(profileWith(), [applied("b2", "Led daily standups for 6 engineers")], reqs, { paperSize: "a4" });
    expect(bulletsOf(sel.model, "Engineer")).toEqual(["Led daily standups for 6 engineers", "Built Kafka pipelines", "Wrote Python ETL"]);
    expect(bulletsOf(sel.model, "Analyst")).toEqual(["Used SQL daily", "Made reports"]);
    expect(sel.includedCount).toBe(10);
    expect(sel.totalCount).toBe(10);
    expect(sel.omitted).toEqual([]);
    expect(headings(sel.model)).toEqual(["Experience", "Projects", "Achievements", "Education", "Certifications", "Skills"]);
    expect(sel.model.title).toBe("Jane Doe");
  });

  it("falls back to the original text when optimizedText is blank", () => {
    const sel = selectTailoredResume(profileWith(), [applied("b2", "   ")], reqs, { paperSize: "a4" });
    expect(bulletsOf(sel.model, "Engineer")[0]).toBe("Ran standups");
  });

  it("lists matched skills first in requirement order (required first), dedupes verified terms, keeps names verbatim", () => {
    const sel = selectTailoredResume(profileWith(), [], reqs, { paperSize: "a4" });
    expect(paragraphAfter(sel.model, "Skills")).toBe("kafka, SQL, Python, Excel");
  });

  it("throws on an applied bullet citing an unknown fact", () => {
    expect(() => selectTailoredResume(profileWith(), [applied("nope", "x")], reqs, { paperSize: "a4" })).toThrow(/unknown source fact nope/);
  });

  it("removes zero-score projects/achievements first, then lowest-ranked bullets, respecting floors", () => {
    // extraRemovals simulates the compile loop asking for more room.
    const sel = selectTailoredResume(profileWith(), [], reqs, { paperSize: "a4", extraRemovals: 3 });
    // Zero-score extras go first: "Cooking blog" (p2) and the hackathon (a1); then the worst bullet that is not floor-protected.
    expect(sel.omitted).toEqual([
      { sourceType: "work_experience_bullet", sourceFactId: "b6", reason: "no_requirement_match" },
      { sourceType: "project", sourceFactId: "p2", reason: "no_requirement_match" },
      { sourceType: "achievement", sourceFactId: "a1", reason: "no_requirement_match" },
    ]);
    expect(headings(sel.model)).not.toContain("Achievements");
    expect(bulletsOf(sel.model, "Intern")).toEqual(["Learned Python"]); // floor: 1 bullet for the third role
    expect(sel.includedCount).toBe(7);
  });

  it("never goes below the floors and reports exhausted", () => {
    const sel = selectTailoredResume(profileWith(), [], reqs, { paperSize: "a4", extraRemovals: 100 });
    expect(bulletsOf(sel.model, "Engineer")).toHaveLength(2);
    expect(bulletsOf(sel.model, "Analyst")).toHaveLength(2);
    expect(bulletsOf(sel.model, "Intern")).toHaveLength(1);
    expect(sel.exhausted).toBe(true);
    expect(headings(sel.model)).toEqual(expect.arrayContaining(["Education", "Certifications", "Skills"]));
    const reasons = Object.fromEntries(sel.omitted.map((o) => [o.sourceFactId, o.reason]));
    expect(reasons.p1).toBe("page_limit"); // scored (Kafka) but cut for space
    expect(reasons.b2).toBe("no_requirement_match");
    expect(reasons.b3).toBeUndefined(); // floor-protected (second-best bullet of the first role)
  });

  it("fits a long profile to the estimate budget, marking cut scored items page_limit", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, text: `Did Kafka thing number ${i} `.repeat(4) }));
    const sel = selectTailoredResume(profileWith({ experiences: [{ ...profileWith().experiences[0], bullets: many }] }), [], reqs, { paperSize: "a4" });
    expect(sel.omitted.length).toBeGreaterThan(0);
    expect(sel.omitted.every((o) => o.reason === "page_limit" || o.sourceType !== "work_experience_bullet")).toBe(true);
    expect(sel.exhausted).toBe(false);
  });

  it("handles a one-role, one-bullet profile with no projects or achievements", () => {
    const p = profileWith({ experiences: [{ ...profileWith().experiences[0], bullets: [{ id: "b1", text: "Built Kafka pipelines" }] }], projects: [], achievements: [] });
    const sel = selectTailoredResume(p, [], [], { paperSize: "letter", extraRemovals: 3 });
    expect(bulletsOf(sel.model, "Engineer")).toEqual(["Built Kafka pipelines"]);
    expect(sel.exhausted).toBe(true);
    expect(sel.totalCount).toBe(1);
  });
});
```

Derivation for the removal tests (profile order b1…b7, p1, p2, a1): scores b1 2 (Kafka), b2 0, b3 1 (Python), b4 0, b5 2 (SQL), b6 0, b7 1 (Python), p1 2 (Kafka), p2 0, a1 0. Rank: b1, b5, p1, b3, b7, b2, b4, b6, p2, a1. Floors protect b1, b3 (role 1), b5, b4 (role 2), b7 (role 3). Removal queue: zero-score projects/achievements worst-first (a1, p2), then the rest worst-first (b6, b2, p1). With everything fitting by estimate, `extraRemovals: 3` removes a1, p2, b6; `omitted` is reported in profile order (b6, p2, a1). `extraRemovals: 100` removes all five and sets `exhausted`.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/model/selectTailoredResume.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// packages/document-export/src/model/selectTailoredResume.ts
import { containsTerm, normalizeTermKey, type AppliedBullet, type RequirementTerm } from "@ai-career/resume-optimization";
import type { DocumentBlock, DocumentModel, OmittedItem, PaperSize, RankableSourceType } from "./types";
import { contactLine, dateRange, present, type ResumeProfile } from "./resumeProfile";
import { certificationBlocks, educationBlocks, joinPresent } from "./resumeSections";
import { estimateLines, lineBudget, LINE_METRICS } from "./estimateLines";

export interface TailoredSelection {
  model: DocumentModel;
  includedCount: number;
  totalCount: number;
  /** In profile order. */
  omitted: OmittedItem[];
  /** True when every remaining rankable item is protected by a floor (nothing more can be removed). */
  exhausted: boolean;
}

export interface SelectTailoredOptions {
  paperSize: PaperSize;
  /** Items to remove beyond the estimate fit -- the compile loop's lever (fitToPage). */
  extraRemovals?: number;
}

const REQUIRED_WEIGHT = 2;
const PREFERRED_WEIGHT = 1;
const SKILLS_MAX_LINES = 2;
const FLOOR_RECENT_ROLES = 2;

interface Requirement { key: string; lower: string; weight: number }

interface Item {
  key: string;
  sourceType: RankableSourceType;
  id: string;
  text: string;
  selectedRank: number | null;
  score: number;
  profileOrder: number;
  roleIndex: number | null;
}

/** Non-blank terms, one per normalized key at its highest weight; required before preferred, then input order. */
function dedupeRequirements(requirements: RequirementTerm[]): Requirement[] {
  const byKey = new Map<string, Requirement>();
  for (const r of requirements) {
    if (!present(r.termText)) continue;
    const key = normalizeTermKey(r.termText);
    const weight = r.requirementLevel === "required" ? REQUIRED_WEIGHT : PREFERRED_WEIGHT;
    const prev = byKey.get(key);
    if (!prev || weight > prev.weight) byKey.set(key, { key, lower: r.termText.trim().toLowerCase(), weight });
  }
  return [...byKey.values()].sort((a, b) => b.weight - a.weight);
}

/** Selected (optimizer order) first; then requirement score descending; then profile order. */
function compareRank(a: Item, b: Item): number {
  if (a.selectedRank !== null && b.selectedRank !== null) return a.selectedRank - b.selectedRank;
  if (a.selectedRank !== null) return -1;
  if (b.selectedRank !== null) return 1;
  return b.score - a.score || a.profileOrder - b.profileOrder;
}

function assertKnownApplied(profile: ResumeProfile, applied: AppliedBullet[]): void {
  const knownIds = new Set<string>([
    ...profile.experiences.flatMap((e) => e.bullets.map((b) => `work_experience_bullet:${b.id}`)),
    ...profile.achievements.map((a) => `achievement:${a.id}`),
    ...profile.projects.map((p) => `project:${p.id}`),
    ...profile.certifications.map((c) => `certification:${c.id}`),
    ...profile.education.map((e) => `education:${e.id}`),
    ...profile.skills.map((s) => `skill:${s.id}`),
    ...profile.verifiedSkills.map((v) => `verified_skill:${v.id}`),
  ]);
  for (const a of applied) {
    if (!knownIds.has(`${a.sourceType}:${a.sourceFactId}`)) throw new Error(`applied bullet cites unknown source fact ${a.sourceFactId}`);
  }
}

function skillNames(profile: ResumeProfile, requirements: Requirement[], paperSize: PaperSize): string[] {
  const all: string[] = [];
  const seen = new Set<string>();
  for (const name of [...profile.skills.map((s) => s.name), ...profile.verifiedSkills.map((v) => v.term)]) {
    if (!present(name)) continue;
    const key = normalizeTermKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(name);
  }
  const reqOrder = new Map(requirements.map((r, i) => [r.key, i]));
  const order = (name: string) => reqOrder.get(normalizeTermKey(name));
  const matched = all.filter((n) => order(n) !== undefined).sort((a, b) => order(a)! - order(b)!);
  const rest = all.filter((n) => order(n) === undefined);
  const cap = SKILLS_MAX_LINES * LINE_METRICS[paperSize].charsPerLine;
  const out: string[] = [];
  let length = 0;
  for (const name of [...matched, ...rest]) {
    const add = (out.length > 0 ? 2 : 0) + name.length;
    if (length + add > cap) continue;
    out.push(name);
    length += add;
  }
  return out;
}

/**
 * The tailored resume (Phase 13c spec §3, D207): the optimizer's guard-applied rewordings first, the rest ranked by
 * the job's requirement terms, trimmed to one estimated page without breaking the floors. Deterministic; no text is
 * written here -- every string is the optimizer's guard-applied text or the profile's own.
 */
export function selectTailoredResume(
  profile: ResumeProfile, applied: AppliedBullet[], requirementTerms: RequirementTerm[], opts: SelectTailoredOptions
): TailoredSelection {
  assertKnownApplied(profile, applied);
  const requirements = dedupeRequirements(requirementTerms);
  const appliedByKey = new Map<string, { rank: number; optimizedText: string }>();
  applied.forEach((a, index) => {
    const key = `${a.sourceType}:${a.sourceFactId}`;
    if (!appliedByKey.has(key)) appliedByKey.set(key, { rank: index, optimizedText: a.optimizedText }); // first occurrence wins
  });

  const items: Item[] = [];
  const add = (sourceType: RankableSourceType, id: string, original: string, roleIndex: number | null) => {
    const key = `${sourceType}:${id}`;
    const a = appliedByKey.get(key);
    const text = a && present(a.optimizedText) ? a.optimizedText : original;
    const lower = text.toLowerCase();
    const score = requirements.reduce((sum, r) => sum + (containsTerm(lower, r.lower) ? r.weight : 0), 0);
    items.push({ key, sourceType, id, text, selectedRank: a?.rank ?? null, score, profileOrder: items.length, roleIndex });
  };
  profile.experiences.forEach((exp, roleIndex) => exp.bullets.forEach((b) => add("work_experience_bullet", b.id, b.text, roleIndex)));
  profile.projects.forEach((p) => add("project", p.id, p.description, null));
  profile.achievements.forEach((a) => add("achievement", a.id, a.description, null));

  const ranked = [...items].sort(compareRank);
  const isProtected = new Set<string>();
  profile.experiences.forEach((_, roleIndex) => {
    const floor = roleIndex < FLOOR_RECENT_ROLES ? 2 : 1;
    ranked.filter((i) => i.roleIndex === roleIndex).slice(0, floor).forEach((i) => isProtected.add(i.key));
  });
  const isIrrelevant = (i: Item) => i.selectedRank === null && i.score === 0;
  const worstFirst = [...ranked].reverse().filter((i) => !isProtected.has(i.key));
  const removalQueue = [
    ...worstFirst.filter((i) => i.sourceType !== "work_experience_bullet" && isIrrelevant(i)),
    ...worstFirst.filter((i) => !(i.sourceType !== "work_experience_bullet" && isIrrelevant(i))),
  ];

  const skills = skillNames(profile, requirements, opts.paperSize);
  const projectsById = new Map(profile.projects.map((p) => [p.id, p]));

  const build = (removed: Set<string>): DocumentModel => {
    const kept = (filter: (i: Item) => boolean) => items.filter((i) => filter(i) && !removed.has(i.key)).sort(compareRank);
    const blocks: DocumentBlock[] = [];
    if (profile.experiences.length > 0) {
      blocks.push({ type: "heading", text: "Experience" });
      profile.experiences.forEach((exp, roleIndex) => {
        blocks.push({ type: "entry", title: exp.title, subtitle: joinPresent([exp.company, exp.location]), meta: dateRange(exp.startDate, exp.endDate) });
        const bullets = kept((i) => i.roleIndex === roleIndex);
        if (bullets.length > 0) blocks.push({ type: "bullets", items: bullets.map((i) => i.text) });
      });
    }
    const projects = kept((i) => i.sourceType === "project");
    if (projects.length > 0) {
      blocks.push({ type: "heading", text: "Projects" });
      for (const i of projects) {
        const p = projectsById.get(i.id)!;
        blocks.push({ type: "entry", title: p.name, subtitle: present(p.url) ? p.url : null, meta: null });
        blocks.push({ type: "paragraph", text: i.text });
      }
    }
    const achievements = kept((i) => i.sourceType === "achievement");
    if (achievements.length > 0) {
      blocks.push({ type: "heading", text: "Achievements" });
      blocks.push({ type: "bullets", items: achievements.map((i) => i.text) });
    }
    blocks.push(...educationBlocks(profile), ...certificationBlocks(profile));
    if (skills.length > 0) {
      blocks.push({ type: "heading", text: "Skills" });
      blocks.push({ type: "paragraph", text: skills.join(", ") });
    }
    return { title: profile.contact.fullName, contactLine: contactLine(profile.contact), blocks };
  };

  const removed = new Set<string>();
  const budget = lineBudget(opts.paperSize);
  let next = 0;
  let model = build(removed);
  while (estimateLines(model, opts.paperSize) > budget && next < removalQueue.length) {
    removed.add(removalQueue[next++].key);
    model = build(removed);
  }
  for (let n = 0; n < (opts.extraRemovals ?? 0) && next < removalQueue.length; n++) {
    removed.add(removalQueue[next++].key);
    model = build(removed);
  }

  const omitted: OmittedItem[] = items
    .filter((i) => removed.has(i.key))
    .map((i) => ({ sourceType: i.sourceType, sourceFactId: i.id, reason: isIrrelevant(i) ? "no_requirement_match" : "page_limit" }));
  return { model, includedCount: items.length - removed.size, totalCount: items.length, omitted, exhausted: next >= removalQueue.length };
}
```

Check the first test against the implementation: `includedCount` 10 = 7 bullets + 2 projects + 1 achievement ✓. Skills: profile skills Excel, Python, kafka + verified SQL (Python verified deduped); matched in requirement order — required first: Kafka (0), SQL (1), then preferred Python (2) → `kafka, SQL, Python`, then `Excel` ✓.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/model/selectTailoredResume.test.ts src/model/buildResumeModel.test.ts`
Expected: PASS. If the removal-order test fails only on which bullet is removed third, re-derive by hand from `compareRank` + floors (the comment under Step 2) and fix the code, not the expectation, unless the hand derivation shows the expectation is wrong; record any change in the task report.

- [ ] **Step 6: Commit**

```bash
git add packages/document-export/src/model/resumeSections.ts packages/document-export/src/model/buildResumeModel.ts packages/document-export/src/model/selectTailoredResume.ts packages/document-export/src/model/selectTailoredResume.test.ts
git commit -m "feat(document-export): deterministic tailored resume selection with floors and one-page estimate (Phase 13c)"
```

---

### Task 5: `TexCompiler` HTTP client and `fitToPage`

**Files:**
- Create: `packages/document-export/src/render/compileTex.ts`, `compileTex.test.ts`
- Create: `packages/document-export/src/pipeline/fitToPage.ts`, `fitToPage.test.ts`

**Interfaces:**
- Consumes: `DocumentExportError` (Task 1); `TailoredSelection` (Task 4); `DocumentModel`.
- Produces:
  ```ts
  export interface CompiledPdf { pdf: Buffer; pageCount: number; texVersion: string }
  export interface TexCompiler { compile(tex: string): Promise<CompiledPdf> }
  export interface HttpTexCompilerOptions { url: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }
  export function createHttpTexCompiler(opts: HttpTexCompilerOptions): TexCompiler;
  export const MAX_EXTRA_TRIMS = 3;
  export interface FitResult { selection: TailoredSelection; tex: string; compiled: CompiledPdf | null }
  export function fitToPage(build: (extraRemovals: number) => TailoredSelection, render: (model: DocumentModel) => string, compiler: TexCompiler | null): Promise<FitResult>;
  ```

- [ ] **Step 1: Write the failing client tests**

```ts
// packages/document-export/src/render/compileTex.test.ts
import { describe, it, expect, vi } from "vitest";
import { createHttpTexCompiler } from "./compileTex";
import { DocumentExportError } from "../errors";

const response = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) => new Response(body, { status, headers });
const compilerWith = (fetchImpl: typeof fetch) => createHttpTexCompiler({ url: "http://127.0.0.1:8090", token: "t".repeat(32), fetchImpl });
const errorClassOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return e instanceof DocumentExportError ? [e.errorClass, e.detail] : ["other", String(e)]; }
  return ["resolved"];
};

describe("createHttpTexCompiler", () => {
  it("POSTs the tex with the bearer token and returns pdf, page count and TeX version", async () => {
    const fetchImpl = vi.fn(async () => response(200, Buffer.from("%PDF-1.5"), { "X-Page-Count": "1", "X-Tex-Version": "pdfTeX 3.14" }));
    const out = await compilerWith(fetchImpl as unknown as typeof fetch).compile("\\documentclass{article}");
    expect(out).toEqual({ pdf: Buffer.from("%PDF-1.5"), pageCount: 1, texVersion: "pdfTeX 3.14" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8090/compile");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${"t".repeat(32)}`);
    expect(init.body).toBe("\\documentclass{article}");
  });

  it.each([
    [422, JSON.stringify({ code: "compile_failed", line: 42 }), ["compile_failed", "line 42"]],
    [413, JSON.stringify({ code: "too_large" }), ["compile_failed", "document too large"]],
    [503, JSON.stringify({ code: "busy" }), ["compiler_busy", undefined]],
    [504, JSON.stringify({ code: "timeout" }), ["compiler_timeout", undefined]],
    [401, JSON.stringify({ code: "unauthorized" }), ["compiler_unavailable", undefined]],
    [500, "oops", ["compiler_unavailable", undefined]],
  ])("maps HTTP %i", async (status, body, expected) => {
    const c = compilerWith((async () => response(status, body)) as unknown as typeof fetch);
    expect(await errorClassOf(c.compile("x"))).toEqual(expected);
  });

  it("treats a 200 without page count or version as unavailable", async () => {
    const c = compilerWith((async () => response(200, "x", { "X-Page-Count": "abc" })) as unknown as typeof fetch);
    expect(await errorClassOf(c.compile("x"))).toEqual(["compiler_unavailable", undefined]);
  });

  it("maps a network error to unavailable and a client timeout to compiler_timeout", async () => {
    const refused = compilerWith((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch);
    expect((await errorClassOf(refused.compile("x")))[0]).toBe("compiler_unavailable");
    const slow = createHttpTexCompiler({
      url: "http://127.0.0.1:8090", token: "t".repeat(32), timeoutMs: 20,
      fetchImpl: ((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch,
    });
    expect((await errorClassOf(slow.compile("x")))[0]).toBe("compiler_timeout");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/render/compileTex.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the client**

```ts
// packages/document-export/src/render/compileTex.ts
import { DocumentExportError } from "../errors";

export interface CompiledPdf { pdf: Buffer; pageCount: number; texVersion: string }
export interface TexCompiler { compile(tex: string): Promise<CompiledPdf> }
export interface HttpTexCompilerOptions { url: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }

/** Above the service's own 20 s kill, so a slow compile normally ends as the service's 504, not a client abort. */
export const TEX_COMPILE_CLIENT_TIMEOUT_MS = 30_000;

/** Client for services/latex-compiler (Phase 13c spec §5). Errors carry no compiler log text, only a line number. */
export function createHttpTexCompiler(opts: HttpTexCompilerOptions): TexCompiler {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = new URL("/compile", opts.url).toString();
  return {
    async compile(tex: string): Promise<CompiledPdf> {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "text/plain; charset=utf-8" },
          body: tex,
          signal: AbortSignal.timeout(opts.timeoutMs ?? TEX_COMPILE_CLIENT_TIMEOUT_MS),
        });
      } catch (cause) {
        const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
        throw new DocumentExportError(timedOut ? "compiler_timeout" : "compiler_unavailable", { cause });
      }
      if (res.status === 200) {
        const pageCount = Number(res.headers.get("x-page-count"));
        const texVersion = res.headers.get("x-tex-version") ?? "";
        if (!Number.isInteger(pageCount) || pageCount < 1 || texVersion === "") throw new DocumentExportError("compiler_unavailable");
        return { pdf: Buffer.from(await res.arrayBuffer()), pageCount, texVersion };
      }
      const body = (await res.json().catch(() => null)) as { line?: unknown } | null;
      switch (res.status) {
        case 422:
          throw new DocumentExportError("compile_failed", { detail: typeof body?.line === "number" ? `line ${body.line}` : undefined });
        case 413:
          throw new DocumentExportError("compile_failed", { detail: "document too large" });
        case 503:
          throw new DocumentExportError("compiler_busy");
        case 504:
          throw new DocumentExportError("compiler_timeout");
        default:
          throw new DocumentExportError("compiler_unavailable");
      }
    },
  };
}
```

If the abort test reports `compiler_unavailable`, log `cause.name` in the test once: Node's `AbortSignal.timeout` rejects with a `DOMException` named `TimeoutError`, which is not `instanceof Error` on some Node versions. In that case change the check to `const name = (cause as { name?: unknown })?.name; const timedOut = name === "TimeoutError" || name === "AbortError";`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/render/compileTex.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing fitToPage tests**

```ts
// packages/document-export/src/pipeline/fitToPage.test.ts
import { describe, it, expect, vi } from "vitest";
import { fitToPage, MAX_EXTRA_TRIMS } from "./fitToPage";
import type { TailoredSelection } from "../model/selectTailoredResume";
import type { TexCompiler } from "../render/compileTex";

const sel = (extra: number, exhausted = false): TailoredSelection => ({
  model: { title: `m${extra}`, contactLine: null, blocks: [] }, includedCount: 10 - extra, totalCount: 10, omitted: [], exhausted,
});
const render = (m: { title: string }) => `tex:${m.title}`;
const compilerReturning = (...pages: number[]): TexCompiler & { compile: ReturnType<typeof vi.fn> } => {
  const compile = vi.fn(async (tex: string) => ({ pdf: Buffer.from(tex), pageCount: pages.shift() ?? 1, texVersion: "v" }));
  return { compile };
};

describe("fitToPage", () => {
  it("returns the estimate fit without compiling when there is no compiler", async () => {
    const out = await fitToPage(sel, render, null);
    expect(out).toEqual({ selection: sel(0), tex: "tex:m0", compiled: null });
  });
  it("stops at the first one-page compile", async () => {
    const c = compilerReturning(1);
    const out = await fitToPage(sel, render, c);
    expect(c.compile).toHaveBeenCalledTimes(1);
    expect(out.compiled?.pageCount).toBe(1);
  });
  it("trims and recompiles until it fits", async () => {
    const c = compilerReturning(2, 2, 1);
    const out = await fitToPage(sel, render, c);
    expect(c.compile).toHaveBeenCalledTimes(3);
    expect(out.tex).toBe("tex:m2");
    expect(out.compiled?.pdf.toString()).toBe("tex:m2");
  });
  it("gives up after MAX_EXTRA_TRIMS extra compiles and returns the last (2-page) result", async () => {
    const c = compilerReturning(2, 2, 2, 2, 2);
    const out = await fitToPage(sel, render, c);
    expect(c.compile).toHaveBeenCalledTimes(MAX_EXTRA_TRIMS + 1);
    expect(out.compiled?.pageCount).toBe(2);
  });
  it("stops when nothing more can be removed", async () => {
    const c = compilerReturning(2, 2);
    const out = await fitToPage((n) => sel(n, true), render, c);
    expect(c.compile).toHaveBeenCalledTimes(1);
    expect(out.compiled?.pageCount).toBe(2);
  });
});
```

- [ ] **Step 6: Run to verify failure, implement, verify pass**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/pipeline/fitToPage.test.ts` → FAIL (module not found).

```ts
// packages/document-export/src/pipeline/fitToPage.ts
import type { DocumentModel } from "../model/types";
import type { TailoredSelection } from "../model/selectTailoredResume";
import type { CompiledPdf, TexCompiler } from "../render/compileTex";

/** Compiles after the estimate fit at most this many extra times, removing one more item each time (spec §3). */
export const MAX_EXTRA_TRIMS = 3;

export interface FitResult { selection: TailoredSelection; tex: string; compiled: CompiledPdf | null }

/**
 * Estimate fit, then (with a compiler) compile → if more than one page, remove the next item and recompile.
 * Ends at one page, after MAX_EXTRA_TRIMS, or when floors leave nothing removable (D211).
 */
export async function fitToPage(
  build: (extraRemovals: number) => TailoredSelection,
  render: (model: DocumentModel) => string,
  compiler: TexCompiler | null
): Promise<FitResult> {
  for (let extra = 0; ; extra++) {
    const selection = build(extra);
    const tex = render(selection.model);
    if (compiler === null) return { selection, tex, compiled: null };
    const compiled = await compiler.compile(tex);
    if (compiled.pageCount <= 1 || extra >= MAX_EXTRA_TRIMS || selection.exhausted) return { selection, tex, compiled };
  }
}
```

Run again → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/document-export/src/render/compileTex.ts packages/document-export/src/render/compileTex.test.ts packages/document-export/src/pipeline/fitToPage.ts packages/document-export/src/pipeline/fitToPage.test.ts
git commit -m "feat(document-export): LaTeX compiler client and compile-and-trim fit loop (Phase 13c)"
```

---

### Task 6: `storeDocument` prerendered path and `exportTailoredResume`

**Files:**
- Create: `packages/document-export/src/pipeline/loadResumeExportContext.ts`
- Modify: `packages/document-export/src/pipeline/exportResume.ts`
- Modify: `packages/document-export/src/pipeline/storeDocument.ts`
- Modify: `packages/document-export/src/model/hash.ts`, `hash.test.ts`
- Create: `packages/document-export/src/pipeline/exportTailoredResume.ts`, `exportTailoredResume.test.ts`
- Modify: `packages/document-export/src/testing/db.ts`, `testing/index.ts` (add `insertRequirement`)
- Modify: `packages/document-export/src/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5; `loadResumeProfile`, `buildResumeSnapshot`, `schema.jobRequirements`.
- Produces:
  ```ts
  // loadResumeExportContext.ts
  export interface ResumeExportContext { job: { id: string; companyName: string }; optimization: typeof schema.resumeOptimizations.$inferSelect; profile: ResumeProfile }
  export function loadResumeExportContext(db: DbClient, input: { userId: string; jobId: string; optimizationId: string }): Promise<ResumeExportContext>;
  // hash.ts
  export function tailoredContentHash(input: { format: "pdf" | "tex"; paperSize: PaperSize; texVersion: string | null; model: DocumentModel; details: TailoredResumeDetails }): string;
  // storeDocument.ts — StoreDocumentInput gains:
  //   format: StoredDocumentFormat; prerendered?: { buffer: Buffer; contentHash: string; rendererVersion: string }; details?: TailoredResumeDetails | null
  // exportTailoredResume.ts
  export interface ExportTailoredResumeInput { userId: string; jobId: string; optimizationId: string; format: "pdf" | "tex"; paperSize: PaperSize }
  export interface OmittedItemView { sourceType: RankableSourceType; text: string; reason: OmittedItem["reason"] }
  export interface TailoredExportResult { document: GeneratedDocumentRow; omittedItems: OmittedItemView[] }
  export function exportTailoredResume(db: DbClient, storage: Client, compiler: TexCompiler | null, input: ExportTailoredResumeInput): Promise<TailoredExportResult>;
  // testing
  export function insertRequirement(testDb: TestDb, userId: string, jobId: string, termText: string, level: "required" | "preferred"): Promise<void>;
  ```

- [ ] **Step 1: Extract the D84 context loader (refactor; existing exportResume tests guard it)**

Create `packages/document-export/src/pipeline/loadResumeExportContext.ts` containing exactly the job lookup, optimization lookup, repeatable-read snapshot/profile load and the three checks currently in `exportResume` (move the comment about repeatable read with it):

```ts
import { and, eq } from "drizzle-orm";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { buildResumeSnapshot } from "@ai-career/resume-optimization";
import { DocumentExportError } from "../errors";
import type { ResumeProfile } from "../model/resumeProfile";
import { loadResumeProfile } from "./loadResumeProfile";

const { jobs, resumeOptimizations } = schema;

export interface ResumeExportContext {
  job: { id: string; companyName: string };
  optimization: typeof resumeOptimizations.$inferSelect;
  profile: ResumeProfile;
}

/** The D84 checks shared by both resume exports: job 404, source_mismatch, profile_changed, no_profile. */
export async function loadResumeExportContext(
  db: DbClient, input: { userId: string; jobId: string; optimizationId: string }
): Promise<ResumeExportContext> {
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);
  const [job] = await inUserContext((tx) =>
    tx.select({ id: jobs.id, companyName: jobs.companyName }).from(jobs).where(eq(jobs.id, input.jobId)).limit(1)
  );
  if (!job) throw new DocumentExportError("job_not_found");
  const [optimization] = await inUserContext((tx) =>
    tx.select().from(resumeOptimizations)
      .where(and(eq(resumeOptimizations.id, input.optimizationId), eq(resumeOptimizations.jobId, input.jobId))).limit(1)
  );
  if (!optimization) throw new DocumentExportError("source_mismatch");
  // repeatable read: (moved comment from exportResume, unchanged)
  const { snapshot, profile } = await withUserContext(
    db, input.userId,
    async (tx) => ({ snapshot: await buildResumeSnapshot(tx), profile: await loadResumeProfile(tx) }),
    { isolationLevel: "repeatable read" }
  );
  if (snapshot.contentHash !== optimization.sourceProfileContentHash) throw new DocumentExportError("profile_changed");
  if (!profile) throw new DocumentExportError("no_profile");
  return { job, optimization, profile };
}
```

(Copy the full original repeatable-read comment text from `exportResume.ts` in place of the "(moved comment …)" line.)

Rewrite `exportResume` to:

```ts
export async function exportResume(db: DbClient, storage: Client, input: ExportResumeInput): Promise<GeneratedDocumentRow> {
  const { job, optimization, profile } = await loadResumeExportContext(db, input);
  const model = buildResumeModel(profile, optimization.selectedBullets as AppliedBullet[]);
  return storeDocument(db, storage, {
    userId: input.userId,
    jobId: input.jobId,
    kind: "resume",
    format: input.format,
    model,
    resumeOptimizationId: optimization.id,
    applicationPitchId: null,
    downloadFilename: buildDownloadFilename(profile.contact.fullName, job.companyName, "resume", input.format),
  });
}
```

and remove now-unused imports. Run: `pnpm --filter @ai-career/document-export exec vitest run src/pipeline/exportResume.test.ts` → PASS.

- [ ] **Step 2: Failing hash test, then `tailoredContentHash`**

Append to `src/model/hash.test.ts`:

```ts
import { tailoredContentHash } from "./hash";

describe("tailoredContentHash", () => {
  const model = { title: "A", contactLine: null, blocks: [] };
  const details = { pageCount: 1, pageVerified: true, includedCount: 1, totalCount: 1, omitted: [] };
  const base = { format: "pdf" as const, paperSize: "a4" as const, texVersion: "v1", model, details };
  it("changes with format, paper size, TeX version, model and details", () => {
    const h = tailoredContentHash(base);
    expect(tailoredContentHash({ ...base, format: "tex" })).not.toBe(h);
    expect(tailoredContentHash({ ...base, paperSize: "letter" })).not.toBe(h);
    expect(tailoredContentHash({ ...base, texVersion: "v2" })).not.toBe(h);
    expect(tailoredContentHash({ ...base, model: { ...model, title: "B" } })).not.toBe(h);
    expect(tailoredContentHash({ ...base, details: { ...details, pageVerified: false, pageCount: null } })).not.toBe(h);
    expect(tailoredContentHash(base)).toBe(h);
  });
});
```

Run → FAIL. Add to `hash.ts`:

```ts
import { RENDERER_VERSION, TEX_TEMPLATE_VERSION, type DocumentFormat, type DocumentModel, type PaperSize, type TailoredResumeDetails } from "./types";

/** Phase 13c (D210): template version, paper, the compiler's TeX version (PDF only) and the details are part of what the file is. */
export function tailoredContentHash(input: {
  format: "pdf" | "tex"; paperSize: PaperSize; texVersion: string | null; model: DocumentModel; details: TailoredResumeDetails;
}): string {
  return createHash("sha256")
    .update(["tailored", input.format, TEX_TEMPLATE_VERSION, input.paperSize, input.texVersion ?? "", stableStringify({ model: input.model, details: input.details })].join("\n"))
    .digest("hex");
}
```

Run → PASS.

- [ ] **Step 3: `storeDocument` accepts prerendered files and details**

In `storeDocument.ts`:
- import `StoredDocumentFormat`, `DocumentFormat`, `TailoredResumeDetails`;
- `StoreDocumentInput.format: StoredDocumentFormat;` plus
  ```ts
    /** Phase 13c: a file rendered elsewhere (the LaTeX path) with its own content hash; required for format "tex". */
    prerendered?: { buffer: Buffer; contentHash: string; rendererVersion: string };
    details?: TailoredResumeDetails | null;
  ```
- after `assertSafeModel(input.model);`:
  ```ts
  if (input.format === "tex" && !input.prerendered) throw new Error("a tex document must be prerendered");
  const contentHash = input.prerendered?.contentHash ?? modelContentHash(input.model, input.format as DocumentFormat);
  ```
- render: `const buffer = input.prerendered?.buffer ?? (await renderDocument(input.model, input.format as DocumentFormat));`
- insert values: `rendererVersion: input.prerendered?.rendererVersion ?? RENDERER_VERSION, details: input.details ?? null,`.

Run: `pnpm --filter @ai-career/document-export exec vitest run src/pipeline` → existing tests PASS.

- [ ] **Step 4: Test helper for requirements**

Append to `src/testing/db.ts` and export it from `src/testing/index.ts`:

```ts
export async function insertRequirement(
  testDb: TestDb, userId: string, jobId: string, termText: string, level: "required" | "preferred"
): Promise<void> {
  await testDb.adminSql`
    INSERT INTO job_requirements (user_id, job_id, term_text, term_type, requirement_level, extraction_model, extraction_source_description_hash)
    VALUES (${userId}, ${jobId}, ${termText}, 'skill', ${level}, 'm', 'dh')`;
}
```

- [ ] **Step 5: Write the failing pipeline tests**

```ts
// packages/document-export/src/pipeline/exportTailoredResume.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { withUserContext } from "@ai-career/db";
import { buildResumeSnapshot } from "@ai-career/resume-optimization";
import { GENERATED_DOCUMENTS_BUCKET, getGeneratedDocument } from "@ai-career/storage";
import { openTestDb, wipeUser, testStorageClient, seedResumeFixture, insertOptimization, insertRequirement, type TestDb } from "../testing/db";
import { exportTailoredResume } from "./exportTailoredResume";
import { DocumentExportError } from "../errors";
import type { TexCompiler } from "../render/compileTex";

const USER = "00000000-0000-0000-0000-000000000d20";
const storage = testStorageClient();
let testDb: TestDb;

const fakeCompiler = (pages: number[] = [1]) => {
  const calls: string[] = [];
  const compiler: TexCompiler = {
    async compile(tex) { calls.push(tex); return { pdf: Buffer.from(`%PDF fake ${calls.length}`), pageCount: pages.shift() ?? 1, texVersion: "pdfTeX test" }; },
  };
  return { compiler, calls };
};
const failing = (errorClass: "compiler_unavailable" | "compiler_busy" | "compile_failed"): TexCompiler => ({
  async compile() { throw new DocumentExportError(errorClass); },
});

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks);
}

async function seed() {
  const { jobId, goalId } = await seedResumeFixture(testDb, USER);
  await insertRequirement(testDb, USER, jobId, "Python", "required");
  const { contentHash } = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
  const optimizationId = await insertOptimization(testDb, USER, jobId, goalId, [], contentHash);
  return { jobId, optimizationId };
}

beforeAll(async () => { testDb = await openTestDb(); });
afterAll(async () => {
  const keys = await testDb.adminSql`SELECT object_key FROM generated_documents WHERE user_id = ${USER}`;
  for (const { object_key } of keys) await storage.removeObject(GENERATED_DOCUMENTS_BUCKET, object_key).catch(() => {});
  await wipeUser(testDb.adminSql, USER);
  await testDb.close();
});
beforeEach(() => wipeUser(testDb.adminSql, USER));

describe("exportTailoredResume", () => {
  it("refuses a PDF without a compiler before touching the DB", async () => {
    await expect(exportTailoredResume(testDb.db, storage, null, { userId: USER, jobId: "00000000-0000-0000-0000-000000000000", optimizationId: "00000000-0000-0000-0000-000000000000", format: "pdf", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "compiler_unavailable" });
  });

  it("stores a compiled PDF with details and returns omitted item text", async () => {
    const { jobId, optimizationId } = await seed();
    const { compiler, calls } = fakeCompiler([1]);
    const { document, omittedItems } = await exportTailoredResume(testDb.db, storage, compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" });
    expect(document).toMatchObject({ kind: "tailored_resume", format: "pdf", resumeOptimizationId: optimizationId, rendererVersion: "tex-1", downloadFilename: "Jane Doe - GitLab - Resume.pdf" });
    expect(document.details).toEqual({ pageCount: 1, pageVerified: true, includedCount: 2, totalCount: 2, omitted: [] });
    expect(omittedItems).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("\\item Built A");
    expect((await readAll(await getGeneratedDocument(storage, document.objectKey))).toString()).toBe("%PDF fake 1");
  });

  it("stores .tex source; without a compiler it is estimate-only (pageVerified false)", async () => {
    const { jobId, optimizationId } = await seed();
    const { document } = await exportTailoredResume(testDb.db, storage, null, { userId: USER, jobId, optimizationId, format: "tex", paperSize: "letter" });
    expect(document).toMatchObject({ kind: "tailored_resume", format: "tex", downloadFilename: "Jane Doe - GitLab - Resume.tex" });
    expect(document.details).toMatchObject({ pageCount: null, pageVerified: false });
    const tex = (await readAll(await getGeneratedDocument(storage, document.objectKey))).toString("utf8");
    expect(tex).toContain("\\usepackage[letterpaper,margin=0.6in]{geometry}");
    expect(tex).not.toContain("1 Secret Street");
  });

  it("falls back to the estimate for .tex when the configured compiler is down, but not for PDF", async () => {
    const { jobId, optimizationId } = await seed();
    const { document } = await exportTailoredResume(testDb.db, storage, failing("compiler_busy"), { userId: USER, jobId, optimizationId, format: "tex", paperSize: "a4" });
    expect(document.details).toMatchObject({ pageVerified: false });
    await expect(exportTailoredResume(testDb.db, storage, failing("compiler_unavailable"), { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "compiler_unavailable" });
    await expect(exportTailoredResume(testDb.db, storage, failing("compile_failed"), { userId: USER, jobId, optimizationId, format: "tex", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "compile_failed" });
  });

  it("reuses the stored row for an identical export (hash includes details)", async () => {
    const { jobId, optimizationId } = await seed();
    const first = await exportTailoredResume(testDb.db, storage, fakeCompiler().compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" });
    const second = await exportTailoredResume(testDb.db, storage, fakeCompiler().compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" });
    expect(second.document.id).toBe(first.document.id);
  });

  it("refuses an unsupported character with its location, before compiling", async () => {
    // Not seed(): insertOptimization always writes version 1, so a second optimization for the job would collide.
    const { jobId, goalId } = await seedResumeFixture(testDb, USER);
    await testDb.adminSql`UPDATE work_experience_bullets SET text = 'Built 中文 search' WHERE user_id = ${USER} AND text = 'Built B'`;
    const { contentHash } = await withUserContext(testDb.db, USER, (tx) => buildResumeSnapshot(tx));
    const optimizationId = await insertOptimization(testDb, USER, jobId, goalId, [], contentHash);
    const { compiler, calls } = fakeCompiler();
    await expect(exportTailoredResume(testDb.db, storage, compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "unsupported_character", detail: "Experience, entry 1, bullet 2" });
    expect(calls).toHaveLength(0);
  });

  it("keeps the D84 checks (profile_changed)", async () => {
    const { jobId, optimizationId } = await seed();
    await testDb.adminSql`UPDATE work_experience_bullets SET text = 'Changed' WHERE user_id = ${USER} AND text = 'Built A'`;
    await expect(exportTailoredResume(testDb.db, storage, fakeCompiler().compiler, { userId: USER, jobId, optimizationId, format: "pdf", paperSize: "a4" }))
      .rejects.toMatchObject({ errorClass: "profile_changed" });
  });
});
```

Bullet order note for the unsupported-character test: with requirement "Python" neither bullet scores, so bullets render in profile order ("Built A", "Built 中文 search") → bullet 2. If `wipeUser` does not remove `job_requirements`, it is removed by the `jobs` cascade; confirm by reading `wipeUser`.

- [ ] **Step 6: Run to verify failure**

Run: `pnpm --filter @ai-career/document-export exec vitest run src/pipeline/exportTailoredResume.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 7: Implement the pipeline**

```ts
// packages/document-export/src/pipeline/exportTailoredResume.ts
import { eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import type { AppliedBullet } from "@ai-career/resume-optimization";
import {
  TEX_TEMPLATE_VERSION, type DocumentModel, type OmittedItem, type PaperSize, type RankableSourceType, type TailoredResumeDetails,
} from "../model/types";
import type { ResumeProfile } from "../model/resumeProfile";
import { selectTailoredResume, type TailoredSelection } from "../model/selectTailoredResume";
import { normalizeModel } from "../model/normalizeModel";
import { assertSafeModel } from "../model/assertSafeModel";
import { tailoredContentHash } from "../model/hash";
import { buildDownloadFilename } from "../model/filename";
import { findUnsupportedCharacter } from "../render/tex/escapeTex";
import { renderTex } from "../render/tex/renderTex";
import type { TexCompiler } from "../render/compileTex";
import { DocumentExportError, type DocumentExportErrorClass } from "../errors";
import { fitToPage, type FitResult } from "./fitToPage";
import { loadResumeExportContext } from "./loadResumeExportContext";
import { storeDocument, type GeneratedDocumentRow } from "./storeDocument";

const { jobRequirements } = schema;

/** A .tex export survives these (it falls back to the estimate, R5); a PDF export cannot. */
const COMPILER_DOWN: ReadonlySet<DocumentExportErrorClass> = new Set(["compiler_unavailable", "compiler_busy", "compiler_timeout"]);

export interface ExportTailoredResumeInput { userId: string; jobId: string; optimizationId: string; format: "pdf" | "tex"; paperSize: PaperSize }
export interface OmittedItemView { sourceType: RankableSourceType; text: string; reason: OmittedItem["reason"] }
export interface TailoredExportResult { document: GeneratedDocumentRow; omittedItems: OmittedItemView[] }

function omittedText(profile: ResumeProfile, item: OmittedItem): string {
  switch (item.sourceType) {
    case "work_experience_bullet":
      return profile.experiences.flatMap((e) => e.bullets).find((b) => b.id === item.sourceFactId)?.text ?? "";
    case "project": {
      const p = profile.projects.find((x) => x.id === item.sourceFactId);
      return p ? `${p.name}: ${p.description}` : "";
    }
    case "achievement":
      return profile.achievements.find((a) => a.id === item.sourceFactId)?.description ?? "";
  }
}

/** Phase 13c spec §6: checks → select → whitelist → fit (compile loop) → store, both formats through the same fit. */
export async function exportTailoredResume(
  db: DbClient, storage: Client, compiler: TexCompiler | null, input: ExportTailoredResumeInput
): Promise<TailoredExportResult> {
  if (input.format === "pdf" && compiler === null) throw new DocumentExportError("compiler_unavailable");
  const { job, optimization, profile } = await loadResumeExportContext(db, input);
  const requirements = await withUserContext(db, input.userId, (tx) =>
    tx.select({ termText: jobRequirements.termText, requirementLevel: jobRequirements.requirementLevel })
      .from(jobRequirements).where(eq(jobRequirements.jobId, input.jobId))
  );
  const applied = optimization.selectedBullets as AppliedBullet[];
  const build = (extraRemovals: number): TailoredSelection => {
    const selection = selectTailoredResume(profile, applied, requirements, { paperSize: input.paperSize, extraRemovals });
    return { ...selection, model: normalizeModel(selection.model) };
  };

  // Later fits only remove items, so checking the first fit covers every model that can be rendered.
  const first = build(0);
  assertSafeModel(first.model);
  const location = findUnsupportedCharacter(first.model);
  if (location !== null) throw new DocumentExportError("unsupported_character", { detail: location });

  const render = (model: DocumentModel) => renderTex(model, { paperSize: input.paperSize });
  let fit: FitResult;
  try {
    fit = await fitToPage(build, render, compiler);
  } catch (err) {
    if (input.format === "tex" && err instanceof DocumentExportError && COMPILER_DOWN.has(err.errorClass)) fit = await fitToPage(build, render, null);
    else throw err;
  }

  const details: TailoredResumeDetails = {
    pageCount: fit.compiled?.pageCount ?? null,
    pageVerified: fit.compiled !== null,
    includedCount: fit.selection.includedCount,
    totalCount: fit.selection.totalCount,
    omitted: fit.selection.omitted,
  };
  let buffer: Buffer;
  if (input.format === "pdf") {
    if (!fit.compiled) throw new Error("a PDF fit always compiles");
    buffer = fit.compiled.pdf;
  } else {
    buffer = Buffer.from(fit.tex, "utf8");
  }
  const document = await storeDocument(db, storage, {
    userId: input.userId,
    jobId: input.jobId,
    kind: "tailored_resume",
    format: input.format,
    model: fit.selection.model,
    resumeOptimizationId: optimization.id,
    applicationPitchId: null,
    downloadFilename: buildDownloadFilename(profile.contact.fullName, job.companyName, "tailored_resume", input.format),
    prerendered: {
      buffer,
      contentHash: tailoredContentHash({ format: input.format, paperSize: input.paperSize, texVersion: fit.compiled?.texVersion ?? null, model: fit.selection.model, details }),
      rendererVersion: `tex-${TEX_TEMPLATE_VERSION}`,
    },
    details,
  });
  return { document, omittedItems: details.omitted.map((o) => ({ sourceType: o.sourceType, text: omittedText(profile, o), reason: o.reason })) };
}
```

Note: `storeDocument` normalizes the model again; `normalizeModel` is idempotent, so the hash computed here over the normalized model stays consistent.

- [ ] **Step 8: Export from the package index**

Append to `packages/document-export/src/index.ts`:

```ts
export { escapeTex, findUnsupportedCharacter } from "./render/tex/escapeTex";
export { renderTex } from "./render/tex/renderTex";
export { estimateLines, lineBudget, LINE_METRICS } from "./model/estimateLines";
export { selectTailoredResume, type TailoredSelection } from "./model/selectTailoredResume";
export { createHttpTexCompiler, type TexCompiler, type CompiledPdf } from "./render/compileTex";
export { fitToPage, MAX_EXTRA_TRIMS } from "./pipeline/fitToPage";
export {
  exportTailoredResume, type ExportTailoredResumeInput, type OmittedItemView, type TailoredExportResult,
} from "./pipeline/exportTailoredResume";
export { tailoredContentHash } from "./model/hash";
```

(`types.ts` is already re-exported with `export *`, so `PaperSize`, `TailoredResumeDetails`, `StoredDocumentFormat`, `TEX_TEMPLATE_VERSION` are public.)

- [ ] **Step 9: Run the package's tests, typecheck and lint**

Run: `pnpm --filter @ai-career/document-export test && pnpm --filter @ai-career/document-export typecheck && pnpm --filter @ai-career/document-export lint`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/document-export/src
git commit -m "feat(document-export): exportTailoredResume pipeline with prerendered storage (Phase 13c)"
```

---

### Task 7: `services/latex-compiler` (server, compile, limiter) with unit tests

**Files:**
- Create: `services/latex-compiler/package.json`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.ts`
- Create: `services/latex-compiler/src/config.ts`, `parseOutput.ts`, `limiter.ts`, `compile.ts`, `runPdflatex.ts`, `extract.ts`, `texVersion.ts`, `server.ts`, `main.ts`
- Test: `services/latex-compiler/src/{config,parseOutput,limiter,compile,runPdflatex,server}.test.ts`

**Interfaces:**
- Consumes: `createLogger`, `serializeError`, `Logger` from `@ai-career/logging`.
- Produces (HTTP, consumed by Task 5's client and Task 8's test): `GET /health` → `200 {ok:true, texVersion}`; `POST /compile` (bearer) → `200 application/pdf` + `X-Page-Count`, `X-Tex-Version` | `401 {code:"unauthorized"}` | `413 {code:"too_large"}` | `422 {code:"compile_failed", line?}` | `503 {code:"busy"}` | `504 {code:"timeout"}`; `POST /extract` (bearer, test mode only) → `200 text/plain` PDF text.
- Produces (TS):
  ```ts
  export type PdflatexRunner = (workDir: string, timeoutMs: number) => Promise<{ exitCode: number | null; timedOut: boolean; output: string }>;
  export type CompileOutcome = { kind: "ok"; pdf: Buffer; pageCount: number } | { kind: "failed"; line?: number } | { kind: "timeout" };
  export function compileTex(tex: string, runner: PdflatexRunner, opts?: { tmpRoot?: string; timeoutMs?: number }): Promise<CompileOutcome>;
  export function createCompilerServer(deps: ServerDeps): http.Server;
  ```

- [ ] **Step 1: Scaffold the package**

`services/latex-compiler/package.json`:

```json
{
  "name": "@ai-career/latex-compiler",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "tsx src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@ai-career/logging": "workspace:*",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "eslint": "^9.0.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```

Copy `tsconfig.json` and `eslint.config.mjs` verbatim from `services/maintenance-worker/`. `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { testTimeout: 20_000 } });
```

Run: `pnpm install` (adds the workspace package to the lockfile). Expected: success; `pnpm-lock.yaml` changes.

- [ ] **Step 2: Failing tests for config, parseOutput, limiter**

```ts
// services/latex-compiler/src/config.test.ts
import { describe, it, expect } from "vitest";
import { loadCompilerConfig } from "./config";

describe("loadCompilerConfig", () => {
  const token = "x".repeat(32);
  it("reads token, default port and test mode", () => {
    expect(loadCompilerConfig({ LATEX_COMPILER_TOKEN: token })).toEqual({ token, port: 8090, testMode: false });
    expect(loadCompilerConfig({ LATEX_COMPILER_TOKEN: token, PORT: "9000", LATEX_COMPILER_TEST_MODE: "1" })).toEqual({ token, port: 9000, testMode: true });
  });
  it("refuses a missing/short token or bad port", () => {
    expect(() => loadCompilerConfig({})).toThrow(/LATEX_COMPILER_TOKEN/);
    expect(() => loadCompilerConfig({ LATEX_COMPILER_TOKEN: "short" })).toThrow(/LATEX_COMPILER_TOKEN/);
    expect(() => loadCompilerConfig({ LATEX_COMPILER_TOKEN: token, PORT: "abc" })).toThrow(/PORT/);
  });
});
```

```ts
// services/latex-compiler/src/parseOutput.test.ts
import { describe, it, expect } from "vitest";
import { parseErrorLine, parsePageCount } from "./parseOutput";

describe("parseOutput", () => {
  it("reads the page count, singular or plural", () => {
    expect(parsePageCount("...\nOutput written on resume.pdf (1 page, 34567 bytes).\n")).toBe(1);
    expect(parsePageCount("Output written on resume.pdf (2 pages, 50000 bytes).")).toBe(2);
    expect(parsePageCount("No pages of output.")).toBeNull();
  });
  it("reads the file-line-error line number", () => {
    expect(parseErrorLine("./resume.tex:42: Undefined control sequence.")).toBe(42);
    expect(parseErrorLine("! Emergency stop.")).toBeUndefined();
  });
});
```

```ts
// services/latex-compiler/src/limiter.test.ts
import { describe, it, expect } from "vitest";
import { BusyError, createLimiter } from "./limiter";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => (resolve = r)); return { promise, resolve }; };

describe("createLimiter", () => {
  it("runs up to `concurrency` at once, queues up to `maxQueue`, rejects beyond", async () => {
    const limiter = createLimiter({ concurrency: 2, maxQueue: 1 });
    const gates = [deferred(), deferred(), deferred()];
    let running = 0; let peak = 0;
    const job = (i: number) => limiter.run(async () => { running++; peak = Math.max(peak, running); await gates[i].promise; running--; return i; });
    const p0 = job(0), p1 = job(1), p2 = job(2);
    await expect(limiter.run(async () => 9)).rejects.toBeInstanceOf(BusyError);
    gates.forEach((g) => g.resolve());
    expect(await Promise.all([p0, p1, p2])).toEqual([0, 1, 2]);
    expect(peak).toBe(2);
  });
  it("frees the slot when a job throws", async () => {
    const limiter = createLimiter({ concurrency: 1, maxQueue: 0 });
    await expect(limiter.run(async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await limiter.run(async () => 1)).toBe(1);
  });
});
```

Run: `pnpm --filter @ai-career/latex-compiler test` → FAIL (modules not found).

- [ ] **Step 3: Implement config, parseOutput, limiter**

```ts
// services/latex-compiler/src/config.ts
export interface CompilerConfig { token: string; port: number; testMode: boolean }

/** The compiler gets only what it needs from the environment -- never the app's .env (Phase 13c spec §5). */
export function loadCompilerConfig(env: NodeJS.ProcessEnv): CompilerConfig {
  const token = env.LATEX_COMPILER_TOKEN?.trim() ?? "";
  if (token.length < 32) throw new Error("LATEX_COMPILER_TOKEN must be set (at least 32 characters)");
  const port = env.PORT ? Number(env.PORT) : 8090;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
  return { token, port, testMode: env.LATEX_COMPILER_TEST_MODE === "1" };
}
```

```ts
// services/latex-compiler/src/parseOutput.ts
/** pdflatex's final line, e.g. "Output written on resume.pdf (1 page, 34567 bytes)." (max_print_line is raised, so it is never wrapped). */
export function parsePageCount(output: string): number | null {
  const m = /Output written on .*?\((\d+) pages?/s.exec(output);
  return m ? Number(m[1]) : null;
}

/** "-file-line-error" format: "./resume.tex:42: <message>". Only the number leaves this service. */
export function parseErrorLine(output: string): number | undefined {
  const m = /^\.\/resume\.tex:(\d+):/m.exec(output);
  return m ? Number(m[1]) : undefined;
}
```

```ts
// services/latex-compiler/src/limiter.ts
export class BusyError extends Error {
  constructor() {
    super("busy");
    this.name = "BusyError";
  }
}

export interface Limiter { run<T>(fn: () => Promise<T>): Promise<T> }

/** At most `concurrency` jobs at once; up to `maxQueue` wait; beyond that BusyError (→ 503). */
export function createLimiter(opts: { concurrency: number; maxQueue: number }): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active < opts.concurrency) {
        active++;
      } else {
        if (waiting.length >= opts.maxQueue) throw new BusyError();
        await new Promise<void>((resolve) => waiting.push(resolve)); // the finishing job hands its slot over
      }
      try {
        return await fn();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  };
}
```

Run: `pnpm --filter @ai-career/latex-compiler test` → those three files PASS.

- [ ] **Step 4: Failing tests for compile and the real spawn runner**

```ts
// services/latex-compiler/src/compile.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileTex, type PdflatexRunner } from "./compile";

const tmpRoot = async () => mkdtemp(path.join(os.tmpdir(), "compile-test-"));

describe("compileTex", () => {
  it("writes resume.tex, returns the PDF and page count, and removes the work dir", async () => {
    const root = await tmpRoot();
    let seenTex = "";
    const runner: PdflatexRunner = async (dir) => {
      seenTex = await readFile(path.join(dir, "resume.tex"), "utf8");
      await writeFile(path.join(dir, "resume.pdf"), "%PDF");
      return { exitCode: 0, timedOut: false, output: "Output written on resume.pdf (1 page, 4 bytes)." };
    };
    const out = await compileTex("\\documentclass{article}", runner, { tmpRoot: root });
    expect(out).toEqual({ kind: "ok", pdf: Buffer.from("%PDF"), pageCount: 1 });
    expect(seenTex).toBe("\\documentclass{article}");
    expect(await readdir(root)).toEqual([]);
  });
  it("reports failure with only the line number, and timeout", async () => {
    const root = await tmpRoot();
    const failed: PdflatexRunner = async () => ({ exitCode: 1, timedOut: false, output: "./resume.tex:7: Undefined control sequence. SECRET RESUME TEXT" });
    expect(await compileTex("x", failed, { tmpRoot: root })).toEqual({ kind: "failed", line: 7 });
    const slow: PdflatexRunner = async () => ({ exitCode: null, timedOut: true, output: "" });
    expect(await compileTex("x", slow, { tmpRoot: root })).toEqual({ kind: "timeout" });
    expect(await readdir(root)).toEqual([]);
  });
  it("treats exit 0 without an 'Output written' line as a failure", async () => {
    const root = await tmpRoot();
    expect(await compileTex("x", async () => ({ exitCode: 0, timedOut: false, output: "No pages of output." }), { tmpRoot: root })).toEqual({ kind: "failed", line: undefined });
  });
});
```

```ts
// services/latex-compiler/src/runPdflatex.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pdflatexEnv, runPdflatex } from "./runPdflatex";

// A fake `pdflatex` on PATH: the runner's spawn, env, output capture and process-group kill are real.
let binDir: string;
const originalPath = process.env.PATH;
beforeAll(async () => {
  binDir = await mkdtemp(path.join(os.tmpdir(), "fake-pdflatex-"));
  await writeFile(path.join(binDir, "pdflatex"), `#!/bin/sh
if [ -f "$HOME/sleep" ]; then sleep 30 & wait; fi
echo "openin=$openin_any openout=$openout_any out=$TEXMFOUTPUT"
echo "args=$*"
echo "Output written on resume.pdf (1 page, 4 bytes)."
exit 3
`);
  await chmod(path.join(binDir, "pdflatex"), 0o755);
  process.env.PATH = `${binDir}:${originalPath}`;
});
afterAll(() => { process.env.PATH = originalPath; });

describe("runPdflatex", () => {
  it("runs with the paranoid env and safe flags, capturing output and exit code", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "work-"));
    const out = await runPdflatex(dir, 5_000);
    expect(out.exitCode).toBe(3);
    expect(out.timedOut).toBe(false);
    expect(out.output).toContain(`openin=p openout=p out=${dir}`);
    expect(out.output).toContain("args=-no-shell-escape -halt-on-error -interaction=nonstopmode -file-line-error resume.tex");
  });
  it("kills the whole process group on timeout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "work-"));
    // HOME is the work dir (pdflatexEnv passes no other variables), so a marker file switches the fake to "hang".
    await writeFile(path.join(dir, "sleep"), "");
    const started = Date.now();
    const out = await runPdflatex(dir, 200);
    expect(out.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it("passes no other environment through", () => {
    const env = pdflatexEnv("/tmp/w");
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "TEXMFOUTPUT", "TEXMFVAR", "max_print_line", "openin_any", "openout_any", "shell_escape"].sort());
  });
});
```

Run: `pnpm --filter @ai-career/latex-compiler test` → FAIL (modules not found).

- [ ] **Step 5: Implement compile and runPdflatex**

```ts
// services/latex-compiler/src/compile.ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseErrorLine, parsePageCount } from "./parseOutput";

export type PdflatexRunner = (workDir: string, timeoutMs: number) => Promise<{ exitCode: number | null; timedOut: boolean; output: string }>;
export type CompileOutcome = { kind: "ok"; pdf: Buffer; pageCount: number } | { kind: "failed"; line?: number } | { kind: "timeout" };

export const COMPILE_TIMEOUT_MS = 20_000;

/** One pass in a fresh directory that is always removed. pdflatex's log never leaves this function -- only a line number. */
export async function compileTex(tex: string, runner: PdflatexRunner, opts: { tmpRoot?: string; timeoutMs?: number } = {}): Promise<CompileOutcome> {
  const dir = await mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), "tex-"));
  try {
    await writeFile(path.join(dir, "resume.tex"), tex, "utf8");
    const run = await runner(dir, opts.timeoutMs ?? COMPILE_TIMEOUT_MS);
    if (run.timedOut) return { kind: "timeout" };
    const pageCount = parsePageCount(run.output);
    if (run.exitCode !== 0 || pageCount === null) return { kind: "failed", line: parseErrorLine(run.output) };
    return { kind: "ok", pdf: await readFile(path.join(dir, "resume.pdf")), pageCount };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

```ts
// services/latex-compiler/src/runPdflatex.ts
import { spawn } from "node:child_process";
import type { PdflatexRunner } from "./compile";

export const PDFLATEX_ARGS = ["-no-shell-escape", "-halt-on-error", "-interaction=nonstopmode", "-file-line-error", "resume.tex"];
const MAX_OUTPUT_CHARS = 1_000_000;

/** kpathsea paranoid modes: no absolute paths, no "..", no dotfiles for \input/\openout; writes only in the work dir. */
export function pdflatexEnv(workDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: workDir,
    TEXMFOUTPUT: workDir,
    TEXMFVAR: workDir,
    openin_any: "p",
    openout_any: "p",
    shell_escape: "f",
    max_print_line: "10000",
  };
}

export const runPdflatex: PdflatexRunner = (workDir, timeoutMs) =>
  new Promise((resolve, reject) => {
    // detached: its own process group, so the timeout kills pdflatex and anything it started.
    const child = spawn("pdflatex", PDFLATEX_ARGS, { cwd: workDir, env: pdflatexEnv(workDir), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, timedOut, output });
    });
  });
```

Run: `pnpm --filter @ai-career/latex-compiler test` → compile and runPdflatex PASS.

- [ ] **Step 6: Failing server tests**

```ts
// services/latex-compiler/src/server.test.ts
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createCompilerServer, type ServerDeps } from "./server";
import { createLimiter } from "./limiter";
import type { CompileOutcome } from "./compile";

const TOKEN = "k".repeat(32);
const lines: string[] = [];
const logger = { debug() {}, info: (e: string, f?: object) => lines.push(JSON.stringify({ e, ...f })), warn: (e: string, f?: object) => lines.push(JSON.stringify({ e, ...f })), error: (e: string, f?: object) => lines.push(JSON.stringify({ e, ...f })) };
let server: http.Server | undefined;

async function start(over: Partial<ServerDeps> = {}): Promise<string> {
  server = createCompilerServer({
    token: TOKEN, texVersion: "pdfTeX test", logger, limiter: createLimiter({ concurrency: 2, maxQueue: 4 }),
    compile: async (): Promise<CompileOutcome> => ({ kind: "ok", pdf: Buffer.from("%PDF"), pageCount: 1 }),
    ...over,
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  lines.length = 0;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});
const post = (base: string, p: string, body: string | Buffer, token = TOKEN) =>
  fetch(`${base}${p}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body });

describe("latex-compiler server", () => {
  it("reports health with the TeX version", async () => {
    const base = await start();
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, texVersion: "pdfTeX test" });
  });
  it("compiles: 200 PDF with page count and version headers", async () => {
    const base = await start();
    const res = await post(base, "/compile", "\\documentclass{article}");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-page-count")).toBe("1");
    expect(res.headers.get("x-tex-version")).toBe("pdfTeX test");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF");
  });
  it("rejects a missing or wrong token with 401", async () => {
    const base = await start();
    expect((await post(base, "/compile", "x", "wrong")).status).toBe(401);
    expect((await fetch(`${base}/compile`, { method: "POST", body: "x" })).status).toBe(401);
  });
  it("rejects a body over 256 KB with 413", async () => {
    const base = await start();
    const res = await post(base, "/compile", "x".repeat(256 * 1024 + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: "too_large" });
  });
  it("maps failed/timeout/busy, never echoing compiler or document text, and logs no content", async () => {
    const failedBase = await start({ compile: async () => ({ kind: "failed", line: 9 }) });
    const failed = await post(failedBase, "/compile", "SECRET-TEXT");
    expect(failed.status).toBe(422);
    expect(await failed.json()).toEqual({ code: "compile_failed", line: 9 });
    expect(lines.join("\n")).not.toContain("SECRET-TEXT");
    await new Promise<void>((r) => server!.close(() => r()));

    const slowBase = await start({ compile: async () => ({ kind: "timeout" }) });
    expect((await post(slowBase, "/compile", "x")).status).toBe(504);
    await new Promise<void>((r) => server!.close(() => r()));

    const busyBase = await start({ limiter: createLimiter({ concurrency: 0, maxQueue: 0 }) });
    const busy = await post(busyBase, "/compile", "x");
    expect(busy.status).toBe(503);
    expect(await busy.json()).toEqual({ code: "busy" });
  });
  it("exposes /extract only in test mode", async () => {
    const base = await start();
    expect((await post(base, "/extract", "%PDF")).status).toBe(404);
    await new Promise<void>((r) => server!.close(() => r()));
    const testBase = await start({ extract: async (pdf) => `text of ${pdf.length} bytes` });
    const res = await post(testBase, "/extract", "%PDF");
    expect(await res.text()).toBe("text of 4 bytes");
  });
  it("404s unknown routes", async () => {
    const base = await start();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
```

Run → FAIL (module not found).

- [ ] **Step 7: Implement server, extract, texVersion, main**

```ts
// services/latex-compiler/src/server.ts
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { serializeError, type Logger } from "@ai-career/logging";
import { BusyError, type Limiter } from "./limiter";
import type { CompileOutcome } from "./compile";

export const MAX_TEX_BYTES = 256 * 1024;
export const MAX_EXTRACT_BYTES = 4 * 1024 * 1024;

export interface ServerDeps {
  token: string;
  texVersion: string;
  compile: (tex: string) => Promise<CompileOutcome>;
  limiter: Limiter;
  logger: Logger;
  /** Set only when LATEX_COMPILER_TEST_MODE=1 (integration tests read the PDF's text through it). */
  extract?: (pdf: Buffer) => Promise<string>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** The body, or null when it exceeds `max` (the rest is drained, not buffered). */
function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "http://compiler");
  if (req.method === "GET" && pathname === "/health") return sendJson(res, 200, { ok: true, texVersion: deps.texVersion });
  const isCompile = req.method === "POST" && pathname === "/compile";
  const isExtract = req.method === "POST" && pathname === "/extract" && deps.extract !== undefined;
  if (!isCompile && !isExtract) return sendJson(res, 404, { code: "not_found" });
  if (!authorized(req.headers.authorization, deps.token)) {
    req.resume();
    return sendJson(res, 401, { code: "unauthorized" });
  }
  const body = await readBody(req, isExtract ? MAX_EXTRACT_BYTES : MAX_TEX_BYTES);
  if (body === null) {
    res.setHeader("Connection", "close");
    return sendJson(res, 413, { code: "too_large" });
  }
  if (isExtract) {
    const text = await deps.extract!(body);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
    return;
  }

  const requestId = randomUUID();
  const started = Date.now();
  let outcome: CompileOutcome;
  try {
    outcome = await deps.limiter.run(() => deps.compile(body.toString("utf8")));
  } catch (err) {
    if (err instanceof BusyError) {
      deps.logger.warn("latex_compiler.busy", { requestId, bytes: body.length });
      return sendJson(res, 503, { code: "busy" });
    }
    throw err;
  }
  // Sizes, timings and outcomes only -- never the .tex or pdflatex's log (CLAUDE.md §9).
  deps.logger.info("latex_compiler.compile", {
    requestId, bytes: body.length, durationMs: Date.now() - started, outcome: outcome.kind,
    ...(outcome.kind === "ok" ? { pageCount: outcome.pageCount } : {}),
    ...(outcome.kind === "failed" && outcome.line !== undefined ? { line: outcome.line } : {}),
  });
  switch (outcome.kind) {
    case "ok":
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": outcome.pdf.length,
        "X-Page-Count": String(outcome.pageCount),
        "X-Tex-Version": deps.texVersion,
      });
      res.end(outcome.pdf);
      return;
    case "failed":
      return sendJson(res, 422, outcome.line !== undefined ? { code: "compile_failed", line: outcome.line } : { code: "compile_failed" });
    case "timeout":
      return sendJson(res, 504, { code: "timeout" });
  }
}

export function createCompilerServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      deps.logger.error("latex_compiler.unhandled", { error: serializeError(err) });
      if (!res.headersSent) sendJson(res, 500, { code: "internal" });
      else res.destroy();
    });
  });
}
```

```ts
// services/latex-compiler/src/extract.ts
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Test mode only: the PDF's text layer, as an ATS would read it. */
export async function extractPdfText(pdf: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "extract-"));
  try {
    await writeFile(path.join(dir, "in.pdf"), pdf);
    const { stdout } = await execFileAsync("pdftotext", ["-layout", "-enc", "UTF-8", "in.pdf", "-"], { cwd: dir, timeout: 10_000, maxBuffer: 5_000_000 });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

```ts
// services/latex-compiler/src/texVersion.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** First line of `pdflatex --version`, e.g. "pdfTeX 3.141592653-2.6-1.40.24 (TeX Live 2022/Debian)" (ASCII; sent as a header). */
export async function readTexVersion(): Promise<string> {
  const { stdout } = await execFileAsync("pdflatex", ["--version"], { timeout: 10_000 });
  return stdout.split("\n")[0].trim().replace(/[^\x20-\x7e]/g, "");
}
```

```ts
// services/latex-compiler/src/main.ts
import { createLogger, serializeError } from "@ai-career/logging";
import { loadCompilerConfig } from "./config";
import { compileTex } from "./compile";
import { runPdflatex } from "./runPdflatex";
import { createLimiter } from "./limiter";
import { createCompilerServer } from "./server";
import { extractPdfText } from "./extract";
import { readTexVersion } from "./texVersion";

const log = createLogger({ service: "latex-compiler" });

async function main(): Promise<void> {
  const config = loadCompilerConfig(process.env);
  const texVersion = await readTexVersion();
  const server = createCompilerServer({
    token: config.token,
    texVersion,
    compile: (tex) => compileTex(tex, runPdflatex),
    limiter: createLimiter({ concurrency: 2, maxQueue: 4 }),
    logger: log,
    ...(config.testMode ? { extract: extractPdfText } : {}),
  });
  server.listen(config.port, "0.0.0.0", () => log.info("latex_compiler.started", { port: config.port, texVersion, testMode: config.testMode }));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((err) => {
  log.error("latex_compiler.start_failed", { error: serializeError(err) });
  process.exit(1);
});
```

- [ ] **Step 8: Run tests, typecheck, lint**

Run: `pnpm --filter @ai-career/latex-compiler test && pnpm --filter @ai-career/latex-compiler typecheck && pnpm --filter @ai-career/latex-compiler lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add services/latex-compiler pnpm-lock.yaml
git commit -m "feat(latex-compiler): sandboxed pdflatex HTTP service with limits and no-content logging (Phase 13c)"
```

---

### Task 8: Docker image, compose service, CI, and the real-compile integration test

**Files:**
- Create: `services/latex-compiler/Dockerfile`
- Modify: `infra/docker-compose.yml`
- Modify: `.github/workflows/ci.yml`
- Modify: `packages/document-export/package.json` (script `test:latex`), `packages/document-export/vitest.config.ts` if it exists (exclude the integration file from the default run — see Step 4)
- Create: `packages/document-export/src/latex.integration.test.ts`
- Modify (calibration only, if needed): `packages/document-export/src/model/estimateLines.ts`, `render/tex/escapeTex.ts`

**Interfaces:**
- Consumes: the service (Task 7); `createHttpTexCompiler`, `renderTex`, `selectTailoredResume`, `estimateLines`, `lineBudget`, `SUPPORTED_SAMPLE` (Tasks 2–5).
- Produces: image `careerpilot-latex-compiler`; compose service `latex-compiler` (profile `latex`, `127.0.0.1:8090`); CI step running `pnpm --filter @ai-career/document-export test:latex`.

- [ ] **Step 1: Dockerfile**

```dockerfile
# LaTeX compiler sidecar (Phase 13c, DECISIONS.md D209). Build from the repo root -- the context must be the pnpm workspace:
#   docker build -f services/latex-compiler/Dockerfile -t careerpilot-latex-compiler .
# Same two-stage pattern as services/maintenance-worker (D125), plus Debian's TeX Live packages and poppler-utils
# (pdftotext, used only by the test-mode /extract endpoint).
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @ai-career/latex-compiler... \
 && pnpm --filter @ai-career/latex-compiler deploy --prod /out

FROM ${NODE_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended lmodern poppler-utils \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8090
# Configuration comes from the environment only: LATEX_COMPILER_TOKEN (required), PORT, LATEX_COMPILER_TEST_MODE.
CMD ["node_modules/.bin/tsx", "src/main.ts"]
```

Build locally: `docker build -f services/latex-compiler/Dockerfile -t careerpilot-latex-compiler .`
Expected: success. Then `docker run --rm careerpilot-latex-compiler pdflatex --version | head -1` prints a pdfTeX version line. Record the image size (`docker image ls careerpilot-latex-compiler`) in the task report.

- [ ] **Step 2: Compose service (R1: default network, localhost-only port)**

Add to `infra/docker-compose.yml` under `services:` after `maintenance-worker`:

```yaml
  # Opt-in: `docker compose -f infra/docker-compose.yml --env-file .env --profile latex up -d latex-compiler`
  # (from the repo root). pdflatex sandbox for the tailored LaTeX resume (Phase 13c, DECISIONS.md D209).
  # Only LATEX_COMPILER_TOKEN is passed in -- never the app's .env. Published on localhost only. Not on an
  # `internal: true` network: Docker does not publish ports for such containers, and the host-run web app must
  # reach it; pdflatex runs without shell-escape, so it has no way to open a network connection (R1).
  latex-compiler:
    profiles: ["latex"]
    build:
      context: ..
      dockerfile: services/latex-compiler/Dockerfile
    image: careerpilot-latex-compiler
    restart: unless-stopped
    environment:
      LATEX_COMPILER_TOKEN: ${LATEX_COMPILER_TOKEN:-}
    ports:
      - "127.0.0.1:8090:8090"
    read_only: true
    tmpfs:
      - /tmp:size=64m
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    mem_limit: 512m
    cpus: 1
    pids_limit: 64
```

(`${LATEX_COMPILER_TOKEN:-}` keeps `docker compose up` for the other services working when the variable is unset; the service itself refuses to start without a ≥ 32-char token.)

- [ ] **Step 3: Verify the sandbox by hand**

```bash
grep -q '^LATEX_COMPILER_TOKEN=' .env || echo "LATEX_COMPILER_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose -f infra/docker-compose.yml --env-file .env --profile latex up -d --build latex-compiler
curl -sf http://127.0.0.1:8090/health
docker compose -f infra/docker-compose.yml --env-file .env exec latex-compiler sh -c 'touch /app/x' ; echo "exit=$?"   # expect non-zero (read-only)
docker compose -f infra/docker-compose.yml --env-file .env exec latex-compiler id -u                                  # expect non-zero uid
```

Expected: health JSON with `texVersion`; the `touch` fails (read-only filesystem); uid is not 0. Paste the outputs into the task report. (`.env` is git-ignored; never commit it.)

- [ ] **Step 4: Keep the integration test out of the default test run**

Add to `packages/document-export/package.json` scripts: `"test:latex": "vitest run src/latex.integration.test.ts"`. The integration test file skips itself when `LATEX_COMPILER_URL` is unset (Step 5), so the default `vitest run` stays green without the compiler; no config exclusion is needed.

- [ ] **Step 5: Write the integration test**

```ts
// packages/document-export/src/latex.integration.test.ts
// Real pdflatex via services/latex-compiler (Phase 13c spec §8). Runs only when LATEX_COMPILER_URL and
// LATEX_COMPILER_TOKEN are set and the service runs with LATEX_COMPILER_TEST_MODE=1 (CI does this; locally see docs/development.md).
import { describe, it, expect } from "vitest";
import { createHttpTexCompiler } from "./render/compileTex";
import { renderTex } from "./render/tex/renderTex";
import { SUPPORTED_SAMPLE } from "./render/tex/escapeTex";
import { selectTailoredResume } from "./model/selectTailoredResume";
import { estimateLines, lineBudget } from "./model/estimateLines";
import type { ResumeProfile } from "./model/resumeProfile";
import type { DocumentModel, PaperSize } from "./model/types";

const url = process.env.LATEX_COMPILER_URL;
const token = process.env.LATEX_COMPILER_TOKEN;
const enabled = Boolean(url && token);
const compiler = enabled ? createHttpTexCompiler({ url: url!, token: token! }) : null;

async function extract(pdf: Buffer): Promise<string> {
  const res = await fetch(new URL("/extract", url!), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: pdf });
  expect(res.status).toBe(200);
  return res.text();
}
const squash = (s: string) => s.replace(/\s+/g, " ");

const injection = "\\input{/etc/passwd} \\write18{id} \\catcode`\\@=11 {braces} 50% $5 & #1 a_b ^ ~ [Remote] a--b it''s ,,x <<y>>";
const profile: ResumeProfile = {
  contact: { fullName: "Jürgen Müller", email: "j@example.com", phoneNumber: "+49 30 1234", linkedinUrl: "linkedin.com/in/jm" },
  experiences: [
    { id: "e1", company: "Globex", title: "Senior Engineer", location: "Berlin", startDate: "2021", endDate: null,
      bullets: [{ id: "b1", text: "Built C++, C# and .NET services – 40% faster" }, { id: "b2", text: injection }] },
  ],
  achievements: [],
  projects: [],
  certifications: [],
  education: [{ id: "ed1", institution: "TU Berlin", degree: "MSc", fieldOfStudy: "Informatik", startDate: "2015", endDate: "2017", gpa: null }],
  skills: [{ id: "s1", name: "Python" }, { id: "s2", name: "Kafka" }],
  verifiedSkills: [],
};

describe.skipIf(!enabled)("real pdflatex compile", () => {
  it("compiles a resume to one page whose text layer reads in order with exact characters", async () => {
    const { model } = selectTailoredResume(profile, [], [{ termText: "Kafka", requirementLevel: "required" }], { paperSize: "a4" });
    const out = await compiler!.compile(renderTex(model, { paperSize: "a4" }));
    expect(out.pageCount).toBe(1);
    const text = squash(await extract(out.pdf));
    const order = ["Jürgen Müller", "Experience", "Senior Engineer", "Globex", "Education", "Skills", "Kafka"].map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("C++, C# and .NET services – 40% faster");
  });

  it("typesets TeX-looking text literally (no injection)", async () => {
    const model: DocumentModel = { title: "A", contactLine: null, blocks: [{ type: "heading", text: "Experience" }, { type: "bullets", items: [injection] }] };
    const out = await compiler!.compile(renderTex(model, { paperSize: "a4" }));
    expect(squash(await extract(out.pdf))).toContain(squash(injection));
  });

  it("compiles every whitelisted character (whitelist is honest)", async () => {
    const model: DocumentModel = { title: "Sample", contactLine: null, blocks: [{ type: "paragraph", text: SUPPORTED_SAMPLE }] };
    await expect(compiler!.compile(renderTex(model, { paperSize: "a4" }))).resolves.toMatchObject({ pageCount: 1 });
  });

  it.each(["a4", "letter"] as PaperSize[])("estimate calibration (%s): at budget fits one page; well over budget does not", async (paperSize) => {
    const bullet = "Designed and shipped a streaming ingestion service in Python and Kafka, cutting latency by 40% for 2M daily events";
    const modelWith = (n: number): DocumentModel => ({
      title: "Jane Doe", contactLine: "jane@example.com",
      blocks: [{ type: "heading", text: "Experience" }, { type: "entry", title: "Engineer", subtitle: "Globex", meta: "2021 – present" }, { type: "bullets", items: Array.from({ length: n }, () => bullet) }],
    });
    let n = 1;
    while (estimateLines(modelWith(n + 1), paperSize) <= lineBudget(paperSize)) n++;
    const atBudget = await compiler!.compile(renderTex(modelWith(n), { paperSize }));
    expect(atBudget.pageCount).toBe(1);
    let over = n;
    while (estimateLines(modelWith(over), paperSize) < lineBudget(paperSize) + 12) over++;
    const overBudget = await compiler!.compile(renderTex(modelWith(over), { paperSize }));
    expect(overBudget.pageCount).toBe(2);
  });
});
```

- [ ] **Step 6: Run against the local container and calibrate**

Restart the container in test mode and run:

```bash
docker compose -f infra/docker-compose.yml --env-file .env --profile latex stop latex-compiler
docker compose -f infra/docker-compose.yml --env-file .env --profile latex run -d --rm --service-ports -e LATEX_COMPILER_TEST_MODE=1 --name latex-compiler-test latex-compiler
export LATEX_COMPILER_TOKEN="$(grep '^LATEX_COMPILER_TOKEN=' .env | cut -d= -f2-)"
LATEX_COMPILER_URL=http://127.0.0.1:8090 pnpm --filter @ai-career/document-export test:latex
```

Expected: 5 tests PASS. If they fail:
- **whitelist test fails** (pdflatex: `Unicode character … not set up for use with LaTeX`): add that code point to `UNSUPPORTED_LATIN` in `escapeTex.ts` (and to the `isSupportedChar` rejects test), rerun Task 2's unit tests and this test.
- **calibration "at budget" gives 2 pages**: lower `linesPerPage` (or raise `PAGE_SAFETY_LINES`) for that paper size in `estimateLines.ts` by the smallest amount that passes; **"over budget" gives 1 page**: raise `linesPerPage` / `charsPer*`. Rerun Task 3/4 unit tests (`estimateLines.test.ts` uses the exported constants, so it adapts). Record the final values in the task report.
- **text order/characters**: inspect `await extract(...)` output (do not commit it), fix `renderTex`.

Stop the test container: `docker stop latex-compiler-test`.

- [ ] **Step 7: CI**

In `.github/workflows/ci.yml`, after the "Build the maintenance-worker image" step, add:

```yaml
      - name: Build the latex-compiler image and run the real-compile tests (Phase 13c, DECISIONS.md D209)
        # Proves the image builds, pdflatex can typeset every whitelisted character, TeX-looking text stays literal,
        # and the one-page estimate is calibrated. Test mode enables /extract (pdftotext) for the text-layer checks.
        env:
          LATEX_COMPILER_TOKEN: ci-latex-token-0123456789abcdef0123456789
          LATEX_COMPILER_URL: http://127.0.0.1:8090
        run: |
          for attempt in 1 2 3; do
            if docker build -f services/latex-compiler/Dockerfile -t careerpilot-latex-compiler .; then break; fi
            if [ "$attempt" = 3 ]; then echo "docker build failed 3 times" >&2; exit 1; fi
            echo "docker build failed (attempt $attempt), retrying in 15s" >&2; sleep 15
          done
          if docker run --rm careerpilot-latex-compiler sh -c 'find / -name .env -not -path "/proc/*" 2>/dev/null' | grep -q .; then
            echo "A .env file was baked into the image" >&2; exit 1
          fi
          docker run -d --name latex-compiler -p 127.0.0.1:8090:8090 --read-only --tmpfs /tmp:size=64m \
            --cap-drop ALL --security-opt no-new-privileges:true --memory 512m --pids-limit 64 \
            -e LATEX_COMPILER_TOKEN -e LATEX_COMPILER_TEST_MODE=1 careerpilot-latex-compiler
          for i in $(seq 1 30); do curl -sf http://127.0.0.1:8090/health && break; sleep 1; done
          pnpm --filter @ai-career/document-export test:latex || { docker logs latex-compiler; exit 1; }
```

- [ ] **Step 8: Full package checks**

Run: `pnpm --filter @ai-career/document-export test && pnpm --filter @ai-career/document-export typecheck && pnpm --filter @ai-career/document-export lint`
Expected: PASS (integration file skipped without `LATEX_COMPILER_URL`).

- [ ] **Step 9: Commit**

```bash
git add services/latex-compiler/Dockerfile infra/docker-compose.yml .github/workflows/ci.yml packages/document-export/package.json packages/document-export/src/latex.integration.test.ts packages/document-export/src/model/estimateLines.ts packages/document-export/src/render/tex/escapeTex.ts packages/document-export/src/render/tex/escapeTex.test.ts
git commit -m "feat(latex-compiler): Docker image, compose profile, CI real-compile tests and estimate calibration (Phase 13c)"
```

---

### Task 9: Web API — env, export route, errors, download, views

**Files:**
- Modify: `packages/config/src/env.ts`, `packages/config/src/env.test.ts`
- Create: `apps/web/src/lib/documents/texCompiler.ts`, `texCompiler.test.ts`
- Modify: `apps/web/src/lib/documents/exportErrors.ts`
- Modify: `apps/web/src/lib/documents/serializeDocument.ts`, `serializeDocument.test.ts`
- Modify: `apps/web/src/app/api/documents/route.ts`
- Create: `apps/web/src/app/api/documents/route.tailored.test.ts`
- Modify: `apps/web/src/app/api/documents/[id]/download/route.ts`, `route.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `exportTailoredResume`, `createHttpTexCompiler`, `TexCompiler`, `TailoredResumeDetails`, `OmittedItemView`, `DocumentExportError` (Tasks 1, 5, 6).
- Produces:
  - env: `LATEX_COMPILER_URL?: string`, `LATEX_COMPILER_TOKEN?: string`, `RESUME_PAPER_SIZE: "a4" | "letter"` (default `"a4"`).
  - `texCompilerFromEnv(env): TexCompiler | null`.
  - `DocumentView` gains `kind: … | "tailored_resume"`, `format: "pdf" | "docx" | "tex"`, `details: TailoredResumeDetails | null`.
  - `POST /api/documents` body accepts `kind: "tailored_resume"` with `format: "pdf" | "tex"`; response `{ document: DocumentView, omittedItems?: OmittedItemView[] }`.
  - `CONTENT_TYPES.tex = "application/x-tex; charset=utf-8"`.

- [ ] **Step 1: Env schema (test first)**

Append to `packages/config/src/env.test.ts`:

```ts
  it("parses the optional LaTeX compiler settings and defaults the paper size to a4", () => {
    const env = loadEnv(validSource);
    expect(env.LATEX_COMPILER_URL).toBeUndefined();
    expect(env.RESUME_PAPER_SIZE).toBe("a4");
    const set = loadEnv({ ...validSource, LATEX_COMPILER_URL: "http://127.0.0.1:8090", LATEX_COMPILER_TOKEN: "t".repeat(32), RESUME_PAPER_SIZE: "letter" });
    expect(set).toMatchObject({ LATEX_COMPILER_URL: "http://127.0.0.1:8090", LATEX_COMPILER_TOKEN: "t".repeat(32), RESUME_PAPER_SIZE: "letter" });
    expect(loadEnv({ ...validSource, LATEX_COMPILER_URL: "", RESUME_PAPER_SIZE: "" }).RESUME_PAPER_SIZE).toBe("a4");
    expect(() => loadEnv({ ...validSource, LATEX_COMPILER_TOKEN: "short" })).toThrow(/LATEX_COMPILER_TOKEN/);
    expect(() => loadEnv({ ...validSource, RESUME_PAPER_SIZE: "a3" })).toThrow(/RESUME_PAPER_SIZE/);
  });
```

Run: `pnpm --filter @ai-career/config test` → FAIL. Add to the schema object in `env.ts` (next to the other optional settings):

```ts
    // Phase 13c: the LaTeX compiler sidecar (services/latex-compiler). Unset → tailored PDF export answers 503.
    LATEX_COMPILER_URL: z.preprocess(blankAsUnset, z.string().url().regex(/^https?:\/\//i, "must be an http(s) URL").optional()),
    LATEX_COMPILER_TOKEN: z.preprocess(blankAsUnset, z.string().min(32, "must be at least 32 characters").optional()),
    RESUME_PAPER_SIZE: z.preprocess(blankAsUnset, z.enum(["a4", "letter"]).default("a4")),
```

Run → PASS. (If the error message format does not include the variable name, match whatever the existing "readable message" test asserts — read that test first.)

- [ ] **Step 2: `texCompilerFromEnv` (test first)**

```ts
// apps/web/src/lib/documents/texCompiler.test.ts
import { describe, it, expect } from "vitest";
import { texCompilerFromEnv } from "./texCompiler";

describe("texCompilerFromEnv", () => {
  it("is null unless both URL and token are set", () => {
    expect(texCompilerFromEnv({})).toBeNull();
    expect(texCompilerFromEnv({ LATEX_COMPILER_URL: "http://127.0.0.1:8090" })).toBeNull();
    expect(texCompilerFromEnv({ LATEX_COMPILER_TOKEN: "t".repeat(32) })).toBeNull();
    expect(texCompilerFromEnv({ LATEX_COMPILER_URL: "http://127.0.0.1:8090", LATEX_COMPILER_TOKEN: "t".repeat(32) })).not.toBeNull();
  });
});
```

```ts
// apps/web/src/lib/documents/texCompiler.ts
import { createHttpTexCompiler, type TexCompiler } from "@ai-career/document-export";

/** The compiler the export route uses; null (→ PDF 503, .tex estimate-only) when it is not configured. */
export function texCompilerFromEnv(env: { LATEX_COMPILER_URL?: string; LATEX_COMPILER_TOKEN?: string }): TexCompiler | null {
  if (!env.LATEX_COMPILER_URL || !env.LATEX_COMPILER_TOKEN) return null;
  return createHttpTexCompiler({ url: env.LATEX_COMPILER_URL, token: env.LATEX_COMPILER_TOKEN });
}
```

Run: `pnpm --filter @ai-career/web exec vitest run src/lib/documents/texCompiler.test.ts` → PASS.

- [ ] **Step 3: Error responses**

Replace `RESPONSES` and `exportErrorResponse` in `exportErrors.ts`:

```ts
export const COMPILER_START_COMMAND = "docker compose -f infra/docker-compose.yml --env-file .env --profile latex up -d latex-compiler";

const RESPONSES: Record<DocumentExportError["errorClass"], [number, string]> = {
  job_not_found: [404, "Job not found"],
  source_mismatch: [400, "That version does not belong to this job"],
  profile_changed: [409, "Your profile changed since this optimization. Regenerate it first."],
  pitch_unsupported: [409, "This pitch has an unsupported bullet. Edit or regenerate it first."],
  cover_letter_unsupported: [409, "This cover letter has an unsupported paragraph. Edit or regenerate it first."],
  no_profile: [409, "Confirm your profile first"],
  storage_unavailable: [502, "Document storage is unavailable. Try again."],
  invalid_content: [500, "The document could not be generated."],
  compiler_unavailable: [503, `The LaTeX compiler isn't running. Start it with: ${COMPILER_START_COMMAND}`],
  compiler_busy: [503, "The LaTeX compiler is busy. Try again in a moment."],
  compiler_timeout: [504, "The LaTeX compiler took too long. Try again."],
  compile_failed: [502, "The resume could not be typeset. This is a bug; the compiler log has the line number."],
  unsupported_character: [422, "Your profile contains a character the LaTeX resume can't typeset"],
};

export function exportErrorResponse(error: DocumentExportError): NextResponse {
  const [status, message] = RESPONSES[error.errorClass];
  const text = error.errorClass === "unsupported_character" && error.detail ? `${message} (${error.detail}). Edit your profile to remove it.` : message;
  return NextResponse.json({ error: text }, { status });
}
```

- [ ] **Step 4: Document view and content types**

In `serializeDocument.ts`:

```ts
import type { GeneratedDocumentRow, TailoredResumeDetails } from "@ai-career/document-export";

export interface DocumentView {
  id: string;
  kind: "resume" | "pitch" | "cover_letter" | "interview_prep" | "tailored_resume";
  format: "pdf" | "docx" | "tex";
  sourceVersion: number | null;
  downloadFilename: string;
  byteSize: number;
  createdAt: string;
  downloadUrl: string;
  /** Phase 13c: tailored_resume only. */
  details: TailoredResumeDetails | null;
}
```

In `toDocumentView` add `details: (row.details as TailoredResumeDetails | null) ?? null,` and:

```ts
export const CONTENT_TYPES: Record<"pdf" | "docx" | "tex", string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  tex: "application/x-tex; charset=utf-8",
};
```

Update `serializeDocument.test.ts`'s expected view objects with `details: null` (and add one tailored row case asserting `details` passes through and `CONTENT_TYPES.tex`). Run `pnpm --filter @ai-career/web exec vitest run src/lib/documents` → PASS. Add a download test in `app/api/documents/[id]/download/route.test.ts` that inserts a `tailored_resume`/`tex` row (admin SQL, object uploaded with `uploadGeneratedDocument(..., extension: "tex")`) and asserts `Content-Type: application/x-tex; charset=utf-8` — follow the existing PDF download test in that file exactly, changing only kind/format/extension and the expected header. The download route itself needs no code change beyond `CONTENT_TYPES` (it indexes by `doc.format`).

- [ ] **Step 5: Failing tailored route tests**

```ts
// apps/web/src/app/api/documents/route.tailored.test.ts
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type postgres from "postgres";
import { openAdminDb } from "../../../test/jobsDb";
import { seedResumeExport, wipeDocumentsUser } from "../../../test/documentsDb";

const USER = "00000000-0000-0000-0000-000000000d21";
const TOKEN = "z".repeat(32);
const envState = vi.hoisted(() => ({ compilerUrl: undefined as string | undefined }));

vi.mock("@ai-career/config", () => ({
  loadEnv: () => ({
    DEFAULT_USER_ID: "00000000-0000-0000-0000-000000000d21",
    DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test",
    MINIO_ENDPOINT: "http://localhost:9000",
    MINIO_ACCESS_KEY: "minioadmin",
    MINIO_SECRET_KEY: "minioadmin",
    RESUME_PAPER_SIZE: "a4",
    LATEX_COMPILER_URL: envState.compilerUrl,
    LATEX_COMPILER_TOKEN: envState.compilerUrl ? "z".repeat(32) : undefined,
  }),
}));

let admin: postgres.Sql;
let fake: http.Server | undefined;
const seen: { auth?: string; body?: string }[] = [];

async function startFakeCompiler(status = 200): Promise<void> {
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      if (status !== 200) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: "x", line: 3 })); return; }
      res.writeHead(200, { "Content-Type": "application/pdf", "X-Page-Count": "1", "X-Tex-Version": "pdfTeX fake" });
      res.end("%PDF-fake");
    });
  });
  await new Promise<void>((r) => fake!.listen(0, "127.0.0.1", r));
  envState.compilerUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
}

beforeAll(async () => { admin = await openAdminDb(); });
beforeEach(() => wipeDocumentsUser(admin, USER));
afterEach(async () => {
  envState.compilerUrl = undefined;
  seen.length = 0;
  await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
  fake = undefined;
});
afterAll(async () => { await wipeDocumentsUser(admin, USER); await admin.end(); });

const { POST } = await import("./route");
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/documents", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));

describe("POST /api/documents — tailored_resume", () => {
  it("rejects tex for other kinds and docx for tailored_resume (400)", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    expect((await post({ kind: "resume", jobId, sourceId: optimizationId, format: "tex" })).status).toBe(400);
    expect((await post({ kind: "tailored_resume", jobId, sourceId: optimizationId, format: "docx" })).status).toBe(400);
  });

  it("returns 503 with the start command for a PDF when no compiler is configured", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await post({ kind: "tailored_resume", jobId, sourceId: optimizationId, format: "pdf" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("--profile latex up -d latex-compiler");
  });

  it("exports .tex without a compiler (201, page count not verified)", async () => {
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await post({ kind: "tailored_resume", jobId, sourceId: optimizationId, format: "tex" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.document).toMatchObject({ kind: "tailored_resume", format: "tex", sourceVersion: 2, downloadFilename: "Jane Doe - GitLab - Resume.tex" });
    expect(body.document.details).toMatchObject({ pageVerified: false, pageCount: null, includedCount: 1, totalCount: 1 });
    expect(body.omittedItems).toEqual([]);
  });

  it("exports a PDF through the configured compiler with the bearer token", async () => {
    await startFakeCompiler();
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await post({ kind: "tailored_resume", jobId, sourceId: optimizationId, format: "pdf" });
    expect(res.status).toBe(201);
    expect((await res.json()).document.details).toMatchObject({ pageVerified: true, pageCount: 1 });
    expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].body).toContain("\\item Built A");
  });

  it("maps a compile failure to 502 without exposing compiler output", async () => {
    await startFakeCompiler(422);
    const { jobId, optimizationId } = await seedResumeExport(admin, USER);
    const res = await post({ kind: "tailored_resume", jobId, sourceId: optimizationId, format: "pdf" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("The resume could not be typeset. This is a bug; the compiler log has the line number.");
  });

  it("returns 422 naming where an unsupported character is", async () => {
    const { jobId } = await seedResumeExport(admin, USER);
    await admin`UPDATE work_experience_bullets SET text = 'Built 😀' WHERE user_id = ${USER}`;
    // seedResumeExport's optimization hash is now stale; re-seed one matching the edited profile.
    await admin`DELETE FROM resume_optimizations WHERE user_id = ${USER}`;
    const { createDbClient, closeDbClient, withUserContext } = await import("@ai-career/db");
    const { buildResumeSnapshot } = await import("@ai-career/resume-optimization");
    const db = createDbClient({ DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? "postgres://career_intel_app:career_intel_app@localhost:5432/career_intel_test" });
    const { contentHash } = await withUserContext(db, USER, (tx) => buildResumeSnapshot(tx));
    await closeDbClient(db);
    const [goal] = await admin`SELECT id FROM career_goals WHERE user_id = ${USER}`;
    const [opt] = await admin`
      INSERT INTO resume_optimizations (user_id, job_id, career_goal_id, version, source_profile_content_hash, selected_bullets,
                                        added_terms, unsupported_claims_detected, requires_review, rejected_claims, generation_model)
      VALUES (${USER}, ${jobId}, ${goal.id}, 3, ${contentHash}, '[]'::jsonb, '{}', '{}', false, '[]'::jsonb, 'm') RETURNING id`;
    const res = await post({ kind: "tailored_resume", jobId, sourceId: opt.id, format: "tex" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("Your profile contains a character the LaTeX resume can't typeset (Experience, entry 1, bullet 1). Edit your profile to remove it.");
  });
});
```

Run: `pnpm --filter @ai-career/web exec vitest run src/app/api/documents/route.tailored.test.ts` → FAIL (400 on the new kind).

- [ ] **Step 6: Route changes**

In `apps/web/src/app/api/documents/route.ts`:

```ts
import { texCompilerFromEnv } from "../../../lib/documents/texCompiler";
import { exportTailoredResume, type OmittedItemView, type PaperSize } from "@ai-career/document-export"; // merge into the existing import

const ExportBodySchema = z
  .object({
    kind: z.enum(["resume", "pitch", "cover_letter", "interview_prep", "tailored_resume"]),
    jobId: z.string().uuid(),
    sourceId: z.string().uuid(),
    format: z.enum(["pdf", "docx", "tex"]),
  })
  .strict()
  .superRefine((body, ctx) => {
    // .tex exists only for the tailored resume, and the tailored resume has no DOCX (Phase 13c spec §6).
    if (body.format === "tex" && body.kind !== "tailored_resume") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["format"], message: "tex is only available for kind tailored_resume" });
    if (body.kind === "tailored_resume" && body.format === "docx") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["format"], message: "tailored_resume is available as pdf or tex" });
  });

interface ExportOutcome { row: GeneratedDocumentRow; omittedItems?: OmittedItemView[] }
type ExportSettings = { paperSize: PaperSize; compilerEnv: { LATEX_COMPILER_URL?: string; LATEX_COMPILER_TOKEN?: string } };

async function runExport(
  db: DbClient, storage: Storage, userId: string, kind: ExportKind, jobId: string, sourceId: string, format: "pdf" | "docx" | "tex", settings: ExportSettings
): Promise<ExportOutcome> {
  if (kind === "tailored_resume") {
    const { document, omittedItems } = await exportTailoredResume(db, storage, texCompilerFromEnv(settings.compilerEnv), {
      userId, jobId, optimizationId: sourceId, format: format as "pdf" | "tex", paperSize: settings.paperSize,
    });
    return { row: document, omittedItems };
  }
  const fmt = format as "pdf" | "docx"; // superRefine rejected tex for every other kind
  switch (kind) {
    case "resume":
      return { row: await exportResume(db, storage, { userId, jobId, optimizationId: sourceId, format: fmt }) };
    case "pitch":
      return { row: await exportPitch(db, storage, { userId, jobId, pitchId: sourceId, format: fmt }) };
    case "cover_letter":
      return { row: await exportCoverLetter(db, storage, { userId, jobId, coverLetterId: sourceId, format: fmt }) };
    case "interview_prep":
      return { row: await exportInterviewPrep(db, storage, { userId, jobId, interviewPrepId: sourceId, format: fmt }) };
  }
}
```

In `handlePOST`'s `try`:

```ts
    const { row, omittedItems } = await runExport(db, storage, env.DEFAULT_USER_ID, kind, jobId, sourceId, format, {
      paperSize: env.RESUME_PAPER_SIZE ?? "a4",
      compilerEnv: { LATEX_COMPILER_URL: env.LATEX_COMPILER_URL, LATEX_COMPILER_TOKEN: env.LATEX_COMPILER_TOKEN },
    });
    const document = toDocumentView(row, await sourceVersion(db, env.DEFAULT_USER_ID, row));
    return NextResponse.json(omittedItems ? { document, omittedItems } : { document }, { status: 201 });
```

`sourceVersion` already handles `resumeOptimizationId`, so tailored rows report the optimization's version. `GeneratedDocumentRow` must be imported as a type if not already.

- [ ] **Step 7: `.env.example`**

Add near the other optional blocks:

```bash
# Phase 13c — tailored LaTeX resume. Start the compiler with:
#   docker compose -f infra/docker-compose.yml --env-file .env --profile latex up -d latex-compiler
# Generate the token with: openssl rand -hex 32   (at least 32 characters; the same value is given to the container)
# LATEX_COMPILER_URL=http://127.0.0.1:8090
# LATEX_COMPILER_TOKEN=
# RESUME_PAPER_SIZE=a4   # a4 | letter
```

- [ ] **Step 8: Run web tests, typecheck, lint**

Run: `pnpm --filter @ai-career/web exec vitest run src/app/api/documents src/lib/documents && pnpm --filter @ai-career/config test && pnpm --filter @ai-career/web typecheck && pnpm --filter @ai-career/web lint`
Expected: PASS. (`typecheck` for web may need `pnpm --filter @ai-career/web build` first — CI order, see ci.yml comment.)

- [ ] **Step 9: Commit**

```bash
git add packages/config/src apps/web/src/lib/documents apps/web/src/app/api/documents .env.example
git commit -m "feat(web): tailored_resume export API with tex download and compiler errors (Phase 13c)"
```

---

### Task 10: UI — tailored resume buttons, summary and "Left out" list

**Files:**
- Modify: `apps/web/src/app/matches/[jobId]/DownloadButtons.tsx`, `DownloadButtons.test.tsx`
- Create: `apps/web/src/app/matches/[jobId]/TailoredResumeExport.tsx`, `TailoredResumeExport.test.tsx`
- Modify: `apps/web/src/app/matches/[jobId]/ResumeOptimizationPanel.tsx`
- Modify: `apps/web/src/app/matches/[jobId]/DocumentsList.tsx`, `DocumentsList.test.tsx`

**Interfaces:**
- Consumes: `POST /api/documents` response `{ document: DocumentView, omittedItems?: { sourceType, text, reason }[] }` (Task 9).
- Produces:
  ```ts
  // DownloadButtons props gain:
  formats?: readonly ("pdf" | "docx" | "tex")[];   // default ["pdf", "docx"]
  onExported?: (body: { document: { downloadUrl: string; details?: TailoredDetailsView | null }; omittedItems?: OmittedItemViewUI[] }) => void;
  kind: "resume" | "pitch" | "cover_letter" | "interview_prep" | "tailored_resume";
  // TailoredResumeExport.tsx
  export function tailoredSummary(details: TailoredDetailsView): string;
  export function TailoredResumeExport(props: { jobId: string; optimizationId: string; navigate?: (url: string) => void }): JSX.Element;
  ```

- [ ] **Step 1: DownloadButtons tests (failing)**

Append to `DownloadButtons.test.tsx`:

```tsx
  it("renders only the requested formats, labels tex as .tex, and reports the export body", async () => {
    const body = { document: { downloadUrl: "/api/documents/t1/download", details: { pageCount: 1, pageVerified: true, includedCount: 3, totalCount: 4, omitted: [] } }, omittedItems: [] };
    const fetchMock = mockPostThenHead(201, body, true);
    const onExported = vi.fn();
    render(<DownloadButtons jobId="j1" kind="tailored_resume" sourceId="o1" formats={["pdf", "tex"]} onExported={onExported} navigate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Download DOCX" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download .tex" }));
    await waitFor(() => expect(onExported).toHaveBeenCalledWith(body));
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ kind: "tailored_resume", jobId: "j1", sourceId: "o1", format: "tex" });
  });
```

Run: `pnpm --filter @ai-career/web exec vitest run "src/app/matches/[jobId]/DownloadButtons.test.tsx"` → FAIL.

- [ ] **Step 2: Implement DownloadButtons changes**

- `type Format = "pdf" | "docx" | "tex";`
- props: add `formats = ["pdf", "docx"] as const` (type `readonly Format[]`) and `onExported?: (body: ExportBody) => void`; widen `kind` with `"tailored_resume"`.
- export the body type:
  ```ts
  export interface ExportBody {
    document: { downloadUrl: string; details?: { pageCount: number | null; pageVerified: boolean; includedCount: number; totalCount: number } | null };
    omittedItems?: { sourceType: string; text: string; reason: "no_requirement_match" | "page_limit" }[];
  }
  ```
- after `window.dispatchEvent(...)`: `onExported?.(body as ExportBody);`
- render `formats.map(...)` instead of the fixed array; label: `` busy === format ? "Exporting..." : `Download ${format === "tex" ? ".tex" : format.toUpperCase()}` ``.

Run the DownloadButtons tests → PASS (old tests unchanged).

- [ ] **Step 3: TailoredResumeExport tests (failing)**

```tsx
// apps/web/src/app/matches/[jobId]/TailoredResumeExport.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TailoredResumeExport, tailoredSummary } from "./TailoredResumeExport";

beforeEach(() => vi.unstubAllGlobals());

describe("tailoredSummary", () => {
  it("describes counts and page state", () => {
    expect(tailoredSummary({ pageCount: 1, pageVerified: true, includedCount: 11, totalCount: 19 })).toBe("Included 11 of 19 items · 1 page");
    expect(tailoredSummary({ pageCount: 2, pageVerified: true, includedCount: 9, totalCount: 9 })).toBe("Included 9 of 9 items · 2 pages — couldn't fit to one");
    expect(tailoredSummary({ pageCount: null, pageVerified: false, includedCount: 5, totalCount: 6 })).toBe("Included 5 of 6 items · page count not verified");
  });
});

describe("TailoredResumeExport", () => {
  it("offers PDF and .tex, then shows the summary and the left-out items with reasons", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") return Promise.resolve({ ok: true, status: 200 } as Response);
      return Promise.resolve({
        ok: true, status: 201,
        json: async () => ({
          document: { downloadUrl: "/api/documents/t1/download", details: { pageCount: 1, pageVerified: true, includedCount: 2, totalCount: 4 } },
          omittedItems: [{ sourceType: "project", text: "Blog: Cooking blog", reason: "no_requirement_match" }, { sourceType: "work_experience_bullet", text: "Wrote docs", reason: "page_limit" }],
        }),
      } as Response);
    }));
    render(<TailoredResumeExport jobId="j1" optimizationId="o1" navigate={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Tailored resume (LaTeX, 1 page)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(screen.getByText("Included 2 of 4 items · 1 page")).toBeTruthy());
    fireEvent.click(screen.getByText("Left out (2)"));
    expect(screen.getByText("Blog: Cooking blog")).toBeTruthy();
    expect(screen.getByText("no matching job requirement")).toBeTruthy();
    expect(screen.getByText("page limit")).toBeTruthy();
  });
});
```

Run → FAIL (module not found).

- [ ] **Step 4: Implement TailoredResumeExport**

```tsx
// apps/web/src/app/matches/[jobId]/TailoredResumeExport.tsx
"use client";

import { useState } from "react";
import { DownloadButtons, type ExportBody } from "./DownloadButtons";

export interface TailoredDetailsView { pageCount: number | null; pageVerified: boolean; includedCount: number; totalCount: number }

const REASON_LABELS = { no_requirement_match: "no matching job requirement", page_limit: "page limit" } as const;

export function tailoredSummary(d: TailoredDetailsView): string {
  const pages = d.pageCount === null ? "page count not verified" : d.pageCount === 1 ? "1 page" : `${d.pageCount} pages — couldn't fit to one`;
  return `Included ${d.includedCount} of ${d.totalCount} items · ${pages}`;
}

/** Phase 13c: the job-tailored LaTeX resume (PDF + .tex), with what was left out and why (CLAUDE.md §6). */
export function TailoredResumeExport({ jobId, optimizationId, navigate }: { jobId: string; optimizationId: string; navigate?: (url: string) => void }) {
  const [result, setResult] = useState<ExportBody | null>(null);
  const details = result?.document.details ?? null;
  const omitted = result?.omittedItems ?? [];
  return (
    <section aria-labelledby="tailored-resume-heading" className="flex flex-col gap-2 rounded border p-3">
      <h3 id="tailored-resume-heading" className="text-sm font-medium">Tailored resume (LaTeX, 1 page)</h3>
      <p className="text-sm text-gray-600">Keeps the optimizer&apos;s wording first, then the items that mention this job&apos;s requirements. Nothing new is written.</p>
      <DownloadButtons jobId={jobId} kind="tailored_resume" sourceId={optimizationId} formats={["pdf", "tex"]} onExported={setResult} {...(navigate ? { navigate } : {})} />
      {details && <p className="text-sm">{tailoredSummary(details)}</p>}
      {omitted.length > 0 && (
        <details className="text-sm">
          <summary>Left out ({omitted.length})</summary>
          <ul className="mt-1 list-disc pl-5">
            {omitted.map((item, i) => (
              <li key={i}>
                <span>{item.text}</span> — <span className="text-gray-600">{REASON_LABELS[item.reason]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
```

Run → PASS.

- [ ] **Step 5: Wire into the panel and the documents list**

In `ResumeOptimizationPanel.tsx`, import `TailoredResumeExport` and render it right after the existing `<DownloadButtons key={selected.id} … kind="resume" … />`:

```tsx
          <TailoredResumeExport key={`tailored-${selected.id}`} jobId={jobId} optimizationId={selected.id} />
```

In `DocumentsList.tsx`: widen the local `kind`/`format` types to include `"tailored_resume"` / `"tex"`, add `tailored_resume: "Tailored resume (LaTeX)"` to `KIND_LABELS`, add `details?: TailoredDetailsView | null` to the local document type, and where each row is rendered append ` · ${tailoredSummary(doc.details)}` when `doc.details` is present (import `tailoredSummary`). Add a `DocumentsList.test.tsx` case: a listed `{ kind: "tailored_resume", format: "tex", details: { pageCount: null, pageVerified: false, includedCount: 5, totalCount: 6 } }` row shows "Tailored resume (LaTeX)" and "page count not verified". Match the existing test's fetch-mock style in that file.

Add a `ResumeOptimizationPanel.test.tsx` assertion in its existing "renders the selected version" test (or equivalent): `expect(screen.getByRole("heading", { name: "Tailored resume (LaTeX, 1 page)" })).toBeTruthy();`.

- [ ] **Step 6: Run the UI tests and lint**

Run: `pnpm --filter @ai-career/web exec vitest run "src/app/matches/[jobId]" && pnpm --filter @ai-career/web lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/src/app/matches/[jobId]"
git commit -m "feat(web): tailored LaTeX resume buttons with page summary and left-out list (Phase 13c)"
```

---

### Task 11: Autofill attaches the tailored PDF first

**Files:**
- Modify: `packages/browser/src/sessions/loadAutofillContext.ts`
- Modify: `packages/browser/src/sessions/readSessions.ts`
- Modify: `packages/browser/src/testing/db.ts` (seed option)
- Modify: `packages/browser/src/sessions/sessions.test.ts`

**Interfaces:**
- Consumes: `generated_documents.kind = 'tailored_resume'` (Task 1).
- Produces: `loadAutofillContext(...).resumeDocument` = newest `tailored_resume` PDF for the job, else newest `resume` PDF; `getJobAutofillOverview(...).resumeAvailable` true for either.

- [ ] **Step 1: Seed option**

In `packages/browser/src/testing/db.ts`, add to `SeedAutofillOptions`: `/** Phase 13c: also a tailored_resume PDF row, created after the resume row. */ withTailoredResume?: boolean;` and to `SeededAutofillJob`: `tailoredResumeDocumentId: string | null;`. In `seedAutofillJob`, after the resume row insert, when `opts.withTailoredResume`:

```ts
    const [tailored] = await adminSql`
      INSERT INTO generated_documents (user_id, job_id, kind, format, object_key, byte_size, content_hash, renderer_version, download_filename, created_at)
      VALUES (${userId}, ${job.id}, 'tailored_resume', 'pdf', ${`${userId}/tailored.pdf`}, 10, 'tailored-h', 'tex-1', 'r.pdf', now() + interval '1 second')
      RETURNING id`;
    tailoredResumeDocumentId = tailored.id as string;
```

(Mirror the existing resume insert's variable names; return `tailoredResumeDocumentId` (default `null`).) If `withResume: false` is supported, keep the tailored insert independent of it.

- [ ] **Step 2: Failing tests**

Add to `sessions.test.ts`:

```ts
  it("prefers the newest tailored resume PDF for autofill, falling back to the full resume", async () => {
    const { jobId, resumeDocumentId, tailoredResumeDocumentId } = await seedAutofillJob(t.adminSql, USER, { withTailoredResume: true });
    const session = await createSessionFor(jobId); // use the same helper/pattern the "loads the autofill context" test above uses
    const ctx = await loadAutofillContext(t.db, USER, session.id);
    expect(ctx.resumeDocument?.id).toBe(tailoredResumeDocumentId);
    expect(ctx.resumeDocument?.id).not.toBe(resumeDocumentId);
  });

  it("counts a tailored resume as an available resume", async () => {
    const { jobId } = await seedAutofillJob(t.adminSql, USER, { withResume: false, withTailoredResume: true });
    expect((await getJobAutofillOverview(t.db, USER, jobId))?.resumeAvailable).toBe(true);
  });
```

Replace `createSessionFor` with exactly what the existing test at "loads the autofill context: profile, active goal constraints and the newest PDFs" does to get a session id (read it first; do not invent a helper). If `seedAutofillJob` has no `withResume` option, add `withResume?: boolean` (default true) in Step 1.

Run: `pnpm --filter @ai-career/browser exec vitest run src/sessions/sessions.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`loadAutofillContext.ts`: widen `newestPdf`'s parameter to `"resume" | "tailored_resume" | "cover_letter"` and set

```ts
      // Phase 13c (D212): the job-tailored LaTeX resume when one was exported, else the full-profile resume.
      resumeDocument: (await newestPdf("tailored_resume")) ?? (await newestPdf("resume")),
```

`readSessions.ts`: import `inArray` from drizzle-orm and change the resume lookup's kind condition to `inArray(generatedDocuments.kind, ["resume", "tailored_resume"])`.

Run → PASS. Also run `pnpm --filter @ai-career/browser-worker test` (attachments read `resumeDocument` unchanged) → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/browser/src
git commit -m "feat(browser): autofill attaches the tailored resume PDF when one exists (Phase 13c)"
```

---

### Task 12: Documentation, decisions, flow, full verification

**Files:**
- Modify: `DECISIONS.md`, `FLOW.md`, `docs/development.md`, `docs/architecture.md`, `docs/api.md`, `README.md`
- Modify: `docs/superpowers/specs/2026-10-20-phase-13c-latex-resume-design.md` (status line only)

- [ ] **Step 1: DECISIONS.md** — append before the trailing "*Entries are appended chronologically…*" line, in the existing entry format (`### Dnnn. Title` / `**Decision:**` / `**Why:**` / `**Alternatives considered:**` / `**What it affects:**`):
  - **D207** Tailored resume selection is deterministic: optimizer picks first, then requirement score (required 2 / preferred 1, `containsTerm`), estimate fit, floors (all roles; ≥ 2 bullets for the first two roles; education/certs/skills kept); omitted items listed with reasons. Alternatives: LLM summary; full profile. Affects: `selectTailoredResume.ts`, `estimateLines.ts`.
  - **D208** One escaping function and a Latin whitelist with pdflatex (T1, lmodern, glyphtounicode); unsupported characters → 422 with a location; ligature breaking; `[`/`]` escaped for `\item`. Alternatives: LuaLaTeX + Noto Sans. Affects: `escapeTex.ts`, `renderTex.ts`.
  - **D209** Sandboxed `latex-compiler` sidecar (no shell-escape, paranoid kpathsea, 20 s kill, 2+4 limiter, 256 KB, bearer token, read-only, cap_drop ALL, localhost port, no log text) — with **R1** (default network; why internal networks don't work with published ports; why the egress risk is accepted). Alternatives: Tectonic on host; BullMQ worker. Affects: `services/latex-compiler`, compose, CI.
  - **D210** Data: `tailored_resume` kind, `tex` format, `details jsonb` (ids + reasons only) with CHECKs using `::text`; tailored content hash covers template version, paper size, TeX version (PDF), model **and details** (**R4**); `storeDocument` accepts prerendered files. Affects: schema, migration 0038, `hash.ts`, `storeDocument.ts`.
  - **D211** Fit loop: compile, ≤ 3 extra trims, then export flagged "2 pages"; `.tex` falls back to the estimate when the compiler is down (**R5**), `compile_failed` still fails; PDF without a compiler → 503 with the start command. Affects: `fitToPage.ts`, `exportTailoredResume.ts`, `exportErrors.ts`.
  - **D212** Autofill prefers the newest tailored PDF. Affects: `loadAutofillContext.ts`, `readSessions.ts`.
  - **D213** UI and E2E scope: omitted text returned with the export (**R3**); `DocumentsList` shows counts only; no smoke-suite step (**R2**) — route tests with a fake compiler + CI real-compile test instead; unsupported-character locations from the model (**R6**).
  Include the calibrated `LINE_METRICS` values and the image size from Task 8's report in D209/D207.

- [ ] **Step 2: FLOW.md §22 "Phase 13c — Tailored LaTeX Resume"** — in the existing section style: `ResumeOptimizationPanel → TailoredResumeExport → DownloadButtons → POST /api/documents (route.ts superRefine) → runExport → texCompilerFromEnv → exportTailoredResume → loadResumeExportContext (D84 checks) → job_requirements → selectTailoredResume (estimateLines) → normalizeModel/assertSafeModel/findUnsupportedCharacter → fitToPage (renderTex → createHttpTexCompiler.compile → services/latex-compiler server → limiter → compileTex → runPdflatex) → tailoredContentHash → storeDocument (prerendered) → MinIO + generated_documents`; download route (`CONTENT_TYPES.tex`); autofill (`loadAutofillContext` tailored → resume fallback). Mark which files changed in this phase.

- [ ] **Step 3: docs** — `docs/development.md`: generating `LATEX_COMPILER_TOKEN`, the compose command, `LATEX_COMPILER_URL`, `RESUME_PAPER_SIZE`, running `test:latex` locally in test mode (the commands from Task 8 Step 6). `docs/architecture.md`: the sidecar box and its trust boundary. `docs/api.md`: `kind: tailored_resume`, `format: tex`, the response `omittedItems`, `details`, and the new error codes/statuses. `README.md`: one line under optional services for the `latex` profile.

- [ ] **Step 4: Spec status line** — set `Status: implemented on branch phase-13c-latex-resume (not yet merged).`

- [ ] **Step 5: Full verification (CI order)**

```bash
pnpm --filter @ai-career/db db:migrate
pnpm lint
pnpm build
pnpm typecheck
pnpm test --force
LATEX_COMPILER_URL=http://127.0.0.1:8090 pnpm --filter @ai-career/document-export test:latex   # with the test-mode container from Task 8 Step 6
pnpm e2e
```

Expected: all green; record counts (packages/tests, E2E checks) in the report. Then a manual check in the running app (`pnpm --filter @ai-career/web start` with the compiler up, `LATEX_COMPILER_URL`/`TOKEN` in `.env`): open a match with a resume optimization, click **Download PDF** and **Download .tex** under "Tailored resume (LaTeX, 1 page)", open the PDF (one page, selectable text), confirm the summary line and "Left out" list. Stop the compiler and confirm the PDF button shows the start command while `.tex` still downloads.

- [ ] **Step 6: Commit**

```bash
git add DECISIONS.md FLOW.md docs README.md
git commit -m "docs: Phase 13c decisions D207-D213, FLOW §22, compiler setup and API"
```
