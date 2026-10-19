import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { failQueued, startRun } from "../../../lib/searchRuns/searchRuns";
import { enqueueSearchRun } from "../../../lib/searchRuns/enqueue";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";
import { withRateLimit } from "../../../lib/http/rateLimit";

/** Phase 13a: "Find matching jobs". Idempotent while a run is in progress. */
async function handlePOST() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => startRun(tx, new Date()));
    if (result.kind === "consent_required") {
      return NextResponse.json({ error: "Give permission for discovery first", code: "consent_required" }, { status: 409 });
    }
    if (result.kind === "no_active_goal") {
      return NextResponse.json({ error: "Confirm a career goal before finding jobs", code: "no_active_goal" }, { status: 409 });
    }
    if (result.kind === "existing") return NextResponse.json({ run: result.run });
    try {
      await enqueueSearchRun(env, result.run.id);
    } catch {
      await withUserContext(db, env.DEFAULT_USER_ID, (tx) => failQueued(tx, result.run.id, "queue_unavailable", new Date()));
      return NextResponse.json({ error: "The job queue is unavailable. Is Redis running?" }, { status: 503 });
    }
    return NextResponse.json({ run: result.run }, { status: 202 });
  } finally {
    await closeDbClient(db);
  }
}

export const POST = withRouteErrors("/api/search-runs", withRateLimit("jobs", "/api/search-runs", handlePOST));
