// apps/web/src/app/api/resume-optimizations/[jobId]/run/route.ts
import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient } from "@ai-career/db";
import { createAnthropicClient } from "@ai-career/ai";
import { runResumeOptimization, ResumeOptimizationError } from "@ai-career/resume-optimization";
import { toOptimizationView } from "../../../../../lib/resumeOptimization/serializeOptimization";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const result = await runResumeOptimization(db, {
      userId: env.DEFAULT_USER_ID,
      jobId,
      anthropicClient: createAnthropicClient(env),
      env,
    });
    return NextResponse.json({ optimization: toOptimizationView(result.optimization, result.evaluation) }, { status: 201 });
  } catch (error) {
    if (error instanceof ResumeOptimizationError) {
      if (error.errorClass === "no_match") return NextResponse.json({ error: 'Run "Find Matches" for this job first' }, { status: 404 });
      if (error.errorClass === "not_eligible") return NextResponse.json({ error: "This job is not an eligible match" }, { status: 400 });
      if (error.errorClass === "no_active_goal") return NextResponse.json({ error: "Confirm a career goal first" }, { status: 409 });
      return NextResponse.json({ error: "Resume optimization failed. Try again." }, { status: 502 });
    }
    throw error;
  } finally {
    await closeDbClient(db);
  }
}
