import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { createDbClient, withUserContext, schema } from "@ai-career/db";
import { createStorageClient, uploadResume, deleteResume } from "@ai-career/storage";
import {
  detectResumeFileType,
  extractText,
  extractProfileFromResume,
  createAnthropicClient,
  UnsupportedFileTypeError,
  ExtractionValidationError,
  type ResumeExtractionDraft,
} from "@ai-career/ai";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * `createDbClient` opens a fresh postgres connection pool on every call (see
 * packages/db/src/client.ts), so every request that creates one must close it
 * or connections accumulate towards Postgres's `max_connections`. Same
 * best-effort pattern already used by apps/web/src/app/api/health/route.ts:
 * failing to close must never change the response.
 */
async function closePool(db: ReturnType<typeof createDbClient>): Promise<void> {
  try {
    await db.$client?.end();
  } catch {
    // Best-effort cleanup only; must not affect the response.
  }
}

async function extractWithRetry(
  anthropic: ReturnType<typeof createAnthropicClient>,
  env: Parameters<typeof extractProfileFromResume>[1],
  text: string
): Promise<ResumeExtractionDraft> {
  try {
    return await extractProfileFromResume(anthropic, env, text);
  } catch (error) {
    if (error instanceof ExtractionValidationError) {
      return await extractProfileFromResume(anthropic, env, text);
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const env = loadEnv();
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json({ error: "File exceeds 10MB limit" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let fileType;
  try {
    fileType = await detectResumeFileType(buffer, file.name);
  } catch (error) {
    if (error instanceof UnsupportedFileTypeError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const storageClient = createStorageClient(env);
  const db = createDbClient(env);

  try {
    const { objectKey } = await uploadResume(storageClient, {
      userId: env.DEFAULT_USER_ID,
      buffer,
      fileExtension: fileType,
    });

    const resumeDocumentId = await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      await tx
        .update(schema.resumeDocuments)
        .set({ isActive: false })
        .where(eq(schema.resumeDocuments.isActive, true));

      const [row] = await tx
        .insert(schema.resumeDocuments)
        .values({
          objectKey,
          originalFilename: file.name,
          mimeType: file.type || "application/octet-stream",
          fileSizeBytes: file.size,
          extractionStatus: "pending",
          isActive: true,
        })
        .returning({ id: schema.resumeDocuments.id });
      return row.id as string;
    });

    try {
      // extractText() must stay INSIDE this try: a file that passes the magic-byte
      // sniff can still fail to parse (truncated/corrupt PDF, malformed DOCX zip),
      // and that is an expected, handled outcome -- the same one the spec defines
      // for a failed Anthropic/Zod extraction. Outside the try it would escape as
      // an unhandled 500 and leave extraction_status stuck at 'pending' forever.
      const text = await extractText(buffer, fileType);
      const anthropic = createAnthropicClient(env);
      const draft = await extractWithRetry(anthropic, env, text);
      await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
        tx
          .update(schema.resumeDocuments)
          .set({ extractionStatus: "extracted" })
          .where(eq(schema.resumeDocuments.id, resumeDocumentId))
      );
      return NextResponse.json({ resumeDocumentId, status: "extracted", draft });
    } catch (error) {
      const message =
        error instanceof ExtractionValidationError ? error.message : "Extraction failed";
      await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
        tx
          .update(schema.resumeDocuments)
          .set({ extractionStatus: "failed", extractionError: message })
          .where(eq(schema.resumeDocuments.id, resumeDocumentId))
      );
      return NextResponse.json(
        { resumeDocumentId, status: "failed", error: message },
        { status: 200 }
      );
    }
  } finally {
    await closePool(db);
  }
}

export async function DELETE() {
  const env = loadEnv();
  const db = createDbClient(env);
  const storageClient = createStorageClient(env);

  try {
    const activeResume = await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.resumeDocuments)
        .where(eq(schema.resumeDocuments.isActive, true));
      return row ?? null;
    });

    if (!activeResume) {
      return NextResponse.json({ error: "No active resume" }, { status: 404 });
    }

    await deleteResume(storageClient, activeResume.objectKey);
    await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.delete(schema.resumeDocuments).where(eq(schema.resumeDocuments.id, activeResume.id))
    );

    return NextResponse.json({ status: "deleted" });
  } finally {
    await closePool(db);
  }
}
