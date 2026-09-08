import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { ConfirmedProfileSchema, formatValidationError } from "../../../../lib/profile/confirmedProfileSchema";
import { saveConfirmedProfile } from "../../../../lib/profile/saveProfile";

export async function POST(request: Request) {
  const env = loadEnv();
  const body = await request.json();
  const parsed = ConfirmedProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }
  // saveConfirmedProfile creates and closes its own connection pool, so this
  // route never opens one of its own (see packages/db/src/client.ts).
  const result = await saveConfirmedProfile(env, parsed.data);
  return NextResponse.json({ status: "saved", factsGenerated: result.factsGenerated });
}
