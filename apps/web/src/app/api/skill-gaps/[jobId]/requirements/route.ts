import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, schema, withUserContext } from "@ai-career/db";
import { AiBudgetExceededError, createAnthropicFor } from "@ai-career/ai";
import { ensureJobRequirements, JobRequirementExtractionValidationError } from "@ai-career/resume-optimization";
import { loadJobSkillGaps } from "../../../../../lib/skillGaps/loadSkillGaps";
import { createUsageSink } from "../../../../../lib/aiUsage/createUsageSink";
import { budgetExceededResponse } from "../../../../../lib/aiUsage/budgetResponse";
import { withRouteErrors } from "../../../../../lib/http/withRouteErrors";
import { withRateLimit } from "../../../../../lib/http/rateLimit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "Job not found" }, { status: 404 });

/** Phase 13b: "Check requirements" for one job -- the same cached extraction the resume optimizer uses. */
async function handlePOST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return notFound();
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const inUserContext = <T>(fn: (tx: typeof db) => Promise<T>) => withUserContext(db, env.DEFAULT_USER_ID, fn);
    const [job] = await inUserContext((tx) =>
      tx.select({ id: schema.jobs.id, title: schema.jobs.title, descriptionText: schema.jobs.descriptionText, descriptionHash: schema.jobs.descriptionHash })
        .from(schema.jobMatches).innerJoin(schema.jobs, eq(schema.jobMatches.jobId, schema.jobs.id))
        .where(eq(schema.jobMatches.jobId, jobId)).limit(1));
    if (!job) return notFound();
    const anthropicFor = createAnthropicFor(env, createUsageSink(db, env));
    await inUserContext((tx) => ensureJobRequirements(tx, env, anthropicFor("job_requirements_extraction"), job));
    const view = await inUserContext((tx) => loadJobSkillGaps(tx, jobId));
    return view ? NextResponse.json(view) : notFound();
  } catch (error) {
    if (error instanceof AiBudgetExceededError) return budgetExceededResponse(error);
    if (error instanceof Anthropic.APIError || error instanceof JobRequirementExtractionValidationError) {
      return NextResponse.json({ error: "Could not check this job's requirements. Try again." }, { status: 502 });
    }
    throw error;
  } finally {
    await closeDbClient(db);
  }
}

export const POST = withRouteErrors("/api/skill-gaps/[jobId]/requirements", withRateLimit("ai", "/api/skill-gaps/[jobId]/requirements", handlePOST));
