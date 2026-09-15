import { NextResponse } from "next/server";
import { loadEnv } from "@ai-career/config";
import { formatValidationError } from "../../../../lib/formatValidationError";
import { ConfirmCareerGoalSchema } from "../../../../lib/career-goal/careerGoalConstraintsSchema";
import { confirmCareerGoal, CareerGoalNotFoundError } from "../../../../lib/career-goal/saveCareerGoal";

export async function POST(request: Request) {
  const env = loadEnv();
  const body = await request.json();
  const parsed = ConfirmCareerGoalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatValidationError(parsed.error) }, { status: 400 });
  }

  try {
    await confirmCareerGoal(env, parsed.data.goalId, parsed.data.constraints);
  } catch (error) {
    if (error instanceof CareerGoalNotFoundError) {
      return NextResponse.json({ error: "Career goal not found" }, { status: 404 });
    }
    throw error;
  }

  return NextResponse.json({ status: "confirmed" });
}
