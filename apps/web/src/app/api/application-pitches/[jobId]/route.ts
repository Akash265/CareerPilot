// apps/web/src/app/api/application-pitches/[jobId]/route.ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { listPitches } from "../../../../lib/applicationPitch/listPitches";
import { loadResearchForJob } from "../../../../lib/applicationPitch/loadResearchForJob";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const body = await withUserContext(db, env.DEFAULT_USER_ID, async (tx) => ({
      versions: await listPitches(tx, jobId),
      research: await loadResearchForJob(tx, jobId),
    }));
    return NextResponse.json(body);
  } finally {
    await closeDbClient(db);
  }
}
