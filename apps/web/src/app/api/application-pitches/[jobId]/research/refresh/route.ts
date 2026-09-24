// apps/web/src/app/api/application-pitches/[jobId]/research/refresh/route.ts
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { createAnthropicClient } from "@ai-career/ai";
import { ensureCompanyResearch, CompanyResearchRefreshFailedError } from "@ai-career/application-package";
import { toResearchView } from "../../../../../../lib/applicationPitch/serializePitch";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const { jobs } = schema;

export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const [job] = await withUserContext(db, env.DEFAULT_USER_ID, (tx) =>
      tx
        .select({ id: jobs.id, companyKey: jobs.companyKey, companyName: jobs.companyName, title: jobs.title })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
    );
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

    const research = await ensureCompanyResearch(db, env.DEFAULT_USER_ID, createAnthropicClient(env), env, job, { forceRefresh: true });
    return NextResponse.json({ research: toResearchView(research) });
  } catch (error) {
    if (error instanceof CompanyResearchRefreshFailedError) {
      return NextResponse.json({ error: "Research refresh failed; your existing research was kept." }, { status: 502 });
    }
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
