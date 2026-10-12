import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { formatValidationError } from "../../../../../lib/formatValidationError";
import { readJsonBody } from "../../../../../lib/readJsonBody";
import { withRouteErrors } from "../../../../../lib/http/withRouteErrors";
import { ProviderBodySchema, setProvider } from "../../../../../lib/discovery/discovery";

/** Phase 12 (D187): `{ enabled }` switches one goal-driven search provider on or off. */
async function handlePUT(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = ProviderBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => setProvider(tx, kind, parsed.data.enabled, env, new Date()));
    return result.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: result.error }, { status: result.status });
  } finally {
    await closeDbClient(db);
  }
}

export const PUT = withRouteErrors("/api/discovery/providers/[kind]", handlePUT);
