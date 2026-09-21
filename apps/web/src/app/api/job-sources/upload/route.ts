import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { UploadParseError, parseUploadFile, storeUpload } from "@ai-career/ingestion";
import { enqueueIngestion } from "../../../../lib/job-ingestion/enqueue";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
// Content-Length covers the whole multipart envelope, so a file at exactly the cap is slightly larger.
// This is only an early, coarse rejection; `file.size` below is the authoritative limit.
const CONTENT_LENGTH_SLACK_BYTES = 64 * 1024;

export async function POST(request: Request) {
  const env = loadEnv();

  // Reject an oversized upload from its declared length BEFORE request.formData() buffers the body.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FILE_SIZE_BYTES + CONTENT_LENGTH_SLACK_BYTES) {
    return NextResponse.json({ error: "File exceeds 10MB limit" }, { status: 400 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Request must be multipart form data" }, { status: 400 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.size > MAX_FILE_SIZE_BYTES) return NextResponse.json({ error: "File exceeds 10MB limit" }, { status: 400 });

  // D3: the user must confirm they may use this data before it is ingested.
  if (formData.get("consentConfirmed") !== "true") {
    return NextResponse.json(
      { error: "Confirm that you are permitted to use this file's data before uploading it" },
      { status: 400 }
    );
  }

  let records;
  try {
    records = parseUploadFile(Buffer.from(await file.arrayBuffer()), file.name);
  } catch (error) {
    if (error instanceof UploadParseError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }

  const db = createDbClient(env);
  let stored;
  try {
    stored = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      storeUpload(tx, { filename: file.name, records, now: new Date() })
    );
  } finally {
    await closeDbClient(db);
  }

  // The records are safely stored either way. If the queue is unreachable the user can use "Run now" later.
  let queued = true;
  try {
    await enqueueIngestion(env, stored.sourceId);
  } catch {
    queued = false;
  }
  return NextResponse.json({ sourceId: stored.sourceId, count: stored.count, queued }, { status: 201 });
}
