import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { createDbClient, withUserContext, schema } from "@ai-career/db";
import { createStorageClient, uploadResume } from "@ai-career/storage";
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

  const text = await extractText(buffer, fileType);
  const anthropic = createAnthropicClient(env);

  try {
    const draft = await extractWithRetry(anthropic, env, text);
    await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .update(schema.resumeDocuments)
        .set({ extractionStatus: "extracted" })
        .where(eq(schema.resumeDocuments.id, resumeDocumentId))
    );
    return NextResponse.json({ resumeDocumentId, status: "extracted", draft });
  } catch (error) {
    const message = error instanceof ExtractionValidationError ? error.message : "Extraction failed";
    await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .update(schema.resumeDocuments)
        .set({ extractionStatus: "failed", extractionError: message })
        .where(eq(schema.resumeDocuments.id, resumeDocumentId))
    );
    return NextResponse.json({ resumeDocumentId, status: "failed", error: message }, { status: 200 });
  }
}
