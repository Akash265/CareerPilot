import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { getJobDetail } from "../../../../lib/jobs/getJobDetail";
import { toMatchView } from "../../../../lib/matching/serializeMatch";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { readJsonBody } from "../../../../lib/readJsonBody";
import { MatchActionSchema } from "../../../../lib/matching/matchActionSchema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    return await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      const [matchRow] = await tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)).limit(1);
      if (!matchRow) return NextResponse.json({ error: "Match not found" }, { status: 404 });
      const job = await getJobDetail(tx, jobId);
      if (!job) return NextResponse.json({ error: "Match not found" }, { status: 404 });
      return NextResponse.json({ job, match: toMatchView(matchRow) });
    });
  } finally {
    await closeDbClient(db);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const env = loadEnv();
  const jsonBody = await readJsonBody(request);
  if (!jsonBody.ok) return jsonBody.response;
  const parsed = MatchActionSchema.safeParse(jsonBody.body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }

  const db = createDbClient(env);
  try {
    return await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => {
      const [existing] = await tx.select().from(schema.jobMatches).where(eq(schema.jobMatches.jobId, jobId)).limit(1);
      if (!existing) return NextResponse.json({ error: "Match not found" }, { status: 404 });
      const [updated] = await tx
        .update(schema.jobMatches)
        .set({ userAction: parsed.data.userAction, userActionAt: new Date() })
        .where(eq(schema.jobMatches.jobId, jobId))
        .returning();
      return NextResponse.json({ match: toMatchView(updated) });
    });
  } finally {
    await closeDbClient(db);
  }
}
