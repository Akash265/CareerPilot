import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Phase 13b: undo an answer -- the term becomes unanswered again. */
async function handleDELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Answer not found" }, { status: 404 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const deleted = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx.delete(schema.skillVerifications).where(eq(schema.skillVerifications.id, id)).returning({ id: schema.skillVerifications.id }));
    return deleted.length === 0 ? NextResponse.json({ error: "Answer not found" }, { status: 404 }) : new NextResponse(null, { status: 204 });
  } finally {
    await closeDbClient(db);
  }
}

export const DELETE = withRouteErrors("/api/skill-verifications/[id]", handleDELETE);
