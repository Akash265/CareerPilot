import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { quickStart } from "../../../../lib/discovery/discovery";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";

/** Phase 13a: consent + auto-discovery + every keyed-or-keyless provider that can run, in one step. */
async function handlePOST() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => quickStart(tx, env, new Date()));
    return NextResponse.json(result);
  } finally {
    await closeDbClient(db);
  }
}

export const POST = withRouteErrors("/api/discovery/quick-start", handlePOST);
