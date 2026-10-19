// apps/web/src/app/api/documents/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext, type DbClient } from "@ai-career/db";
import { createStorageClient } from "@ai-career/storage";
import {
  exportPitch, exportResume, exportCoverLetter, exportInterviewPrep, exportTailoredResume, DocumentExportError,
  type GeneratedDocumentRow, type OmittedItemView, type PaperSize,
} from "@ai-career/document-export";
import { readJsonBody } from "../../../lib/readJsonBody";
import { formatValidationError } from "../../../lib/formatValidationError";
import { listDocuments } from "../../../lib/documents/listDocuments";
import { toDocumentView } from "../../../lib/documents/serializeDocument";
import { exportErrorResponse } from "../../../lib/documents/exportErrors";
import { texCompilerFromEnv } from "../../../lib/documents/texCompiler";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
const { resumeOptimizations, applicationPitches, coverLetters, interviewPreparations } = schema;

type ExportKind = z.infer<typeof ExportBodySchema>["kind"];
// @ai-career/storage exports only the factory, not a client type; this names what it returns so
// runExport can take the one client POST creates instead of each export making its own.
type Storage = ReturnType<typeof createStorageClient>;

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

/** The version of the row's OWN source (content de-dup can return a row created for another version). */
async function sourceVersion(db: DbClient, userId: string, row: GeneratedDocumentRow): Promise<number | null> {
  return withUserContext(db, userId, async (tx) => {
    if (row.resumeOptimizationId) {
      const [source] = await tx.select({ version: resumeOptimizations.version }).from(resumeOptimizations).where(eq(resumeOptimizations.id, row.resumeOptimizationId)).limit(1);
      return source?.version ?? null;
    }
    if (row.applicationPitchId) {
      const [source] = await tx.select({ version: applicationPitches.version }).from(applicationPitches).where(eq(applicationPitches.id, row.applicationPitchId)).limit(1);
      return source?.version ?? null;
    }
    if (row.coverLetterId) {
      const [source] = await tx.select({ version: coverLetters.version }).from(coverLetters).where(eq(coverLetters.id, row.coverLetterId)).limit(1);
      return source?.version ?? null;
    }
    if (row.interviewPreparationId) {
      const [source] = await tx.select({ version: interviewPreparations.version }).from(interviewPreparations).where(eq(interviewPreparations.id, row.interviewPreparationId)).limit(1);
      return source?.version ?? null;
    }
    return null;
  });
}

async function handlePOST(request: Request) {
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = ExportBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const { kind, jobId, sourceId, format } = parsed.data;

  const env = loadEnv();
  const db = createDbClient(env);
  const storage = createStorageClient(env);
  try {
    const { row, omittedItems } = await runExport(db, storage, env.DEFAULT_USER_ID, kind, jobId, sourceId, format, {
      paperSize: env.RESUME_PAPER_SIZE ?? "a4",
      compilerEnv: { LATEX_COMPILER_URL: env.LATEX_COMPILER_URL, LATEX_COMPILER_TOKEN: env.LATEX_COMPILER_TOKEN },
    });
    const document = toDocumentView(row, await sourceVersion(db, env.DEFAULT_USER_ID, row));
    return NextResponse.json(omittedItems ? { document, omittedItems } : { document }, { status: 201 });
  } catch (error) {
    if (error instanceof DocumentExportError) return exportErrorResponse(error);
    throw error;
  } finally {
    await closeDbClient(db);
  }
}

async function handleGET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId || !UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const documents = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => listDocuments(tx, jobId));
    return NextResponse.json({ documents });
  } finally {
    await closeDbClient(db);
  }
}

export const POST = withRouteErrors("/api/documents", handlePOST);
export const GET = withRouteErrors("/api/documents", handleGET);
