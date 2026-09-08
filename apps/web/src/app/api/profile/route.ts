import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { createDbClient, closeDbClient, withUserContext } from "@ai-career/db";
import { ConfirmedProfileSchema } from "../../../lib/profile/confirmedProfileSchema";
import { saveConfirmedProfile } from "../../../lib/profile/saveProfile";
import { serializeProfile } from "../../../lib/profile/serializeProfile";

export async function GET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const profile = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => serializeProfile(tx));
    return NextResponse.json({ profile });
  } finally {
    await closeDbClient(db);
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
