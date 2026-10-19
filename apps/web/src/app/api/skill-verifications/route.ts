import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { readJsonBody } from "../../../lib/readJsonBody";
import { formatValidationError } from "../../../lib/formatValidationError";
import { SkillVerificationBodySchema } from "../../../lib/skillGaps/verificationBody";
import { saveVerification } from "../../../lib/skillGaps/saveVerification";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";

/** Phase 13b: answer one missing skill. Evidence is user text: stored, never logged. */
async function handlePUT(request: Request) {
  const jsonBody = await readJsonBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = SkillVerificationBodySchema.safeParse(jsonBody.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => saveVerification(tx, parsed.data));
    if (result.kind === "unknown_skill") return NextResponse.json({ error: "Pick one of your profile skills" }, { status: 422 });
    return NextResponse.json({ verification: result.verification });
  } finally {
    await closeDbClient(db);
  }
}

export const PUT = withRouteErrors("/api/skill-verifications", handlePUT);
