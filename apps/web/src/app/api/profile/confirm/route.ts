import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { ConfirmedProfileSchema } from "../../../../lib/profile/confirmedProfileSchema";
import { saveConfirmedProfile } from "../../../../lib/profile/saveProfile";

export async function POST(request: Request) {
  const env = loadEnv();
  const body = await request.json();
  const parsed = ConfirmedProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }
  const result = await saveConfirmedProfile(env, parsed.data);
  return NextResponse.json({ status: "saved", factsGenerated: result.factsGenerated });
}
