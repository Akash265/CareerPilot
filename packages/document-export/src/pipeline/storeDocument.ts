import { and, eq } from "drizzle-orm";
import type { Client } from "minio";
import { schema, withUserContext, type DbClient } from "@ai-career/db";
import { deleteGeneratedDocument, uploadGeneratedDocument } from "@ai-career/storage";
import {
  RENDERER_VERSION, type DocumentFormat, type DocumentKind, type DocumentModel, type StoredDocumentFormat, type TailoredResumeDetails,
} from "../model/types";
import { modelContentHash } from "../model/hash";
import { assertSafeModel } from "../model/assertSafeModel";
import { normalizeModel } from "../model/normalizeModel";
import { renderDocument } from "../render/renderDocument";
import { DocumentExportError } from "../errors";

const { generatedDocuments } = schema;

export type GeneratedDocumentRow = typeof generatedDocuments.$inferSelect;

export interface StoreDocumentInput {
  userId: string;
  jobId: string;
  kind: DocumentKind;
  format: StoredDocumentFormat;
  model: DocumentModel;
  resumeOptimizationId: string | null;
  applicationPitchId: string | null;
  coverLetterId?: string | null;
  interviewPreparationId?: string | null;
  downloadFilename: string;
  /** Phase 13c: a file rendered elsewhere (the LaTeX path) with its own content hash; required for format "tex". */
  prerendered?: { buffer: Buffer; contentHash: string; rendererVersion: string };
  details?: TailoredResumeDetails | null;
}

/**
 * Hash → reuse, else render → upload (outside any transaction) → insert ON CONFLICT DO NOTHING.
 * A loser of a concurrent identical export deletes its own upload and returns the winner's row (D84).
 * job_id is part of the de-dup key: the model carries nothing job-specific, so without it exporting
 * for job B could return job A's stored row (D84 update).
 *
 * The model is run through normalizeModel (D86) before assertSafeModel and before hashing: assertSafeModel
 * only rejects NUL and unpaired surrogates, not XML-illegal control characters such as \u000B, which
 * corrupt the DOCX but leave a stable content hash -- so without normalizing first, a broken document
 * would keep being the one storeDocument reuses.
 */
export async function storeDocument(db: DbClient, storage: Client, rawInput: StoreDocumentInput): Promise<GeneratedDocumentRow> {
  const input: StoreDocumentInput = { ...rawInput, model: normalizeModel(rawInput.model) };
  const inUserContext = <T>(fn: (tx: DbClient) => Promise<T>) => withUserContext(db, input.userId, fn);
  assertSafeModel(input.model);
  if (input.format === "tex" && !input.prerendered) throw new Error("a tex document must be prerendered");
  const contentHash = input.prerendered?.contentHash ?? modelContentHash(input.model, input.format as DocumentFormat);
  const findExisting = () =>
    inUserContext((tx) =>
      tx
        .select()
        .from(generatedDocuments)
        .where(
          and(
            eq(generatedDocuments.jobId, input.jobId),
            eq(generatedDocuments.kind, input.kind),
            eq(generatedDocuments.format, input.format),
            eq(generatedDocuments.contentHash, contentHash)
          )
        )
        .limit(1)
    );

  const [existing] = await findExisting();
  if (existing) return existing;

  const buffer = input.prerendered?.buffer ?? (await renderDocument(input.model, input.format as DocumentFormat));
  let objectKey: string;
  try {
    ({ objectKey } = await uploadGeneratedDocument(storage, { userId: input.userId, buffer, extension: input.format }));
  } catch (cause) {
    throw new DocumentExportError("storage_unavailable", { cause });
  }

  let inserted: GeneratedDocumentRow | undefined;
  try {
    [inserted] = await inUserContext((tx) =>
      tx
        .insert(generatedDocuments)
        .values({
          jobId: input.jobId,
          kind: input.kind,
          format: input.format,
          resumeOptimizationId: input.resumeOptimizationId,
          applicationPitchId: input.applicationPitchId,
          coverLetterId: input.coverLetterId ?? null,
          interviewPreparationId: input.interviewPreparationId ?? null,
          objectKey,
          byteSize: buffer.length,
          contentHash,
          rendererVersion: input.prerendered?.rendererVersion ?? RENDERER_VERSION,
          details: input.details ?? null,
          downloadFilename: input.downloadFilename,
        })
        .onConflictDoNothing({
          target: [generatedDocuments.userId, generatedDocuments.jobId, generatedDocuments.kind, generatedDocuments.format, generatedDocuments.contentHash],
        })
        .returning()
    );
  } catch (err) {
    // Not a de-dup conflict (onConflictDoNothing already swallows that) -- a genuine insert failure.
    // The upload already happened; never leave an unreferenced object (with resume PII) behind.
    await deleteGeneratedDocument(storage, objectKey).catch(() => {});
    throw err;
  }
  if (inserted) return inserted;

  await deleteGeneratedDocument(storage, objectKey).catch(() => {});
  const [winner] = await findExisting();
  if (!winner) throw new Error("generated_documents insert conflicted but no existing row was found");
  return winner;
}
