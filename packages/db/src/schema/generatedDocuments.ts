import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, integer, timestamp, uniqueIndex, index, check, jsonb } from "drizzle-orm/pg-core";
import { jobs } from "./jobs";
import { resumeOptimizations } from "./resumeOptimizations";
import { applicationPitches } from "./applicationPitches";
import { coverLetters } from "./coverLetters";
import { interviewPreparations } from "./interviewPreparations";

export const generatedDocumentKindEnum = pgEnum("generated_document_kind", ["resume", "pitch", "cover_letter", "interview_prep", "tailored_resume"]);
export const generatedDocumentFormatEnum = pgEnum("generated_document_format", ["pdf", "docx", "tex"]);

/**
 * One stored, rendered file (Phase 7b design §3). The file itself lives in MinIO bucket
 * "generated-documents" under objectKey = "{userId}/{uuid}.{ext}" -- never a user-supplied name.
 * contentHash = sha256(format, RENDERER_VERSION, stable JSON of the DocumentModel); the unique index on
 * (user_id, job_id, kind, format, content_hash) de-duplicates identical exports and is the concurrency
 * backstop. job_id is part of the key (not just an FK) because the resume/pitch model carries nothing
 * job-specific -- without it, exporting for job B could return job A's row (D84).
 * The source column (resumeOptimizationId / applicationPitchId / coverLetterId / interviewPreparationId)
 * that does not match `kind` is always null; the matching one may later become null through ON DELETE
 * SET NULL, so it is not required non-null here (the pipeline always sets it).
 * Phase 13c: kind tailored_resume uses resumeOptimizationId too; its content hash is tailoredContentHash
 * (not the resume model hash), and `details` carries its page/omission summary.
 * Known gap: deleting a job cascades these rows but not their MinIO objects (Phase 9 retention sweeps them).
 */
export const generatedDocuments = pgTable(
  "generated_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .default(sql`current_setting('app.current_user_id')::uuid`),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    kind: generatedDocumentKindEnum("kind").notNull(),
    format: generatedDocumentFormatEnum("format").notNull(),
    resumeOptimizationId: uuid("resume_optimization_id").references(() => resumeOptimizations.id, { onDelete: "set null" }),
    applicationPitchId: uuid("application_pitch_id").references(() => applicationPitches.id, { onDelete: "set null" }),
    coverLetterId: uuid("cover_letter_id").references(() => coverLetters.id, { onDelete: "set null" }),
    interviewPreparationId: uuid("interview_preparation_id").references(() => interviewPreparations.id, { onDelete: "set null" }),
    objectKey: text("object_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    contentHash: text("content_hash").notNull(),
    rendererVersion: text("renderer_version").notNull(),
    downloadFilename: text("download_filename").notNull(),
    /** Phase 13c: tailored_resume only -- page count, counts, omitted item ids + reasons (no resume text). */
    details: jsonb("details").$type<{
      pageCount: number | null;
      pageVerified: boolean;
      includedCount: number;
      totalCount: number;
      omitted: { sourceType: "work_experience_bullet" | "project" | "achievement"; sourceFactId: string; reason: "no_requirement_match" | "page_limit" }[];
    }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userJobKindFormatHashUniq: uniqueIndex("generated_documents_user_job_kind_format_hash_uniq").on(t.userId, t.jobId, t.kind, t.format, t.contentHash),
    jobIdIdx: index("generated_documents_job_id_idx").on(t.jobId),
    byteSizePositive: check("generated_documents_byte_size_positive", sql`${t.byteSize} > 0`),
    // Every source column other than the one matching `kind` is null. `kind::text` (not a bare enum
    // literal): drizzle's migrator applies all pending migrations in ONE transaction, and Postgres
    // rejects using an enum value added by ALTER TYPE ... ADD VALUE in the same transaction.
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
    // Phase 11c (D181): one index per foreign key, so a change to the parent row never scans this table.
    applicationPitchIdFkIdx: index("generated_documents_application_pitch_id_idx").on(t.applicationPitchId).where(sql`${t.applicationPitchId} IS NOT NULL`),
    coverLetterIdFkIdx: index("generated_documents_cover_letter_id_idx").on(t.coverLetterId).where(sql`${t.coverLetterId} IS NOT NULL`),
    interviewPreparationIdFkIdx: index("generated_documents_interview_preparation_id_idx").on(t.interviewPreparationId).where(sql`${t.interviewPreparationId} IS NOT NULL`),
    resumeOptimizationIdFkIdx: index("generated_documents_resume_optimization_id_idx").on(t.resumeOptimizationId).where(sql`${t.resumeOptimizationId} IS NOT NULL`),
  })
);
