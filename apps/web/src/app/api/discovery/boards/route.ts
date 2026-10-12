import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";
import { withRateLimit } from "../../../../lib/http/rateLimit";
import { BoardsBodySchema, importBoards } from "../../../../lib/discovery/discovery";

/** Phase 12 (D186): `{ text }` -- pasted board links become pending boards; the ingestion worker validates them. */
async function handlePOST(request: Request) {
  const json = await readJsonBody(request);
  if (!json.ok) return json.response;
  const parsed = BoardsBodySchema.safeParse(json.body);
  if (!parsed.success) return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => importBoards(tx, parsed.data.text));
    return result.ok
      ? NextResponse.json({ recognized: result.recognized, added: result.added })
      : NextResponse.json({ error: result.error }, { status: result.status });
  } finally {
    await closeDbClient(db);
  }
}

export const POST = withRouteErrors("/api/discovery/boards", withRateLimit("jobs", "/api/discovery/boards", handlePOST));
