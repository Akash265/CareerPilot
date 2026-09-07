import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { createDbClient, withUserContext } from "@ai-career/db";
import { ConfirmedProfileSchema } from "../../../lib/profile/confirmedProfileSchema";
import { saveConfirmedProfile } from "../../../lib/profile/saveProfile";
import { serializeProfile } from "../../../lib/profile/serializeProfile";

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

export async function GET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const profile = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => serializeProfile(tx));
    return NextResponse.json({ profile });
  } finally {
    await closePool(db);
  }
}

export async function PATCH(request: Request) {
  const env = loadEnv();
  const body = await request.json();
  const parsed = ConfirmedProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  // saveConfirmedProfile creates and closes its own pool.
  const result = await saveConfirmedProfile(env, parsed.data);
  return NextResponse.json({ status: "saved", factsGenerated: result.factsGenerated });
}
