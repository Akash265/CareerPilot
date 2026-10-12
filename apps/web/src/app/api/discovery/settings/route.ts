import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";
import { applySettings, SettingsBodySchema } from "../../../../lib/discovery/discovery";

/** Phase 12 (D185): `{ consent, autoDiscover }` -- the standing consent and the auto-discovery switch. */
async function handlePUT(request: Request) {
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = SettingsBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const error = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => applySettings(tx, parsed.data, new Date()));
    return error ? NextResponse.json({ error }, { status: 400 }) : NextResponse.json({ ok: true });
  } finally {
    await closeDbClient(db);
  }
}

export const PUT = withRouteErrors("/api/discovery/settings", handlePUT);
