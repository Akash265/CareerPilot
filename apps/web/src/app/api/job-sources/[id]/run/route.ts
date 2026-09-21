import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { enqueueIngestion } from "../../../../../lib/job-ingestion/enqueue";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Job source not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  let source;
  try {
    [source] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.select().from(schema.jobSources).where(eq(schema.jobSources.id, id)).limit(1)
    );
  } finally {
    await closeDbClient(db);
  }
  if (!source) return NextResponse.json({ error: "Job source not found" }, { status: 404 });

  // The worker re-checks both of these (D3); refusing here just gives the user a clear answer.
  if (!source.enabled) {
    return NextResponse.json({ error: "Enable this source before running it" }, { status: 409 });
  }
  if (!source.consentConfirmedAt) {
    return NextResponse.json({ error: "Confirm the source's Terms of Service before running it" }, { status: 409 });
  }

  let result;
  try {
    result = await enqueueIngestion(env, id);
  } catch {
    // Fixed text: the underlying error can name the Redis host.
    return NextResponse.json({ error: "The job queue is unavailable. Is Redis running?" }, { status: 503 });
  }
  if (result === "already_queued") {
    return NextResponse.json({ error: "A run for this source is already queued or running" }, { status: 409 });
  }
  return NextResponse.json({ status: "queued" }, { status: 202 });
}
