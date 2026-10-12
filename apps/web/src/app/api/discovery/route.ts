import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";
import { loadDiscoveryView } from "../../../lib/discovery/discovery";

/** Phase 12: the discovery panel's state -- consent, search providers, discovered boards. */
async function handleGET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    return NextResponse.json(await withUserContext(db, env.DEFAULT_USER_ID, (tx) => loadDiscoveryView(tx, env)));
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/discovery", handleGET);
