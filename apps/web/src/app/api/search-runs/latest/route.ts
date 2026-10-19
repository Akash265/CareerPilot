import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { latestRun } from "../../../../lib/searchRuns/searchRuns";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";

async function handleGET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const run = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => latestRun(tx, new Date()));
    return NextResponse.json({ run });
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/search-runs/latest", handleGET);
