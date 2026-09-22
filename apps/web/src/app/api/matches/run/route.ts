import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { enqueueMatching } from "../../../../lib/matching/enqueue";

export async function POST(_request: Request) {
  const env = loadEnv();
  const db = createDbClient(env);
  let hasActiveGoal: boolean;
  try {
    const rows = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .select({ id: schema.careerGoals.id })
        .from(schema.careerGoals)
        .where(and(eq(schema.careerGoals.isActive, true), eq(schema.careerGoals.confirmationStatus, "confirmed")))
        .limit(1)
    );
    hasActiveGoal = rows.length > 0;
  } finally {
    await closeDbClient(db);
  }
  if (!hasActiveGoal) {
    return NextResponse.json({ error: "Confirm a career goal before finding matches" }, { status: 409 });
  }

  let result;
  try {
    result = await enqueueMatching(env, env.DEFAULT_USER_ID);
  } catch {
    return NextResponse.json({ error: "The job queue is unavailable. Is Redis running?" }, { status: 503 });
  }
  if (result === "already_queued") {
    return NextResponse.json({ error: "A matching run is already queued or running" }, { status: 409 });
  }
  return NextResponse.json({ status: "queued" }, { status: 202 });
}
