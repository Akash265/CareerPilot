import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { createDbClient, closeDbClient, withUserContext } from "@ai-career/db";
import { getCareerGoalState } from "../../../lib/career-goal/serializeCareerGoal";

export async function GET() {
  const env = loadEnv();
  const db = createDbClient(env);
  try {
    const state = await withUserContext(db, env.DEFAULT_USER_ID, (tx) => getCareerGoalState(tx));
    return NextResponse.json(state);
  } finally {
    await closeDbClient(db);
  }
}
