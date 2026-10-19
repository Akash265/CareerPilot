import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { loadJobSkillGaps } from "../../../../lib/skillGaps/loadSkillGaps";
import { withRouteErrors } from "../../../../lib/http/withRouteErrors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleGET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const view = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => loadJobSkillGaps(tx, jobId));
    return view ? NextResponse.json(view) : NextResponse.json({ error: "Job not found" }, { status: 404 });
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/skill-gaps/[jobId]", handleGET);
