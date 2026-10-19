import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { closeDbClient, createDbClient, withUserContext } from "@ai-career/db";
import { loadSkillGapsOverview } from "../../../lib/skillGaps/loadSkillGaps";
import { withRouteErrors } from "../../../lib/http/withRouteErrors";

/** Phase 13b: the /skills page -- unanswered required skills across the top matches, and every answer given. */
async function handleGET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    return NextResponse.json(await withUserContext(db, env.DEFAULT_USER_ID, (tx) => loadSkillGapsOverview(tx, env.SKILL_GAP_TOP_N)));
  } finally {
    await closeDbClient(db);
  }
}

export const GET = withRouteErrors("/api/skill-gaps", handleGET);
